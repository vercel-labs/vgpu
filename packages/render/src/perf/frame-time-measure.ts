import type { Device } from "@vgpu/core";

const MS_PER_NS = 1 / 1_000_000;
const MAP_READ = 1; // GPUMapMode.READ

export type GpuFrameEncoder = (encoder: GPUCommandEncoder, index: number) => void;

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
      const encoder = device.gpu.createCommandEncoder({ label });
      encode(encoder, i + k);
      device.queue.gpu.submit([encoder.finish()]);
      samples.push(performance.now() - start);
    }
    await device.queue.flush();
    i += n;
  }
  return samples;
}

export async function measureTimestamp(
  device: Device,
  encode: GpuFrameEncoder,
  frames: number,
  label: string,
): Promise<number[]> {
  const gpu = device.gpu;
  const querySet = gpu.createQuerySet({ type: "timestamp", count: frames * 2 });
  const resolve = device.createBuffer({ size: frames * 2 * 8, usage: ["query_resolve", "copy_src"], label: `${label}-ts-resolve` });
  const read = device.createBuffer({ size: frames * 2 * 8, usage: ["map_read", "copy_dst"], label: `${label}-ts-read` });
  try {
    for (let i = 0; i < frames; i++) {
      const encoder = gpu.createCommandEncoder({ label }) as GPUCommandEncoder & { writeTimestamp?: (set: GPUQuerySet, index: number) => void };
      if (typeof encoder.writeTimestamp !== "function") throw new Error("GPUCommandEncoder.writeTimestamp unavailable");
      encoder.writeTimestamp(querySet, i * 2);
      encode(encoder, i);
      encoder.writeTimestamp(querySet, i * 2 + 1);
      gpu.queue.submit([encoder.finish()]);
    }
    const encoder = gpu.createCommandEncoder({ label: `${label}-ts-resolve` });
    encoder.resolveQuerySet(querySet, 0, frames * 2, resolve.gpu, 0);
    encoder.copyBufferToBuffer(resolve.gpu, 0, read.gpu, 0, frames * 2 * 8);
    gpu.queue.submit([encoder.finish()]);

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

export function summarize(ms: number[]): { medianMs: number; meanMs: number; minMs: number; p95Ms: number } {
  if (ms.length === 0) return { medianMs: 0, meanMs: 0, minMs: 0, p95Ms: 0 };
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
  return { medianMs: at(0.5), meanMs: sorted.reduce((s, v) => s + v, 0) / sorted.length, minMs: sorted[0]!, p95Ms: at(0.95) };
}
