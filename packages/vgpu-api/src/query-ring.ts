import type { Buffer, Device } from "@vgpu/core";
import { queryReadbackError } from "./errors.ts";
import type { ErrorSink } from "./pipeline-store.ts";

/**
 * Bytes each resolved query occupies: WebGPU resolveQuerySet writes each result
 * "into a GPUBuffer ... as a 64-bit unsigned integer" (8 bytes per query).
 *
 * @internal
 */
export const QUERY_RESULT_BYTES = 8;

/** GPUMapMode.READ; numeric fallback covers headless/mock runtimes without the global. */
const MAP_READ = (globalThis.GPUMapMode?.READ ?? 1) as GPUMapModeFlags;

/**
 * Options for the internal query resolve/readback ring shared by query-based
 * features (timer today, occlusion queries next).
 *
 * @internal
 */
export interface QueryRingOptions {
  /** GPUQuerySetDescriptor.type — "timestamp" for pass timing, "occlusion" for occlusion queries. */
  readonly type: GPUQueryType;
  /** Query count of the owned GPUQuerySet. WebGPU createQuerySet requires "descriptor.count must be ≤ 4096". */
  readonly capacity: number;
  readonly label?: string;
  /** Staging buffers rotated per resolve (frames in flight + 1). Defaults to 3. */
  readonly depth?: number;
  /** Registers each pending readback so gpu.settled() covers in-flight maps. */
  readonly trackSettled?: (promise: Promise<unknown>) => void;
  /**
   * Reports a failed readback (device loss, a rejected mapAsync, an unmap that throws) through the
   * package's error channel — gpu.onError. The ring itself stays non-throwing: a failed readback is
   * dropped, never surfaced as a rejected frame. Defaults to console.error.
   */
  readonly errorSink?: ErrorSink;
}

/**
 * Host hooks shared by the query-based features built on the ring (timer(gpu), visibility(gpu)).
 *
 * @internal
 */
export interface QueryHostOptions {
  /** Registers each pending readback so gpu.settled() covers in-flight maps. */
  readonly trackSettled?: (promise: Promise<unknown>) => void;
  /** Error channel for dropped readbacks (gpu.onError). */
  readonly errorSink?: ErrorSink;
  /** Called from the feature's dispose() so the owning gpu can drop its tracking reference. */
  readonly onDispose?: () => void;
}

/**
 * Internal ownership boundary for query readback plumbing. The ring knows nothing
 * about span names, frames, or timers — it owns the GPUQuerySet, one resolve buffer
 * (usage query_resolve|copy_src), and `depth` parity-rotated staging buffers
 * (usage map_read|copy_dst), and turns "resolve the used range, then read it back
 * without ever blocking" into two calls that bracket a queue submission.
 *
 * @internal
 */
export interface QueryRing {
  readonly querySet: GPUQuerySet;
  /** Query capacity of the owned set (immutable; consumers recreate the ring to grow). */
  readonly capacity: number;
  /**
   * Appends one resolveQuerySet of the contiguous used range [0, usedCount) plus a
   * copyBufferToBuffer into the next staging buffer to an encoder that is about to be
   * finished and submitted. Returns false — encoding nothing — when usedCount is 0 or
   * the next staging buffer is still map-pending: the readback is dropped, never blocked on.
   */
  encodeResolve(encoder: GPUCommandEncoder, usedCount: number): boolean;
  /**
   * Call after the encoder from the last successful encodeResolve was submitted: starts the
   * non-blocking mapAsync readback. `apply` receives the decoded u64 values (one per resolved
   * query); readbacks apply in order — a stale readback that lands after a newer one already
   * applied is discarded. No-op when the preceding encodeResolve returned false.
   */
  onSubmitted(apply: (values: BigUint64Array) => void): void;
  /**
   * Pins the GPU resources while a frame in flight references `querySet` from a pass descriptor:
   * `dispose()` then defers destruction until the matching `release()`. Consumers retain once per
   * frame that binds the set and release when that frame is submitted (or abandoned), so a
   * mid-frame `dispose()` can never destroy a query set the current frame still points at.
   */
  retain(): void;
  /** Balances one retain(); performs a deferred destruction when the ring is disposed and idle. */
  release(): void;
  /**
   * Stops new encodes/readbacks. In-flight readbacks still decode and apply (so results are
   * not lost when a consumer retires a ring to grow capacity); GPU resources are destroyed
   * once the last in-flight map settles and the last frame retain is released.
   */
  dispose(): void;
}

/** @internal */
export function createQueryRing(device: Device, options: QueryRingOptions): QueryRing {
  return new InternalQueryRing(device, options);
}

interface StagingSlot {
  readonly buffer: Buffer;
  mapPending: boolean;
  /**
   * Set when the buffer may still be mapped after a failed readback (getMappedRange threw and the
   * best-effort unmap failed too). A copyBufferToBuffer into a mapped buffer is a validation error
   * — "the destination buffer must be unmapped" — so the slot is rotated past, permanently.
   */
  retired: boolean;
}

interface PendingEncode {
  readonly staging: StagingSlot;
  readonly usedCount: number;
  readonly seq: number;
}

class InternalQueryRing implements QueryRing {
  readonly querySet: GPUQuerySet;
  readonly capacity: number;
  readonly #label: string;
  readonly #resolve: Buffer;
  readonly #stagings: readonly StagingSlot[];
  readonly #trackSettled?: (promise: Promise<unknown>) => void;
  readonly #errorSink?: ErrorSink;
  #cursor = 0;
  #nextSeq = 0;
  #appliedSeq = -1;
  #pendingEncode?: PendingEncode;
  #inFlight = 0;
  /** Frames that bound querySet into a pass descriptor and have not been submitted/abandoned yet. */
  #retained = 0;
  #disposed = false;
  #destroyed = false;

  constructor(device: Device, options: QueryRingOptions) {
    this.capacity = options.capacity;
    const label = options.label ?? "vgpu.query-ring";
    this.#label = label;
    const byteSize = options.capacity * QUERY_RESULT_BYTES;
    this.querySet = device.gpu.createQuerySet({ type: options.type, count: options.capacity, label });
    // Mirrors WebGPU resolveQuerySet requirements: "destination.usage contains QUERY_RESOLVE" and
    // "destinationOffset + 8 × queryCount ≤ destination.size" (we always resolve at offset 0, a multiple of 256).
    this.#resolve = device.createBuffer({ size: byteSize, usage: ["query_resolve", "copy_src"], label: `${label}.resolve` });
    this.#stagings = Array.from({ length: options.depth ?? 3 }, (_, index) => ({
      buffer: device.createBuffer({ size: byteSize, usage: ["map_read", "copy_dst"], label: `${label}.staging${index}` }),
      mapPending: false,
      retired: false,
    }));
    this.#trackSettled = options.trackSettled;
    this.#errorSink = options.errorSink;
  }

  encodeResolve(encoder: GPUCommandEncoder, usedCount: number): boolean {
    this.#pendingEncode = undefined;
    if (this.#disposed || usedCount <= 0) return false;
    const staging = this.#claimStaging();
    // Drop, never block: when readbacks lag frames-in-flight past the ring depth, skip this frame's resolve entirely.
    if (!staging) return false;
    const count = Math.min(usedCount, this.capacity);
    encoder.resolveQuerySet(this.querySet, 0, count, this.#resolve.gpu, 0);
    encoder.copyBufferToBuffer(this.#resolve.gpu, 0, staging.buffer.gpu, 0, count * QUERY_RESULT_BYTES);
    this.#pendingEncode = { staging, usedCount: count, seq: this.#nextSeq };
    this.#nextSeq += 1;
    this.#cursor += 1;
    return true;
  }

  onSubmitted(apply: (values: BigUint64Array) => void): void {
    const pending = this.#pendingEncode;
    this.#pendingEncode = undefined;
    if (!pending) return;
    pending.staging.mapPending = true;
    this.#inFlight += 1;
    const readback = pending.staging.buffer.gpu.mapAsync(MAP_READ)
      .then(() => {
        // The buffer is mapped from here on: it must be unmapped before the slot rotates back into
        // use, even if decoding throws — resolving into a mapped buffer is a validation error.
        const values = this.#decodeMapped(pending);
        // Ordered application: a stale readback that lands after a newer one already applied is discarded.
        if (pending.seq <= this.#appliedSeq) return;
        this.#appliedSeq = pending.seq;
        apply(values);
      })
      // Non-throwing by contract, but never silent: a dropped readback is reported on gpu.onError.
      .catch((cause: unknown) => { this.#reportDroppedReadback(cause); })
      .finally(() => {
        pending.staging.mapPending = false;
        this.#inFlight -= 1;
        this.#destroyWhenIdle();
      });
    this.#trackSettled?.(readback);
  }

  /**
   * Next staging buffer in rotation, skipping retired slots. Undefined means "drop this resolve":
   * the slot is still map-pending (readbacks lag the ring depth) or every slot is retired.
   */
  #claimStaging(): StagingSlot | undefined {
    for (let checked = 0; checked < this.#stagings.length; checked += 1) {
      const slot = this.#stagings[this.#cursor % this.#stagings.length]!;
      if (!slot.retired) return slot.mapPending ? undefined : slot;
      // Permanently unusable: rotate past it so the remaining buffers keep serving readbacks.
      this.#cursor += 1;
    }
    return undefined;
  }

  /**
   * Copies the mapped range out and unmaps, keeping the slot reusable. A failure here (a lost device
   * mid-map) still unmaps best-effort; if that fails too the buffer may stay mapped forever, so the
   * slot is retired instead of being handed back to encodeResolve. Throws so the readback is dropped
   * and reported like any other failure.
   */
  #decodeMapped(pending: PendingEncode): BigUint64Array {
    let values: BigUint64Array;
    try { values = new BigUint64Array(pending.staging.buffer.gpu.getMappedRange().slice(0, pending.usedCount * QUERY_RESULT_BYTES)); }
    catch (error) {
      this.#unmapOrRetire(pending.staging);
      throw error;
    }
    try { pending.staging.buffer.gpu.unmap(); }
    catch (error) {
      pending.staging.retired = true;
      throw error;
    }
    return values;
  }

  #unmapOrRetire(staging: StagingSlot): void {
    try { staging.buffer.gpu.unmap(); }
    catch { staging.retired = true; }
  }

  retain(): void {
    this.#retained += 1;
  }

  release(): void {
    if (this.#retained > 0) this.#retained -= 1;
    this.#destroyWhenIdle();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pendingEncode = undefined;
    this.#destroyWhenIdle();
  }

  /** Destroys once disposed and idle: no in-flight map and no frame still referencing the query set. */
  #destroyWhenIdle(): void {
    if (!this.#disposed || this.#destroyed || this.#inFlight > 0 || this.#retained > 0) return;
    this.#destroyed = true;
    this.querySet.destroy();
    this.#resolve.dispose();
    for (const staging of this.#stagings) staging.buffer.dispose();
  }

  #reportDroppedReadback(cause: unknown): void {
    const error = queryReadbackError(this.#label, cause);
    const sink = this.#errorSink;
    if (!sink) {
      console.error(error);
      return;
    }
    try { void Promise.resolve(sink(error)).catch((sinkError: unknown) => { console.error(sinkError); }); }
    catch (sinkError) { console.error(sinkError); }
  }
}
