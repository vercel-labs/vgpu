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
 * - This module owns the mask, the brush state, the ROI buffer, the two model
 *   input buffers, the frame texture and the shader dispatches. All of them are
 *   vgpu-owned and disposed here.
 * - `consumeHandLandmarks()` takes **borrowed** buffers. It reads them inside the
 *   dispatches it submits and never retains them. The caller keeps ORT's tensors
 *   alive across the call and flushes before disposing the wrappers.
 * - `renderVisualFrame()` never touches a landmark buffer at all; it composites
 *   from the persistent mask and brush state, so the display loop is free to run
 *   at 60 Hz between inference results.
 *
 * ## The model inputs are built here, on the GPU
 *
 * `cropModelInput()` samples the camera texture through a rotated ROI straight
 * into a storage buffer that ORT consumes as a tensor. Both model inputs come
 * from that one call — the detector's letterbox is just the unrotated,
 * whole-frame case — so there is no CPU pixel work anywhere in this example.
 *
 * The ROI it crops through lives in a **GPU buffer that `hand.wgsl` writes**.
 * That is what keeps tracked frames off the CPU entirely: the host never learns
 * where the hand is, it just asks for slot 0 and slot 1 to be cropped again.
 */
import type { Buffer, Compute, Effect, Gpu, Surface, Target, Texture } from 'vgpu';
import { compute as createCompute, effect as createEffect, frame as runFrame, sampler as createSampler, target as createTarget } from 'vgpu';
import {
  BRUSH_BUFFER_BYTES,
  BRUSH_TUNING,
  FOG_TUNING,
  fogDecay,
  MASK_BYTES,
  MASK_HEIGHT,
  MASK_TEXELS,
  MASK_WIDTH,
  maxJumpDistance,
  ROI_BYTES,
  ROI_DETECTOR_SLOT,
  ROI_SLOT_COUNT,
  ROI_STRIDE_FLOATS,
  type BrushTuning,
  type FogTuning,
} from './brush-contract';
import {
  DETECTOR_INPUT_BYTES,
  DETECTOR_SIZE,
  LANDMARK_INPUT_BYTES,
  LANDMARK_POINTS_BUFFER_BYTES,
  LANDMARK_SIZE,
  MAX_HANDS,
} from './hand-model-contract';
import { detectorRoi } from './hand-preprocess';
import type { HandRoi } from './hand-pipeline';
import compositeWgsl from './composite.wgsl';
import frostWgsl from './frost.wgsl';
import handWgsl from './hand.wgsl';
import handCropWgsl from './hand-crop.wgsl';
import paintWgsl from './paint.wgsl';

/** Matches `@workgroup_size(64)` in paint.wgsl. */
const PAINT_WORKGROUP_SIZE = 64;
const PAINT_WORKGROUPS = Math.ceil(MASK_TEXELS / PAINT_WORKGROUP_SIZE);
/** Matches `@workgroup_size(8, 8)` in hand-crop.wgsl. */
const CROP_WORKGROUP_SIZE = 8;

/**
 * How much to grow the landmark bounding box into the next frame's ROI.
 *
 * 2.0 is MediaPipe's value and it is not generous padding for its own sake: the
 * crop has to still contain the hand *next* frame, after it has moved and
 * possibly opened, and a hand that clips out of its own ROI cannot be recovered
 * by the landmark model — only by rerunning the detector.
 */
export const ROI_LOOPBACK_SCALE = 2;

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
  readonly fog?: FogTuning;
}

/** One slot's contribution to a consumed result. */
export interface HandResultInput {
  /**
   * Borrowed `[1,63]` landmark buffer, or `undefined` when this slot did not run
   * the landmark model this frame.
   */
  readonly landmarks?: Buffer;
  /** Hand presence from the landmark model; ORT returns this one float on the CPU. */
  readonly presence: number;
}

export interface ConsumeOptions {
  /** Drop stroke continuity for this result, e.g. right after Clear. */
  readonly reset?: boolean;
}

export interface VisualFrameOptions {
  /** Clamped device pixel ratio; keeps the grain cell a fixed logical size. */
  readonly dpr?: number;
  /** False before any camera/canned frame has been uploaded. */
  readonly hasFrame?: boolean;
  /** Draw the brush cursor. */
  readonly showCursor?: boolean;
}

export interface VisualPipeline {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Persistent f32 coverage mask in `brush` space, 960x540. */
  readonly mask: Buffer;
  /** Persistent per-hand stroke state, one 64-byte slot per hand; only the GPU writes it. */
  readonly brushes: Buffer;
  /** Rotated crop regions in source pixels; written by the GPU on tracked frames. */
  readonly rois: Buffer;
  /** NHWC float32 `[1,192,192,3]`, ready to be handed to ORT as a tensor. */
  readonly detectorInput: Buffer;
  readonly frameTexture: Texture;

  /** NHWC float32 `[1,224,224,3]` for one hand slot. */
  landmarkInput(slot: number): Buffer;

  /** Overwrites one ROI slot from the host. Only used on reacquisition and resize. */
  writeRoi(slot: number, roi: HandRoi): void;

  /**
   * Samples the camera texture into the detector's input buffer.
   * Submitted immediately; the caller flushes before ORT reads it.
   */
  cropDetectorInput(): void;

  /** Samples the camera texture into one hand slot's landmark input buffer. */
  cropLandmarkInput(slot: number): void;

  /**
   * Runs `hand.wgsl` then `paint.wgsl` against the borrowed landmark buffers.
   *
   * Both dispatches are submitted before this returns, so the caller only has to
   * flush the queue before releasing the wrappers.
   */
  consumeHandLandmarks(
    results: readonly HandResultInput[],
    dtSeconds: number,
    options?: ConsumeOptions,
  ): void;

  /** Composites the newest frame, the persistent mask and the fixed grain. */
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

/** Allocates a landmark-shaped storage buffer for fixture-driven modes. */
export function createLandmarkBuffer(gpu: Gpu, label = 'air-painting', slot = 0): Buffer {
  return gpu.device.createBuffer({
    size: LANDMARK_POINTS_BUFFER_BYTES,
    usage: ['storage', 'copy_dst'],
    label: `${label}-landmarks-${slot}`,
  });
}

/** Writes a golden `[1,63]` array into a fixture landmark buffer. */
export function writeLandmarks(buffer: Buffer, landmarks: Float32Array): void {
  buffer.write(asWriteData(landmarks));
}

export function createVisualPipeline(gpu: Gpu, options: VisualPipelineOptions): VisualPipeline {
  const label = options.label ?? 'air-painting';
  const tuning = options.tuning ?? BRUSH_TUNING;
  const fog = options.fog ?? FOG_TUNING;
  let sourceWidth = options.sourceWidth;
  let sourceHeight = options.sourceHeight;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new Error(`Frame size must be positive, received ${sourceWidth}x${sourceHeight}.`);
  }

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
  const rois = gpu.device.createBuffer({
    size: ROI_BYTES,
    usage: ['storage', 'copy_dst'],
    label: `${label}-rois`,
  });

  // `copy_src` is required as well as `storage`: ONNX Runtime reads these as
  // tensor inputs, and the gate's GPU-input probe pinned that usage set.
  const detectorInput = gpu.device.createBuffer({
    size: DETECTOR_INPUT_BYTES,
    usage: ['storage', 'copy_src', 'copy_dst'],
    label: `${label}-detector-input`,
  });
  const landmarkInputs = Array.from({ length: MAX_HANDS }, (_unused, slot) =>
    gpu.device.createBuffer({
      size: LANDMARK_INPUT_BYTES,
      usage: ['storage', 'copy_src', 'copy_dst'],
      label: `${label}-landmark-input-${slot}`,
    }),
  );

  /**
   * Stand-in for a slot that did not run this frame.
   *
   * The bind group layout is static, so both landmark bindings must always
   * resolve to a real buffer even when only one hand is up. `hand.wgsl` is told
   * which slots actually ran and never reads the zeros, but WebGPU still has to
   * be handed something.
   */
  const idleLandmarks = gpu.device.createBuffer({
    size: LANDMARK_POINTS_BUFFER_BYTES,
    usage: ['storage', 'copy_dst'],
    label: `${label}-landmarks-idle`,
  });

  let frameTexture = createFrameTexture(gpu, label, sourceWidth, sourceHeight);
  // Clamped so the 9-tap kernel cannot wrap the frame's own edge into the frost,
  // and so a rotated crop at the frame border does not fold the far side in.
  const sampler = createSampler(gpu, {
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  let frostA = createFrostTarget(gpu, label, sourceWidth, sourceHeight, fog, 'a');
  let frostB = createFrostTarget(gpu, label, sourceWidth, sourceHeight, fog, 'b');

  const crop: Compute = createCompute(gpu, handCropWgsl, { label: `${label}-crop` });
  const hand: Compute = createCompute(gpu, handWgsl, { label: `${label}-hand` });
  const paint: Compute = createCompute(gpu, paintWgsl, { label: `${label}-paint` });
  // Two instances of one shader: the horizontal pass downsamples out of the
  // full-resolution camera texture, the vertical pass runs target-to-target.
  const frostH: Effect = createEffect(gpu, frostWgsl, { label: `${label}-frost-h` });
  const frostV: Effect = createEffect(gpu, frostWgsl, { label: `${label}-frost-v` });
  const composite: Effect = createEffect(gpu, compositeWgsl, { label: `${label}-composite` });

  const roiScratch = new Float32Array(ROI_STRIDE_FLOATS);

  const writeRoi = (slot: number, roi: HandRoi) => {
    if (!Number.isInteger(slot) || slot < 0 || slot >= ROI_SLOT_COUNT) {
      throw new Error(`ROI slot ${slot} is out of range (0..${ROI_SLOT_COUNT - 1}).`);
    }
    roiScratch[0] = roi.cx;
    roiScratch[1] = roi.cy;
    roiScratch[2] = roi.size;
    roiScratch[3] = roi.rotation;
    rois.write(asWriteData(roiScratch), slot * ROI_STRIDE_FLOATS * 4);
  };

  /** The detector always crops the whole frame, so its ROI only moves on resize. */
  const writeDetectorRoi = () => {
    writeRoi(ROI_DETECTOR_SLOT, detectorRoi(sourceWidth, sourceHeight));
  };
  writeDetectorRoi();

  const dispatchCrop = (roiIndex: number, outSize: number, out: Buffer) => {
    crop.set({
      crop: {
        source: [sourceWidth, sourceHeight],
        out_size: outSize,
        roi_index: roiIndex,
      },
      src: frameTexture,
      samp: sampler,
      rois,
      out_buf: out,
    });
    const groups = Math.ceil(outSize / CROP_WORKGROUP_SIZE);
    crop.dispatch(groups, groups);
  };

  const pipeline: VisualPipeline = {
    get sourceWidth() {
      return sourceWidth;
    },
    get sourceHeight() {
      return sourceHeight;
    },
    mask,
    brushes,
    rois,
    detectorInput,
    get frameTexture() {
      return frameTexture;
    },

    landmarkInput(slot) {
      const buffer = landmarkInputs[slot];
      if (!buffer) throw new Error(`Landmark slot ${slot} is out of range.`);
      return buffer;
    },

    writeRoi,

    cropDetectorInput() {
      dispatchCrop(ROI_DETECTOR_SLOT, DETECTOR_SIZE, detectorInput);
    },

    cropLandmarkInput(slot) {
      const buffer = landmarkInputs[slot];
      if (!buffer) throw new Error(`Landmark slot ${slot} is out of range.`);
      dispatchCrop(slot, LANDMARK_SIZE, buffer);
    },

    consumeHandLandmarks(results, dtSeconds, consumeOptions = {}) {
      const presence = [0, 0];
      const ran = [0, 0];
      const buffers: (Buffer | undefined)[] = [undefined, undefined];
      for (const result of results) {
        const slot = results.indexOf(result);
        if (slot < 0 || slot >= MAX_HANDS) continue;
        if (!result.landmarks) continue;
        buffers[slot] = result.landmarks;
        presence[slot] = Number.isFinite(result.presence) ? result.presence : 0;
        ran[slot] = 1;
      }

      hand.set({
        uniforms: {
          source: [sourceWidth, sourceHeight],
          presence,
          ran,
          dt: dtSeconds,
          enter_confidence: tuning.enterConfidence,
          stay_confidence: tuning.stayConfidence,
          ema_tau: tuning.emaTauSeconds,
          max_jump: maxJumpDistance(tuning),
          reset: consumeOptions.reset ? 1 : 0,
          crop_size: LANDMARK_SIZE,
          loopback_scale: ROI_LOOPBACK_SCALE,
        },
        lm0: buffers[0] ?? idleLandmarks,
        lm1: buffers[1] ?? idleLandmarks,
        rois,
        brushes,
      });
      // One workgroup of BRUSH_COUNT invocations: one independent hand each.
      hand.dispatch(1);

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
      // Submitted after the hand dispatch on the same queue, so the ordering is
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
          texel_size: [1 / sourceWidth, 1 / sourceHeight],
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
          source_size: [sourceWidth, sourceHeight],
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
      runFrame(gpu, (frame) => {
        frame.pass({ target: frostA }, (pass) => pass.draw(frostH));
        frame.pass({ target: frostB }, (pass) => pass.draw(frostV));
        frame.pass({ target: output }, (pass) => pass.draw(composite));
      });
    },

    writeFrame(rgba) {
      const expected = sourceWidth * sourceHeight * 4;
      if (rgba.byteLength !== expected) {
        throw new Error(
          `Frame upload expects ${expected} bytes for ${sourceWidth}x${sourceHeight}, received ${rgba.byteLength}.`,
        );
      }
      gpu.gpu.queue.writeTexture(
        { texture: frameTexture.gpu },
        asWriteData(rgba),
        { bytesPerRow: sourceWidth * 4, rowsPerImage: sourceHeight },
        { width: sourceWidth, height: sourceHeight },
      );
    },

    copyExternalFrame(source) {
      gpu.gpu.queue.copyExternalImageToTexture(
        { source },
        { texture: frameTexture.gpu },
        { width: sourceWidth, height: sourceHeight },
      );
    },

    clearMask() {
      mask.write(new Uint8Array(MASK_BYTES));
      // Continuity is dropped by the next consumeHandLandmarks({ reset: true });
      // the brush position itself is deliberately preserved so tracking survives.
    },

    resizeSource(nextWidth, nextHeight) {
      if (!(nextWidth > 0) || !(nextHeight > 0)) return;
      if (nextWidth === sourceWidth && nextHeight === sourceHeight) return;
      sourceWidth = nextWidth;
      sourceHeight = nextHeight;
      const previous = frameTexture;
      frameTexture = createFrameTexture(gpu, label, sourceWidth, sourceHeight);
      previous.destroy();
      // The frost chain is sized off the camera, so it has to follow.
      const previousA = frostA;
      const previousB = frostB;
      frostA = createFrostTarget(gpu, label, sourceWidth, sourceHeight, fog, 'a');
      frostB = createFrostTarget(gpu, label, sourceWidth, sourceHeight, fog, 'b');
      destroyTarget(previousA);
      destroyTarget(previousB);
      // The detector's letterbox is defined by the frame, so it moves with it.
      // Hand ROIs are in source pixels and are left alone: the host reacquires
      // them from the detector rather than trying to rescale a stale crop.
      writeDetectorRoi();
      // The mask keeps its strokes: it lives in normalized brush space, so a
      // camera resolution change does not invalidate what the user wiped.
    },

    dispose() {
      destroyTarget(frostB);
      destroyTarget(frostA);
      frameTexture.destroy();
      idleLandmarks.dispose();
      for (const buffer of landmarkInputs) buffer.dispose();
      detectorInput.dispose();
      rois.dispose();
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
  sourceWidth: number,
  sourceHeight: number,
  fog: FogTuning,
  suffix: string,
): Target {
  const divisor = Math.max(1, Math.floor(fog.blurDownsample));
  const width = Math.max(1, Math.ceil(sourceWidth / divisor));
  const height = Math.max(1, Math.ceil(sourceHeight / divisor));
  return createTarget(gpu, {
    size: [width, height],
    format: 'rgba8unorm',
    label: `${label}-frost-${suffix}`,
  });
}

/** `Target` does not declare `destroy()` on the public interface; it has one. */
function destroyTarget(target: Target | undefined): void {
  (target as { destroy?: () => void } | undefined)?.destroy?.();
}

function createFrameTexture(
  gpu: Gpu,
  label: string,
  sourceWidth: number,
  sourceHeight: number,
): Texture {
  return gpu.device.createTexture({
    size: [sourceWidth, sourceHeight],
    format: 'rgba8unorm',
    usage: ['texture_binding', 'copy_dst', 'render_attachment'],
    label: `${label}-frame`,
  });
}
