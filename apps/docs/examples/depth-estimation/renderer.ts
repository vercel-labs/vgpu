/**
 * ORT-free presentation for the depth example.
 *
 * `scripts/render-example-thumbs.mjs` bundles this module for Node, so it must
 * never import ONNX Runtime Web, not even dynamically. Session orchestration
 * lives in `ort-runtime.ts`.
 *
 * The pipeline consumes a plain `array<f32>` and does not care whether those
 * floats came from a live model on the GPU or from the committed fixture, which
 * is exactly why thumbnails can be deterministic without a model.
 */
import type { Buffer, Compute, Effect, Gpu, Surface, Target } from 'vgpu';
import type { ThumbnailOptions } from '../../lib/example-renderer';
import { decodeGoldenDepth, GOLDEN_MODEL_ID } from './fixtures';
import {
  depthByteLength,
  depthElementCount,
  getDepthModel,
  PRESENTATION_AUTO_RANGE,
  PRESENTATION_LOG_METRIC,
  type DepthModel,
} from './model-contract';
import reduceRangeWgsl from './reduce-range.wgsl';
import reliefWgsl from './relief.wgsl';

/** Byte view for `Buffer.write`; narrows TypeScript's ArrayBufferLike generic. */
function asWriteData(view: Float32Array | Uint32Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
}

export interface ReliefPipeline {
  /**
   * Draws one frame.
   *
   * `depth` may be a non-owning wrap of ORT's output buffer, so this only reads
   * it inside the submitted pass and never retains it past the call.
   */
  draw(
    gpu: Gpu,
    output: Surface | Target,
    depth: Buffer,
    model: DepthModel,
    options?: { hasResult?: boolean; parallax?: readonly [number, number] },
  ): void;
  dispose(): void;
}

export function createReliefPipeline(gpu: Gpu, label = 'depth-estimation'): ReliefPipeline {
  const effect: Effect = gpu.effect(reliefWgsl, { label: `${label}-relief` });
  const reducer: Compute = gpu.compute(reduceRangeWgsl, { label: `${label}-range` });
  // Two u32 keys: the min and max of the current depth tensor.
  const range: Buffer = gpu.device.createBuffer({
    size: 8,
    usage: ['storage', 'copy_dst'],
    label: `${label}-range`,
  });

  return {
    draw(currentGpu, output, depth, model, options = {}) {
      const hasResult = options.hasResult ?? true;
      const [px, py] = options.parallax ?? [0, 0];
      const autoRange = model.presentation.mode === 'auto-range';

      if (hasResult && autoRange) {
        // Reset before reducing: the shader takes plain min/max, so the seed
        // values must be the identity for each.
        range.write(asWriteData(new Uint32Array([0xffffffff, 0])));
        reducer.set({ uniforms: { count: depthElementCount(model) }, depth, range });
        reducer.dispatch(1);
      }

      effect.set({
        uniforms: {
          resolution: output.size,
          depth_size: [model.width, model.height],
          mode: autoRange ? PRESENTATION_AUTO_RANGE : PRESENTATION_LOG_METRIC,
          near_meters:
            model.presentation.mode === 'log-metric' ? model.presentation.nearMeters : 0.35,
          far_meters: model.presentation.mode === 'log-metric' ? model.presentation.farMeters : 10,
          has_result: hasResult ? 1 : 0,
          parallax: [px, py],
        },
        depth,
        range,
      });
      currentGpu.frame((frame) => frame.pass({ target: output }, (pass) => pass.draw(effect)));
    },
    dispose() {
      range.dispose();
    },
  };
}

/** vgpu-owned buffer sized for one depth result; used for idle and fixture frames. */
export function createDepthBuffer(gpu: Gpu, model: DepthModel, label = 'depth-estimation'): Buffer {
  return gpu.device.createBuffer({
    size: depthByteLength(model),
    usage: ['storage', 'copy_dst'],
    label: `${label}-depth`,
  });
}

export function writeDepth(buffer: Buffer, values: Float32Array): void {
  buffer.write(asWriteData(values));
}

/**
 * Deterministic thumbnail: uploads the depth field captured from the default
 * model on the committed source image, then runs the production shader.
 *
 * This validates the visualizer only. It proves nothing about ORT interop,
 * which requires a real browser.
 */
export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  _options: ThumbnailOptions = {},
): Promise<void> {
  const model = getDepthModel(GOLDEN_MODEL_ID);
  const relief = createReliefPipeline(gpu, 'depth-estimation-thumb');
  const depth = createDepthBuffer(gpu, model, 'depth-estimation-thumb');
  try {
    writeDepth(depth, decodeGoldenDepth());
    relief.draw(gpu, target, depth, model, { hasResult: true, parallax: [0, 0] });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    relief.dispose();
    depth.dispose();
  }
}
