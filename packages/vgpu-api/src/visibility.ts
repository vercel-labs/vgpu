import type { Device } from "@vgpu/core";
import { queryDuplicateError, visibilityCapacityError, visibilityCapacityLimitError, visibilityDisposedError, visibilityInvalidError, visibilityLabelDuplicateError, visibilityNoDepthError } from "./errors.ts";
import { FRAME_PASS_ATTACHMENT, type FramePassAttachContext, type FramePassAttachment, type FramePassAttachResult } from "./frame-protocols.ts";
import { frameState } from "./frame-state.ts";
import type { Gpu } from "./kernel.ts";
import { liveKernel, ownQueryFeature } from "./live-kernel.ts";
import { createQueryRing, type QueryHostOptions, type QueryRing } from "./query-ring.ts";

export interface VisibilityOptions {
  /** Query slots. Max 4096 (WebGPU fixed limit). Default 64. */
  readonly capacity?: number;
}

/** Latched result state of a visibility query: `"hidden"` only after a completed query confirmed zero passing samples. */
export type VisibilityState = "visible" | "hidden" | "unknown";

/**
 * Occlusion query results for visibility culling, created by `visibility(gpu)`.
 * Core WebGPU — no device feature required. Pass the instance as
 * `FramePassOptions.visibility`, wrap proxy draws in `pass.occlusion(handle, body)`,
 * and condition real draws on `handle.hidden`.
 */
export interface Visibility {
  /** Stable handle, created once outside the loop. Duplicate label → VGPU-VIS-LABEL-DUPLICATE. */
  query(label: string): VisibilityQuery;
  /** Camera cut / teleport: all results become "unknown". */
  reset(): void;
  dispose(): void;
}

export interface VisibilityQuery {
  readonly label: string;
  /** true ONLY when a completed query confirmed zero passing samples (and no reset since). "unknown" and "visible" are false: the safe default is to draw. Stable for the duration of a frame. */
  readonly hidden: boolean;
  readonly state: "visible" | "hidden" | "unknown";
  /** Frames since the last applied result; Infinity if none yet. */
  readonly age: number;
  reset(): void;
  dispose(): void;   // recycles the slot once no in-flight readbacks reference it
}

/** WebGPU createQuerySet: "descriptor.count must be ≤ 4096" — a fixed constant, not a device limit. */
const MAX_QUERIES = 4096;
const DEFAULT_CAPACITY = 64;
/** @internal */
export function createVisibility(device: Device, options: VisibilityOptions = {}, frameCounter: () => number = () => 0, host: QueryHostOptions = {}): Visibility {
  return new InternalVisibility(device, options, frameCounter, host);
}

/**
 * Occlusion query results for visibility culling. Core WebGPU — no device feature required. Pass the
 * instance as `FramePassOptions.visibility`, wrap proxy draws in `pass.occlusion(handle, body)` and
 * condition the real draw on `handle.hidden`.
 *
 * `VisibilityQuery.age` counts frames through the kernel's frame state, which is created on demand:
 * a program that never opens a frame keeps reading age `Infinity` instead of paying for the clock.
 * The instance goes down with `gpu.dispose()` (resource phase) or earlier with `visibility.dispose()`.
 */
export function visibility(gpu: Gpu, options: VisibilityOptions = {}): Visibility {
  const kernel = liveKernel(gpu, "visibility");
  return ownQueryFeature(kernel, (host) => new InternalVisibility(kernel.device, options, () => frameState(kernel).frameCount, host));
}

class InternalVisibilityQuery implements VisibilityQuery {
  #state: VisibilityState = "unknown";
  /** clock(gpu).frameCount stamped when the last result applied; age = frameCount - stamp. */
  #resultFrame?: number;
  /** Reset generation: results captured before a reset() carry a stale generation and are discarded at apply. */
  #generation = 0;
  #disposed = false;

  constructor(readonly label: string, readonly owner: InternalVisibility) {}

  get hidden(): boolean { return this.#state === "hidden"; }
  get state(): VisibilityState { return this.#state; }
  get age(): number { return this.#resultFrame === undefined ? Infinity : this.owner.currentFrame() - this.#resultFrame; }

  reset(): void {
    if (this.#disposed) throw visibilityDisposedError("query handle", "VisibilityQuery.reset");
    this.#state = "unknown";
    this.#resultFrame = undefined;
    // In-flight readbacks from pre-reset frames captured the previous generation; apply discards them.
    this.#generation += 1;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#state = "unknown";
    this.#resultFrame = undefined;
    this.owner.releaseLabel(this);
  }

  /** @internal */
  get disposed(): boolean { return this.#disposed; }
  /** @internal Generation captured at slot allocation; results only apply when it still matches. */
  get generation(): number { return this.#generation; }

  /** @internal Called from the ring's apply closure, async between frames — the only state write besides reset(). */
  applyResult(value: bigint, generation: number, frame: number): void {
    if (this.#disposed || generation !== this.#generation) return;
    // WebGPU occlusion semantics are zero vs non-zero ONLY: "a value of 0 indicates that no samples passed;
    // any other value is unspecified". Never expose the value as a count.
    this.#state = value !== 0n ? "visible" : "hidden";
    this.#resultFrame = frame;
  }
}

interface FrameEntry {
  readonly query: InternalVisibilityQuery;
  readonly generation: number;
}

/**
 * Ring-1 occlusion query facade. Owns label→handle bookkeeping, contiguous
 * per-frame slot allocation (slot order = allocation order, reset each frame),
 * and result latching into handles; the query set + resolve/readback plumbing
 * lives in the shared query ring. Capacity is a declared contract — the query
 * set is bound to pass descriptors mid-frame, so it never grows.
 *
 * @internal
 */
export class InternalVisibility {
  readonly #device: Device;
  readonly #frameCounter: () => number;
  readonly #host: QueryHostOptions;
  readonly #ring: QueryRing;
  readonly capacity: number;
  /** Live (not disposed) handles by label. */
  readonly #queries = new Map<string, InternalVisibilityQuery>();
  #frame: unknown;
  #frameEntries: FrameEntry[] = [];
  readonly #frameUsed = new Set<InternalVisibilityQuery>();
  #encodedEntries?: readonly FrameEntry[];
  /**
   * One retain per open frame whose pass descriptors reference the ring's query set, keyed by frame
   * identity. Released only when that frame reports back — submitted, failed or abandoned — because
   * nothing else proves the frame's encoder is done with the query set: age does not (a Frame held
   * for many frames can still be submitted), so a Frame the caller drops without submit() keeps its
   * retain until gpu.dispose() or device loss, like a native encoder that never finishes.
   */
  readonly #frameRetains = new Map<unknown, QueryRing>();
  #disposed = false;

  constructor(device: Device, options: VisibilityOptions, frameCounter: () => number, host: QueryHostOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_QUERIES) {
      throw visibilityCapacityLimitError(capacity, MAX_QUERIES);
    }
    this.#device = device;
    this.#frameCounter = frameCounter;
    this.#host = host;
    this.capacity = capacity;
    this.#ring = createQueryRing(device, { type: "occlusion", capacity, label: "vgpu.visibility", trackSettled: host.trackSettled, errorSink: host.errorSink });
  }

  query(label: string): VisibilityQuery {
    this.#assertUsable("Visibility.query");
    if (typeof label !== "string" || label.length === 0) {
      throw visibilityInvalidError(`query label received ${previewLabel(label)}; expected a non-empty string.`, `Label each queried object, e.g. vis.query("statue").`, "Visibility.query");
    }
    if (this.#queries.has(label)) throw visibilityLabelDuplicateError(label);
    const query = new InternalVisibilityQuery(label, this);
    this.#queries.set(label, query);
    return query;
  }

  reset(): void {
    this.#assertUsable("Visibility.reset");
    for (const query of this.#queries.values()) query.reset();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#queries.clear();
    this.#frameEntries = [];
    this.#frameUsed.clear();
    this.#encodedEntries = undefined;
    // The ring defers its destruction while the current frame still references the query set from a
    // pass descriptor (released at frameSubmitted or at the next frame boundary).
    this.#ring.dispose();
    this.#host.onDispose?.();
  }

  /** @internal */
  get disposed(): boolean { return this.#disposed; }
  /** @internal */
  currentFrame(): number { return this.#frameCounter(); }

  /**
   * @internal Label-reuse rule: a disposed handle's label is freed immediately. This is safe
   * because in-flight readbacks resolve results through handle *object references* captured
   * per frame — never by label lookup — and a disposed handle's applyResult is a no-op, so a
   * new same-label handle can never observe the old handle's stale results.
   */
  releaseLabel(query: InternalVisibilityQuery): void {
    if (this.#queries.get(query.label) === query) this.#queries.delete(query.label);
  }

  /** @internal Pass descriptor's occlusionQuerySet: one "occlusion"-type set owned by the shared ring. */
  get querySet(): GPUQuerySet { return this.#ring.querySet; }

  /**
   * Frame pass attachment: validates that the pass can host occlusion queries at all, joins the
   * frame's bookkeeping and hands back the query source `FramePass.occlusion()` allocates from.
   *
   * The depth check lives here, not in the frame: without depth testing an occlusion query passes
   * for anything rasterized, so it always reports "visible" — useless for culling, and only this
   * attachment knows that rule.
   */
  [FRAME_PASS_ATTACHMENT](ctx: FramePassAttachContext): FramePassAttachResult {
    if (!ctx.target.depth) throw visibilityNoDepthError();
    this.attachFrame(ctx.frame, ctx.device);
    return {
      owner: this,
      occlusion: { querySet: this.querySet, beginQuery: (query, frame) => this.beginQuery(query as VisibilityQuery, frame) },
    };
  }

  /** @internal Frame.pass hook: validates the gpu match and (re)starts per-frame slot allocation. */
  attachFrame(frame: unknown, frameDevice: Device): void {
    this.#assertUsable("Frame.pass");
    if (frameDevice !== this.#device) {
      throw visibilityInvalidError("the visibility instance belongs to a different gpu; occlusion queries cannot cross devices.", "Create one visibility(gpu) per gpu and use it only with that gpu's frames.", "Frame.pass");
    }
    if (frame !== this.#frame) this.#beginFrame(frame);
    // The pass descriptor's occlusionQuerySet references the ring's query set for the rest of the frame:
    // keep the ring alive even if dispose() lands mid-frame. The retain is per frame, so a second
    // frame opened while this one is still unsubmitted cannot release it — both keep the set alive
    // until each of them is submitted or abandoned.
    this.#retainRing(frame);
  }

  /** @internal FramePass.occlusion hook: validates the handle and allocates this frame's next contiguous slot. */
  beginQuery(query: VisibilityQuery, frame: unknown): number {
    this.#assertUsable("FramePass.occlusion");
    if (!(query instanceof InternalVisibilityQuery)) {
      throw visibilityInvalidError(`occlusion() received ${previewLabel(query)}; expected a VisibilityQuery from vis.query(label).`, `Create const q = vis.query("label") once from the pass's visibility instance, then p.occlusion(q, body).`, "FramePass.occlusion");
    }
    if (query.owner !== this) {
      throw visibilityInvalidError(`query '${query.label}' belongs to a different visibility instance than the one this pass was opened with.`, "Use handles from the same visibility(gpu) instance passed as the pass's visibility option.", "FramePass.occlusion");
    }
    if (query.disposed) throw visibilityDisposedError("query handle", "FramePass.occlusion");
    if (frame !== this.#frame) {
      throw visibilityInvalidError("the pass is not part of the current frame; occlusion() must run inside the frame that opened the pass.", "Encode occlusion scopes inside the pass callback of the current frame(gpu).", "FramePass.occlusion");
    }
    // Duplicate use is forbidden across passes too: cross-pass reuse of a query index silently
    // overwrites the earlier result in native WebGPU, so vgpu rejects it up front.
    if (this.#frameUsed.has(query)) throw queryDuplicateError(query.label);
    const index = this.#frameEntries.length;
    if (index >= this.capacity) throw visibilityCapacityError(this.capacity);
    this.#frameUsed.add(query);
    this.#frameEntries.push({ query, generation: query.generation });
    return index;
  }

  /** @internal Frame.submit hook, before encoder.finish(): appends this frame's single resolve to the frame encoder. */
  finalizeFrame(frame: unknown, encoder: GPUCommandEncoder): void {
    this.#encodedEntries = undefined;
    if (this.#disposed || frame !== this.#frame || this.#frameEntries.length === 0) return;
    if (this.#ring.encodeResolve(encoder, this.#frameEntries.length)) this.#encodedEntries = [...this.#frameEntries];
  }

  /** @internal Frame.submit hook, after queue.submit succeeds: starts the non-blocking readback. */
  frameSubmitted(frame: unknown): void {
    // Release *this* frame's retain first: the command buffer is submitted (or the frame was
    // abandoned), so nothing it encoded references the query set anymore, and a dispose() that
    // landed mid-frame can now destroy the ring. Runs before the identity check so a frame that is
    // no longer the current one — another frame was opened meanwhile — still releases.
    this.#releaseRing(frame);
    // Results stay identity-scoped: only the current frame's encoded resolve is read back.
    if (frame !== this.#frame) return;
    if (this.#disposed) return;
    const entries = this.#encodedEntries;
    this.#encodedEntries = undefined;
    if (!entries || entries.length === 0) return;
    this.#ring.onSubmitted((values) => {
      // Latch contract: handle state only changes here (async, between frames) and via reset(),
      // so reads during a frame callback are stable. The ring already applies readbacks in order.
      if (this.#disposed) return;
      const frameStamp = this.#frameCounter();
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        const value = values[index];
        // hidden must be *confirmed* zero: a missing value never downgrades to "hidden".
        if (value !== undefined) entry.query.applyResult(value, entry.generation, frameStamp);
      }
    });
  }

  /**
   * @internal Frame abandon hook (a failed pass, a failed finish/submit, or Frame.cancel()): the
   * frame ends without ever reaching the queue. Drops the pending encoded state so no readback can
   * decode stale staging bytes as a phantom "hidden", and releases the retain this frame took when
   * it opened a visibility pass — the counterpart of frameSubmitted() for frames that never submit.
   */
  frameAbandoned(frame: unknown): void {
    if (frame === this.#frame) this.#encodedEntries = undefined;
    this.#releaseRing(frame);
  }

  #beginFrame(frame: unknown): void {
    this.#frame = frame;
    this.#frameEntries = [];
    this.#frameUsed.clear();
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

  #assertUsable(where: string): void {
    if (this.#disposed) throw visibilityDisposedError("visibility", where);
  }
}

function previewLabel(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}
