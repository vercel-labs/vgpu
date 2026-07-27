/**
 * ORT-free presentation for the neural shader example.
 *
 * This module is bundled for Node by `scripts/render-example-thumbs.mjs`, so it
 * must never import ONNX Runtime Web (not even dynamically). The browser
 * lifecycle lives in `ort-runtime.ts`.
 */
import type { Buffer, Effect, Gpu, Surface, Target } from 'vgpu';
import type { ThumbnailOptions } from '../../lib/example-renderer';
import { asWriteData, evaluateCppnImage, GRID, RGBA_BYTES, TIME_SCALE } from './evaluate';
import presentWgsl from './present.wgsl';

/** Fixed thumbnail time in seconds; keep in sync with `meta.thumb.time`. */
export const THUMB_TIME = 2.75;

export interface PresentPipeline {
  /** Draws `pixels` (NHWC float32 RGBA) into `output` in one fullscreen pass. */
  draw(gpu: Gpu, output: Surface | Target, pixels: Buffer, time: number): void;
  dispose(): void;
}

/** Builds the single presentation effect shared by the browser and the thumbnail. */
export function createPresentPipeline(gpu: Gpu, label = 'neural-shader-cppn'): PresentPipeline {
  const effect: Effect = gpu.effect(presentWgsl, { label: `${label}-present` });
  return {
    draw(currentGpu, output, pixels, time) {
      effect.set({
        uniforms: { resolution: output.size, grid: GRID, time },
        pixels,
      });
      currentGpu.frame((frame) => frame.pass({ target: output }, (pass) => pass.draw(effect)));
    },
    dispose() {
      // Effects are owned by the vgpu facade; nothing extra to release today.
    },
  };
}

/**
 * Deterministic thumbnail: evaluates the committed weights on the CPU and draws
 * them with the production shader. It exercises the presentation path, not the
 * ORT interop, which only a real browser can prove.
 */
export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  options: ThumbnailOptions = {},
): Promise<void> {
  const time = options.time ?? THUMB_TIME;
  const image = evaluateCppnImage(time * TIME_SCALE);
  const pixels = gpu.device.createBuffer({
    size: RGBA_BYTES,
    usage: ['storage', 'copy_dst'],
    label: 'neural-shader-cppn-thumb-pixels',
  });
  const pipeline = createPresentPipeline(gpu, 'neural-shader-cppn-thumb');
  try {
    pixels.write(asWriteData(image));
    pipeline.draw(gpu, target, pixels, time);
  } finally {
    // Always drain and settle, including when encoding throws.
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    pipeline.dispose();
    pixels.dispose();
  }
}
