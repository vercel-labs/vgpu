import type { Device } from "@vgpu/core";
import { beginFrame, type Frame } from "../frame.ts";

/**
 * Options for {@link gpuFrameTime}. All have sensible defaults; the common call passes only the
 * device and an encode callback.
 */
export interface GpuFrameTimeOptions {
  /** Measured frames (after warmup). Default 120. */
  readonly frames?: number;
  /** Warmup frames discarded before measuring (shader compile + lazy allocs settle). Default 30. */
  readonly warmup?: number;
  /** Frames per wall-clock batch (amortizes submit/drain latency). Ignored for timestamp-query. Default 8. */
  readonly batch?: number;
  /** Force the wall-clock path even when timestamp-query is available. Default false. */
  readonly forceWallClock?: boolean;
  readonly label?: string;
}

export interface GpuFrameTimeResult {
  /** Median per-frame time in milliseconds — the headline number for before/after comparisons. */
  readonly medianMs: number;
  readonly meanMs: number;
  readonly minMs: number;
  readonly p95Ms: number;
  /** Per-frame samples behind the stats. */
  readonly samples: number;
  /**
   * How the time was obtained. `timestamp-query` is GPU-only (excludes submit/drain) and needs the
   * device feature; `wall-clock` (queue.flush) is the robust fallback and works everywhere.
   */
  readonly method: "timestamp-query" | "wall-clock";
}

const MS_PER_NS = 1 / 1_000_000;
const MAP_READ = 1; // GPUMapMode.READ

/**
 * Measures GPU time per frame for a render routine, for before/after optimization comparisons.
 *
 * The `encode` callback records the frame's passes onto a vgpu {@link Frame} — the SAME body you
 * run in production. The harness owns warmup, the loop, submit, and timing, so you don't hand-roll
 * a bench. It prefers GPU timestamp queries when the device supports them (`timestamp-query`) and
 * otherwise falls back to wall-clock timing via `device.queue.flush()`.
 *
 * Tooling only — never call this on a live animation-frame path.
 *
 * @example
 * const { medianMs, method } = await gpuFrameTime(device, (frame, i) => {
 *   frame.renderPass(scenePass, (pass) => drawScene(pass, i));
 *   frame.renderPass(floorPass, (pass) => drawFloor(pass, i));
 * });
 */
export async function gpuFrameTime(
  device: Device,
  encode: (frame: Frame, index: number) => void,
  options: GpuFrameTimeOptions = {},
): Promise<GpuFrameTimeResult> {
  const frames = Math.max(1, Math.floor(options.frames ?? 120));
  const warmup = Math.max(0, Math.floor(options.warmup ?? 30));
  const batch = Math.max(1, Math.floor(options.batch ?? 8));
  const label = options.label ?? "vgpu-gpuFrameTime";

  for (let i = 0; i < warmup; i++) {
    const frame = beginFrame(device, { label });
    encode(frame, i);
    frame.submit();
  }
  await device.queue.flush();

  let perFrameMs: number[] | null = null;
  let method: GpuFrameTimeResult["method"] = "wall-clock";
  if (!options.forceWallClock && device.features.has("timestamp-query")) {
    try {
      perFrameMs = await measureTimestamp(device, encode, frames, label);
      method = "timestamp-query";
    } catch {
      perFrameMs = null; // any timestamp hiccup → fall back to the robust path
    }
  }
  if (!perFrameMs || perFrameMs.length === 0) {
    perFrameMs = await measureWallClock(device, encode, frames, batch, label);
    method = "wall-clock";
  }

  return { ...summarize(perFrameMs), samples: perFrameMs.length, method };
}

/** Batched wall-clock: time `batch` frames between flushes, divide by `batch` → per-frame ms. */
async function measureWallClock(
  device: Device,
  encode: (frame: Frame, index: number) => void,
  frames: number,
  batch: number,
  label: string,
): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < frames; ) {
    const n = Math.min(batch, frames - i);
    const start = performance.now();
    for (let k = 0; k < n; k++) {
      const frame = beginFrame(device, { label });
      encode(frame, i + k);
      frame.submit();
    }
    await device.queue.flush();
    samples.push((performance.now() - start) / n);
    i += n;
  }
  return samples;
}

/**
 * GPU-only timing via timestamp queries. Writes a begin/end timestamp around each frame's passes
 * (at encoder scope, between render passes — `frame.gpu` is the documented escape hatch), then
 * resolves all pairs in one read at the end. Throws if `writeTimestamp` is unavailable so the
 * caller falls back to wall-clock.
 */
async function measureTimestamp(
  device: Device,
  encode: (frame: Frame, index: number) => void,
  frames: number,
  label: string,
): Promise<number[]> {
  const gpu = device.gpu;
  const querySet = gpu.createQuerySet({ type: "timestamp", count: frames * 2 });
  const resolve = device.createBuffer({
    size: frames * 2 * 8,
    usage: ["query_resolve", "copy_src"],
    label: `${label}-ts-resolve`,
  });
  const read = device.createBuffer({
    size: frames * 2 * 8,
    usage: ["map_read", "copy_dst"],
    label: `${label}-ts-read`,
  });
  try {
    for (let i = 0; i < frames; i++) {
      const frame = beginFrame(device, { label });
      const enc = frame.gpu as GPUCommandEncoder & {
        writeTimestamp?: (set: GPUQuerySet, index: number) => void;
      };
      if (typeof enc.writeTimestamp !== "function") {
        throw new Error("GPUCommandEncoder.writeTimestamp unavailable");
      }
      enc.writeTimestamp(querySet, i * 2);
      encode(frame, i);
      enc.writeTimestamp(querySet, i * 2 + 1);
      frame.submit();
    }
    const enc = gpu.createCommandEncoder({ label: `${label}-ts-resolve` });
    enc.resolveQuerySet(querySet, 0, frames * 2, resolve.gpu, 0);
    enc.copyBufferToBuffer(resolve.gpu, 0, read.gpu, 0, frames * 2 * 8);
    gpu.queue.submit([enc.finish()]);

    await read.gpu.mapAsync(MAP_READ);
    const ticks = new BigUint64Array(read.gpu.getMappedRange().slice(0));
    read.gpu.unmap();

    const samples: number[] = [];
    for (let i = 0; i < frames; i++) {
      const dt = Number(ticks[i * 2 + 1]! - ticks[i * 2]!) * MS_PER_NS;
      if (Number.isFinite(dt) && dt > 0) samples.push(dt);
    }
    if (samples.length === 0) throw new Error("no valid timestamp samples");
    return samples;
  } finally {
    querySet.destroy();
    resolve.dispose();
    read.dispose();
  }
}

function summarize(ms: number[]): {
  medianMs: number;
  meanMs: number;
  minMs: number;
  p95Ms: number;
} {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
  return {
    medianMs: at(0.5),
    meanMs: sorted.reduce((s, v) => s + v, 0) / sorted.length,
    minMs: sorted[0]!,
    p95Ms: at(0.95),
  };
}
