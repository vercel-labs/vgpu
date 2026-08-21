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
import { compute as createCompute, effect as createEffect, frame as runFrame } from 'vgpu';
import {
  depthByteLength,
  depthElementCount,
  PRESENTATION_AUTO_RANGE,
  PRESENTATION_LOG_METRIC,
  type DepthModel,
} from './model-contract';
import reduceRangeWgsl from './reduce-range.wgsl';
import sideBySideWgsl from './side-by-side.wgsl';

/** Byte view for `Buffer.write`; narrows TypeScript's ArrayBufferLike generic. */
function asWriteData(view: Float32Array | Uint32Array | Uint8ClampedArray): Uint8Array<ArrayBuffer> {
  return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
}

export interface SideBySidePipeline {
  /**
   * Draws one frame: the colour input on the left, its depth on the right.
   *
   * `depth` may be a non-owning wrap of ORT's output buffer, so this only reads
   * it inside the submitted pass and never retains it past the call.
   */
  draw(
    gpu: Gpu,
    output: Surface | Target,
    depth: Buffer,
    colour: Buffer,
    model: DepthModel,
    options?: { hasResult?: boolean },
  ): void;
  dispose(): void;
}

export function createSideBySidePipeline(gpu: Gpu, label = 'depth-estimation'): SideBySidePipeline {
  const effect: Effect = createEffect(gpu, sideBySideWgsl, { label: `${label}-view` });
  const reducer: Compute = createCompute(gpu, reduceRangeWgsl, { label: `${label}-range` });
  // Two u32 keys: the min and max of the current depth tensor.
  const range: Buffer = gpu.device.createBuffer({
    size: 8,
    usage: ['storage', 'copy_dst'],
    label: `${label}-range`,
  });

  return {
    draw(currentGpu, output, depth, colour, model, options = {}) {
      const hasResult = options.hasResult ?? true;
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
        },
        depth,
        range,
        colour,
      });
      runFrame(currentGpu, (frame) => frame.pass({ target: output }, (pass) => pass.draw(effect)));
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

/** vgpu-owned buffer holding one RGBA8 frame for the colour half. */
export function createColourBuffer(gpu: Gpu, model: DepthModel, label = 'depth-estimation'): Buffer {
  return gpu.device.createBuffer({
    size: model.width * model.height * 4,
    usage: ['storage', 'copy_dst'],
    label: `${label}-colour`,
  });
}

export function writeColour(buffer: Buffer, rgba: Uint8ClampedArray): void {
  buffer.write(asWriteData(rgba));
}
