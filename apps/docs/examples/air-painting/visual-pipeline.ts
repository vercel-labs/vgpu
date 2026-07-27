/**
 * All vgpu resources and passes for the air-painting example.
 *
 * **ORT-free by contract.** `scripts/render-example-thumbs.mjs` bundles this
 * module for Node through `renderer.ts`, so it must never import
 * `onnxruntime-web` — not even dynamically. Session orchestration and the
 * borrowed-buffer lifetime live in `ort-runtime.ts`.
 *
 * Ownership split, so the VISUAL owner and this module never fight:
 *
 * - This module owns the mask, the brush state, the frame texture and the three
 *   shader dispatches. All of them are vgpu-owned and disposed here.
 * - `consumeKeypoints(keypoints, dt)` takes a **borrowed** buffer. It reads it
 *   inside the dispatches it submits and never retains it. The caller keeps ORT's
 *   tensor alive across the call and flushes before disposing the wrapper.
 * - `renderVisualFrame()` never touches the keypoint buffer at all; it composites
 *   from the persistent mask and brush state, so the display loop is free to run
 *   at 60 Hz between inference results.
 */
import type { Buffer, Compute, Effect, Gpu, Surface, Target, Texture } from 'vgpu';
import {
  BRUSH_BUFFER_BYTES,
  BRUSH_TUNING,
  computeFrameTransform,
  FOG_TUNING,
  fogDecay,
  HAND_EXTRAPOLATION,
  KEYPOINT_BUFFER_BYTES,
  MASK_BYTES,
  MASK_HEIGHT,
  MASK_TEXELS,
  MASK_WIDTH,
  maxJumpDistance,
  type BrushTuning,
  type FogTuning,
  type HandExtrapolation,
  type FrameTransform,
} from './pose-contract';
import compositeWgsl from './composite.wgsl';
import frostWgsl from './frost.wgsl';
import paintWgsl from './paint.wgsl';
import wristWgsl from './wrist.wgsl';

/** Matches `@workgroup_size(64)` in paint.wgsl. */
const PAINT_WORKGROUP_SIZE = 64;
const PAINT_WORKGROUPS = Math.ceil(MASK_TEXELS / PAINT_WORKGROUP_SIZE);

/** Byte view for `Buffer.write`; narrows TypeScript's ArrayBufferLike generic. */
function asWriteData(view: Float32Array | Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
}

export interface VisualPipelineOptions {
  /** Camera frame width in pixels. */
  readonly sourceWidth: number;
  /** Camera frame height in pixels. */
  readonly sourceHeight: number;
  readonly label?: string;
  readonly tuning?: BrushTuning;
  readonly extrapolation?: HandExtrapolation;
  readonly fog?: FogTuning;
}

export interface ConsumeOptions {
  /** Drop stroke continuity for this result, e.g. right after Clear. */
  readonly reset?: boolean;
}

export interface VisualFrameOptions {
  /** Clamped device pixel ratio; keeps the Bayer cell a fixed logical size. */
  readonly dpr?: number;
  /** False before any camera/canned frame has been uploaded. */
  readonly hasFrame?: boolean;
  /** Draw the wrist cursor. */
  readonly showCursor?: boolean;
}

export interface VisualPipeline {
  readonly transform: FrameTransform;
  /** Persistent f32 coverage mask in `brush` space, 960x540. */
  readonly mask: Buffer;
  /** Persistent per-hand stroke state, one 64-byte slot per limb; only the GPU writes it. */
  readonly brushes: Buffer;
  readonly frameTexture: Texture;

  /**
   * Runs `wrist.wgsl` then `paint.wgsl` against a keypoint buffer.
   *
   * `keypoints` may be a non-owning wrap of ORT's `[1,1,17,3]` output. Both
   * dispatches are submitted before this returns, so the caller only has to
   * flush the queue before releasing the wrapper.
   */
  consumeKeypoints(keypoints: Buffer, dtSeconds: number, options?: ConsumeOptions): void;

  /** Composites the newest frame, the persistent mask and the fixed dither. */
  renderVisualFrame(output: Surface | Target, options?: VisualFrameOptions): void;

  /** Uploads tightly packed RGBA8 of exactly the current source size. */
  writeFrame(rgba: Uint8Array): void;

  /** Copies a video frame straight into the device texture (browser only). */
  copyExternalFrame(source: GPUCopyExternalImageSource): void;

  /** Zeroes the mask and drops stroke continuity. Nothing else is reset. */
  clearMask(): void;

  /** Rebuilds the frame texture after the camera renegotiates its resolution. */
  resizeSource(sourceWidth: number, sourceHeight: number): void;

  dispose(): void;
}

/** Allocates a keypoint-shaped storage buffer for fixture-driven modes. */
export function createKeypointBuffer(gpu: Gpu, label = 'air-painting'): Buffer {
  return gpu.device.createBuffer({
    size: KEYPOINT_BUFFER_BYTES,
    usage: ['storage', 'copy_dst'],
    label: `${label}-keypoints`,
  });
}

/** Writes a golden `[1,1,17,3]` array into a fixture keypoint buffer. */
export function writeKeypoints(buffer: Buffer, keypoints: Float32Array): void {
  buffer.write(asWriteData(keypoints));
}

export function createVisualPipeline(gpu: Gpu, options: VisualPipelineOptions): VisualPipeline {
  const label = options.label ?? 'air-painting';
  const tuning = options.tuning ?? BRUSH_TUNING;
  const extrapolation = options.extrapolation ?? HAND_EXTRAPOLATION;
  const fog = options.fog ?? FOG_TUNING;
  let transform = computeFrameTransform(options.sourceWidth, options.sourceHeight);

  const mask = gpu.device.createBuffer({
    size: MASK_BYTES,
    usage: ['storage', 'copy_dst'],
    label: `${label}-mask`,
  });
  // WebGPU zero-initializes buffers, so the idle state is "nothing painted".
  const brushes = gpu.device.createBuffer({
    size: BRUSH_BUFFER_BYTES,
    usage: ['storage', 'copy_dst'],
    label: `${label}-brushes`,
  });

  let frameTexture = createFrameTexture(gpu, label, transform);
  // Clamped so the 9-tap kernel cannot wrap the frame's own edge into the frost.
  const sampler = gpu.sampler({
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  let frostA = createFrostTarget(gpu, label, transform, fog, 'a');
  let frostB = createFrostTarget(gpu, label, transform, fog, 'b');

  const wrist: Compute = gpu.compute(wristWgsl, { label: `${label}-wrist` });
  const paint: Compute = gpu.compute(paintWgsl, { label: `${label}-paint` });
  // Two instances of one shader: the horizontal pass downsamples out of the
  // full-resolution camera texture, the vertical pass runs target-to-target.
  const frostH: Effect = gpu.effect(frostWgsl, { label: `${label}-frost-h` });
  const frostV: Effect = gpu.effect(frostWgsl, { label: `${label}-frost-v` });
  const composite: Effect = gpu.effect(compositeWgsl, { label: `${label}-composite` });

  const pipeline: VisualPipeline = {
    get transform() {
      return transform;
    },
    mask,
    brushes,
    get frameTexture() {
      return frameTexture;
    },

    consumeKeypoints(keypoints, dtSeconds, consumeOptions = {}) {
      wrist.set({
        uniforms: {
          pad: [transform.padX, transform.padY],
          source: [transform.sourceWidth, transform.sourceHeight],
          dt: dtSeconds,
          scale: transform.scale,
          enter_confidence: tuning.enterConfidence,
          stay_confidence: tuning.stayConfidence,
          ema_tau: tuning.emaTauSeconds,
          max_jump: maxJumpDistance(tuning),
          reset: consumeOptions.reset ? 1 : 0,
          hand_extend: extrapolation.factor,
          elbow_confidence: extrapolation.elbowConfidence,
        },
        keypoints,
        brushes,
      });
      // One workgroup of BRUSH_COUNT invocations: one independent hand each.
      wrist.dispatch(1);

      paint.set({
        uniforms: {
          mask_size: [MASK_WIDTH, MASK_HEIGHT],
          radius: tuning.radiusTexels,
          feather: tuning.featherTexels,
          // The re-fog rides the inference clock. Being multiplicative it
          // composes, so the fog curve is the same whether results arrive at
          // 15 Hz or 60 Hz.
          decay: fogDecay(dtSeconds, fog.refogTauSeconds),
          clear_epsilon: fog.clearEpsilon,
        },
        brushes,
        mask,
      });
      // Submitted after the wrist dispatch on the same queue, so the ordering is
      // guaranteed without an explicit barrier.
      paint.dispatch(PAINT_WORKGROUPS);
    },

    renderVisualFrame(output, frameOptions = {}) {
      const dpr = Math.min(2, Math.max(1, frameOptions.dpr ?? 1));
      // Horizontal pass reads the full-resolution camera texture and lands in the
      // quarter-resolution target; vertical pass runs target-to-target.
      frostH.set({
        src: frameTexture,
        samp: sampler,
        frost: {
          texel_size: [1 / transform.sourceWidth, 1 / transform.sourceHeight],
          direction: [1, 0],
          sigma: fog.blurSigmaTexels,
        },
      });
      frostV.set({
        src: frostA.color,
        samp: sampler,
        frost: {
          texel_size: frostA.texelSize,
          direction: [0, 1],
          sigma: fog.blurSigmaTexels,
        },
      });
      composite.set({
        uniforms: {
          resolution: output.size,
          mask_size: [MASK_WIDTH, MASK_HEIGHT],
          source_size: [transform.sourceWidth, transform.sourceHeight],
          has_frame: frameOptions.hasFrame === false ? 0 : 1,
          show_cursor: frameOptions.showCursor === false ? 0 : 1,
          cursor_radius: tuning.radiusTexels + 6,
          frost_lift: fog.frostLift,
          frost_grain: fog.frostGrain,
          grain_cell: fog.grainCellLogicalPx * dpr,
        },
        frame_tex: frameTexture,
        frame_samp: sampler,
        mask,
        brushes,
        frost_tex: frostB.color,
      });
      // All three passes in one frame: the frost chain has to complete before the
      // compositor samples it, and same-frame ordering gives that for free.
      gpu.frame((frame) => {
        frame.pass({ target: frostA }, (pass) => pass.draw(frostH));
        frame.pass({ target: frostB }, (pass) => pass.draw(frostV));
        frame.pass({ target: output }, (pass) => pass.draw(composite));
      });
    },

    writeFrame(rgba) {
      const [width, height] = [transform.sourceWidth, transform.sourceHeight];
      const expected = width * height * 4;
      if (rgba.byteLength !== expected) {
        throw new Error(
          `Frame upload expects ${expected} bytes for ${width}x${height}, received ${rgba.byteLength}.`,
        );
      }
      gpu.gpu.queue.writeTexture(
        { texture: frameTexture.gpu },
        asWriteData(rgba),
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height },
      );
    },

    copyExternalFrame(source) {
      gpu.gpu.queue.copyExternalImageToTexture(
        { source },
        { texture: frameTexture.gpu },
        { width: transform.sourceWidth, height: transform.sourceHeight },
      );
    },

    clearMask() {
      mask.write(new Uint8Array(MASK_BYTES));
      // Continuity is dropped by the next consumeKeypoints({ reset: true }); the
      // brush position itself is deliberately preserved so tracking survives.
    },

    resizeSource(sourceWidth, sourceHeight) {
      const next = computeFrameTransform(sourceWidth, sourceHeight);
      if (
        next.sourceWidth === transform.sourceWidth &&
        next.sourceHeight === transform.sourceHeight
      ) {
        return;
      }
      transform = next;
      const previous = frameTexture;
      frameTexture = createFrameTexture(gpu, label, transform);
      previous.destroy();
      // The frost chain is sized off the camera, so it has to follow.
      const previousA = frostA;
      const previousB = frostB;
      frostA = createFrostTarget(gpu, label, transform, fog, 'a');
      frostB = createFrostTarget(gpu, label, transform, fog, 'b');
      destroyTarget(previousA);
      destroyTarget(previousB);
      // The mask keeps its strokes: it lives in normalized brush space, so a
      // camera resolution change does not invalidate what the user wiped.
    },

    dispose() {
      destroyTarget(frostB);
      destroyTarget(frostA);
      frameTexture.destroy();
      brushes.dispose();
      mask.dispose();
    },
  };

  return pipeline;
}

/**
 * One stage of the frost chain, at `1 / blurDownsample` of the camera resolution.
 *
 * Rounded up and floored at 1 so a very small or very odd camera resolution
 * cannot produce a zero-sized target.
 */
function createFrostTarget(
  gpu: Gpu,
  label: string,
  transform: FrameTransform,
  fog: FogTuning,
  suffix: string,
): Target {
  const divisor = Math.max(1, Math.floor(fog.blurDownsample));
  const width = Math.max(1, Math.ceil(transform.sourceWidth / divisor));
  const height = Math.max(1, Math.ceil(transform.sourceHeight / divisor));
  return gpu.target({
    size: [width, height],
    format: 'rgba8unorm',
    label: `${label}-frost-${suffix}`,
  });
}

/** `Target` does not declare `destroy()` on the public interface; it has one. */
function destroyTarget(target: Target | undefined): void {
  (target as { destroy?: () => void } | undefined)?.destroy?.();
}

function createFrameTexture(gpu: Gpu, label: string, transform: FrameTransform): Texture {
  return gpu.device.createTexture({
    size: [transform.sourceWidth, transform.sourceHeight],
    format: 'rgba8unorm',
    usage: ['texture_binding', 'copy_dst', 'render_attachment'],
    label: `${label}-frame`,
  });
}
