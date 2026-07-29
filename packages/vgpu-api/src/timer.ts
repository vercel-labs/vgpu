import type { Device } from "@vgpu/core";
import { timerCapacityError, timerInvalidError } from "./errors.ts";
import { FRAME_PASS_ATTACHMENT, type FramePassAttachContext, type FramePassAttachment, type FramePassAttachResult } from "./frame-protocols.ts";
import type { Gpu } from "./kernel.ts";
import { liveKernel, ownQueryFeature } from "./live-kernel.ts";
import { createQueryRing, type QueryHostOptions, type QueryRing } from "./query-ring.ts";

/**
 * Marks one frame pass for GPU timing. Create with `timer.span(name)` and pass it
 * as `FramePassOptions.timer`; the pass's GPU duration is reported under `name`
 * through `timer.onResults`.
 */
export interface TimerSpan {
  readonly name: string;
}

/** GPU pass timer created by `timer(gpu)`. Needs the "timestamp-query" device feature. */
export interface Timer {
  /** Marks a pass for timing. Pass the result as FramePassOptions.timer. One name per frame. */
  span(name: string): TimerSpan;
  /** Registers a callback invoked whenever a new set of results lands (typically 1-2 frames after submit). Times in milliseconds. Returns an unsubscribe function. */
  onResults(cb: (spans: Readonly<Record<string, number>>) => void): () => void;
  /** Releases the timer's query set and buffers. Further use of the timer or its spans throws. */
  dispose(): void;
}

/** Initial capacity in spans; each span writes a begin/end timestamp pair (2 queries). */
const INITIAL_SPAN_CAPACITY = 32;
/** WebGPU createQuerySet: "descriptor.count must be ≤ 4096" — a fixed constant, so at most 2048 begin/end pairs. */
const MAX_QUERIES = 4096;
const MAX_SPANS_PER_FRAME = MAX_QUERIES / 2;
const MS_PER_NS = 1 / 1_000_000;
class InternalTimerSpan implements TimerSpan, FramePassAttachment {
  constructor(readonly name: string, readonly owner: InternalTimer) {}

  /**
   * Frame pass attachment: registering the span is what returns the descriptor's `timestampWrites`
   * (undefined when the span is dropped this frame because the query set is full). The owner is the
   * timer, not the span, so a frame that attaches two spans of the same timer bookkeeps one owner.
   */
  [FRAME_PASS_ATTACHMENT](ctx: FramePassAttachContext): FramePassAttachResult {
    return { owner: this.owner, timestampWrites: this.owner.attachSpan(this, ctx.frame, ctx.device) };
  }
}

/** @internal The concrete span, for tests that need the internal shape behind the TimerSpan handle. */
export type { InternalTimerSpan };

/** @internal */
export function createTimer(device: Device, host: QueryHostOptions = {}): Timer {
  return new InternalTimer(device, host);
}

/**
 * GPU pass timing for this gpu. Needs the "timestamp-query" device feature — request it at init:
 * `init({ requiredFeatures: ["timestamp-query"] })`.
 *
 * The timer owns a query ring: its readbacks join `gpu.settled()`, a dropped readback is reported
 * on `gpu.onError`, and `gpu.dispose()` releases the query set (deferring destruction while a frame
 * in flight still references it). `timer.dispose()` releases it earlier and drops the registration.
 */
export function timer(gpu: Gpu): Timer {
  const kernel = liveKernel(gpu, "timer");
  return ownQueryFeature(kernel, (host) => new InternalTimer(kernel.device, host));
}

interface FrameSpan {
  readonly name: string;
  readonly begin: number;
}

/**
 * Ring-1 GPU pass timer. Owns name→span bookkeeping per frame, contiguous
 * begin/end index pair allocation, ns→ms conversion, and onResults dispatch;
 * the query set + resolve/readback plumbing lives in the shared query ring.
 *
 * @internal
 */
export class InternalTimer {
  readonly #device: Device;
  readonly #host: QueryHostOptions;
  readonly #spans = new Map<string, InternalTimerSpan>();
  readonly #listeners = new Set<(spans: Readonly<Record<string, number>>) => void>();
  #ring: QueryRing;
  #capacity = INITIAL_SPAN_CAPACITY * 2;
  /** High-water query demand; capacity grows to cover it at the next frame boundary. */
  #demand = INITIAL_SPAN_CAPACITY * 2;
  #frame: unknown;
  #frameSpans: FrameSpan[] = [];
  readonly #frameNames = new Set<string>();
  #usedQueries = 0;
  #encodedSpans?: readonly FrameSpan[];
  #resultSeq = 0;
  #appliedSeq = -1;
  /**
   * One retain per open frame whose pass descriptors reference a ring's query set, keyed by frame
   * identity and remembering *which* ring it pinned (capacity growth swaps the ring mid-life).
   * Released only when that frame reports back — submitted, failed or abandoned — because nothing
   * else proves the frame's encoder is done with the query set: age does not (a Frame held for many
   * frames can still be submitted), so a Frame the caller drops without submit() keeps its retain
   * until gpu.dispose() or device loss, exactly like a native GPUCommandEncoder that never finishes.
   */
  readonly #frameRetains = new Map<unknown, QueryRing>();
  #disposed = false;

  constructor(device: Device, host: QueryHostOptions = {}) {
    // Mirrors WebGPU "Validate timestampWrites": '"timestamp-query" must be enabled for device' — and
    // createQuerySet would throw a TypeError for a timestamp set without it. Fail at creation instead.
    if (!device.features.has("timestamp-query")) {
      throw timerInvalidError(
        `timer(gpu) needs the "timestamp-query" device feature — request it at init: init({ requiredFeatures: ["timestamp-query"] }).`,
        `Pass init({ requiredFeatures: ["timestamp-query"] }) on an adapter that supports it; gate optional timing on gpu.device.features.has("timestamp-query").`,
      );
    }
    this.#device = device;
    this.#host = host;
    this.#ring = this.#createRing();
  }

  span(name: string): TimerSpan {
    this.#assertUsable("Timer.span");
    if (typeof name !== "string" || name.length === 0) {
      throw timerInvalidError(`span name received ${previewName(name)}; expected a non-empty string.`, `Name each timed pass, e.g. timer.span("shadows").`, "Timer.span");
    }
    let span = this.#spans.get(name);
    if (!span) {
      span = new InternalTimerSpan(name, this);
      this.#spans.set(name, span);
    }
    return span;
  }

  onResults(cb: (spans: Readonly<Record<string, number>>) => void): () => void {
    this.#assertUsable("Timer.onResults");
    this.#listeners.add(cb);
    return () => { this.#listeners.delete(cb); };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#spans.clear();
    this.#frameNames.clear();
    this.#frameSpans = [];
    this.#encodedSpans = undefined;
    // The ring defers its destruction while the current frame still references the query set from a
    // pass descriptor (released at frameSubmitted or at the next frame boundary).
    this.#ring.dispose();
    this.#host.onDispose?.();
  }

  /**
   * @internal Frame.pass hook: registers the span for the current frame and returns the pass
   * descriptor's timestampWrites, or undefined when the span is dropped for this frame because
   * the query set is full (capacity grows at the next frame boundary — never mid-frame, since
   * earlier passes already reference the current set).
   */
  attachSpan(span: InternalTimerSpan, frame: unknown, frameDevice: Device): GPURenderPassTimestampWrites | undefined {
    this.#assertUsable("Frame.pass");
    if (frameDevice !== this.#device) {
      throw timerInvalidError(`span '${span.name}' belongs to a timer created on a different gpu; timestamp queries cannot cross devices.`, "Create one timer(gpu) per gpu and use its spans only with that gpu's frames.", "Frame.pass");
    }
    if (frame !== this.#frame) this.#beginFrame(frame);
    if (this.#frameNames.has(span.name)) {
      throw timerInvalidError(`duplicate span '${span.name}' in one frame; each result key holds a single begin/end pair per frame.`, `Use one timer.span(name) per pass per frame, e.g. timer.span("${span.name}-2") for the second pass.`, "Frame.pass");
    }
    if (this.#frameNames.size >= MAX_SPANS_PER_FRAME) {
      throw timerCapacityError(MAX_SPANS_PER_FRAME, MAX_QUERIES);
    }
    this.#frameNames.add(span.name);
    const begin = this.#frameNames.size * 2 - 2;
    if (this.#demand < begin + 2) this.#demand = begin + 2;
    // Mirrors WebGPU "Validate timestampWrites": each provided index must be < querySet.count.
    if (begin + 2 > this.#ring.capacity) return undefined;
    this.#usedQueries = begin + 2;
    this.#frameSpans.push({ name: span.name, begin });
    // The descriptor now references the ring's query set for the rest of the frame: keep the ring alive
    // even if dispose() lands mid-frame (destroying a referenced set would invalidate the pass).
    // The retain is per frame, so a second frame opened while this one is still unsubmitted cannot
    // release it — both keep the set alive until each of them is submitted or abandoned.
    this.#retainRing(frame);
    // "Of the write index members ... at least one must be provided ... no two may be equal": begin/end pairs are distinct by construction.
    return { querySet: this.#ring.querySet, beginningOfPassWriteIndex: begin, endOfPassWriteIndex: begin + 1 };
  }

  /** @internal Frame.submit hook, before encoder.finish(): appends this frame's single resolve to the frame encoder. */
  finalizeFrame(frame: unknown, encoder: GPUCommandEncoder): void {
    this.#encodedSpans = undefined;
    if (this.#disposed || frame !== this.#frame || this.#usedQueries === 0) return;
    if (this.#ring.encodeResolve(encoder, this.#usedQueries)) this.#encodedSpans = [...this.#frameSpans];
  }

  /** @internal Frame.submit hook, after queue.submit succeeds: starts the non-blocking readback. */
  frameSubmitted(frame: unknown): void {
    // Release *this* frame's retain first, whichever ring it pinned: the command buffer is submitted
    // (or the frame was abandoned), so nothing it encoded references that query set anymore, and a
    // dispose() that landed mid-frame can now destroy the ring. Runs before the identity check so a
    // frame that is no longer the current one — another frame was opened meanwhile — still releases.
    this.#releaseRing(frame);
    // Results stay identity-scoped: only the current frame's encoded resolve is read back.
    if (frame !== this.#frame) return;
    if (this.#disposed) return;
    const spans = this.#encodedSpans;
    this.#encodedSpans = undefined;
    if (!spans || spans.length === 0) return;
    const seq = this.#resultSeq;
    this.#resultSeq += 1;
    this.#ring.onSubmitted((values) => {
      // The ring orders its own readbacks; this guard extends the ordering across ring recreations (capacity growth).
      if (seq <= this.#appliedSeq) return;
      this.#appliedSeq = seq;
      this.#dispatch(spans, values);
    });
  }

  /**
   * @internal Frame abandon hook (a failed pass, a failed finish/submit, or Frame.cancel()): the
   * frame ends without ever reaching the queue. Drops the pending encoded state so no readback can
   * decode stale staging bytes as a phantom duration, and releases the retain this frame took when
   * it attached a span — the counterpart of frameSubmitted() for frames that never submit.
   */
  frameAbandoned(frame: unknown): void {
    if (frame === this.#frame) this.#encodedSpans = undefined;
    this.#releaseRing(frame);
  }

  #beginFrame(frame: unknown): void {
    if (this.#demand > this.#ring.capacity) {
      // Grow only at frame boundaries. The retired ring keeps applying its in-flight readbacks
      // before releasing its resources, so growth never drops results already submitted.
      this.#ring.dispose();
      this.#capacity = Math.min(MAX_QUERIES, nextPowerOfTwo(this.#demand));
      this.#ring = this.#createRing();
    }
    this.#demand = this.#capacity;
    this.#frame = frame;
    this.#frameSpans = [];
    this.#frameNames.clear();
    this.#usedQueries = 0;
  }

  #dispatch(spans: readonly FrameSpan[], values: BigUint64Array): void {
    const results: Record<string, number> = {};
    for (const { name, begin } of spans) {
      const start = values[begin] ?? 0n;
      const end = values[begin + 1] ?? 0n;
      // Timestamps are implementation-defined ns ticks and the counter may reset between writes
      // ("unexpected values such as negative deltas ... can safely be discarded"): clamp negatives to 0.
      results[name] = end > start ? Number(end - start) * MS_PER_NS : 0;
    }
    const frozen = Object.freeze(results);
    for (const listener of [...this.#listeners]) {
      try { listener(frozen); }
      catch (error) { console.error(error); }
    }
  }

  #retainRing(frame: unknown): void {
    if (this.#frameRetains.has(frame)) return;
    this.#frameRetains.set(frame, this.#ring);
    this.#ring.retain();
  }

  #releaseRing(frame: unknown): void {
    const ring = this.#frameRetains.get(frame);
    if (!ring) return;
    this.#frameRetains.delete(frame);
    ring.release();
  }

  #createRing(): QueryRing {
    return createQueryRing(this.#device, { type: "timestamp", capacity: this.#capacity, label: "vgpu.timer", trackSettled: this.#host.trackSettled, errorSink: this.#host.errorSink });
  }

  #assertUsable(where: string): void {
    if (this.#disposed) throw timerInvalidError("the timer is disposed.", "Create a new timer with timer(gpu).", where);
  }
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function previewName(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}
