import type { Device } from "@vgpu/core";
import { beginFrame, type Frame } from "../frame.ts";
import { measureTimestamp, measureWallClock, summarize } from "./frame-time-measure.ts";

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

  await warmupFrames(device, encode, warmup, label);

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

async function warmupFrames(
  device: Device,
  encode: (frame: Frame, index: number) => void,
  warmup: number,
  label: string,
): Promise<void> {
  for (let i = 0; i < warmup; i++) {
    const frame = beginFrame(device, { label });
    encode(frame, i);
    frame.submit();
  }
  await device.queue.flush();
}
