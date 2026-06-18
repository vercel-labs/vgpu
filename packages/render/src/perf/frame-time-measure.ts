import type { Device } from "@vgpu/core";
import { beginFrame, type Frame } from "../frame.ts";

const MS_PER_NS = 1 / 1_000_000;
const MAP_READ = 1; // GPUMapMode.READ

export type GpuFrameEncoder = (frame: Frame, index: number) => void;

/**
 * Wall-clock fallback: record one sample per frame while batching only the
 * queue flush cadence. This keeps `samples` aligned with requested frames,
 * matching the timestamp-query path and public docs.
 */
export async function measureWallClock(
  device: Device,
  encode: GpuFrameEncoder,
  frames: number,
  batch: number,
  label: string,
): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < frames; ) {
    const n = Math.min(batch, frames - i);
    for (let k = 0; k < n; k++) {
      const start = performance.now();
      const frame = beginFrame(device, { label });
      encode(frame, i + k);
      frame.submit();
      samples.push(performance.now() - start);
    }
    await device.queue.flush();
    i += n;
  }
  return samples;
}

/**
 * GPU-only timing via timestamp queries. Writes a begin/end timestamp around
 * each frame's passes, then resolves all pairs in one read at the end. Throws
 * if timestamp writes are unavailable so the caller can fall back to wall-clock.
 */
export async function measureTimestamp(
  device: Device,
  encode: GpuFrameEncoder,
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

export function summarize(ms: number[]): {
  medianMs: number;
  meanMs: number;
  minMs: number;
  p95Ms: number;
} {
  if (ms.length === 0) {
    return { medianMs: 0, meanMs: 0, minMs: 0, p95Ms: 0 };
  }
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
