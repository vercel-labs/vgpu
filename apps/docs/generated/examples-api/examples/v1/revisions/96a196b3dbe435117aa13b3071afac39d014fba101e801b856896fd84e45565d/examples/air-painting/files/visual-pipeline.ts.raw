import {
  compute,
  effect,
  frame,
  sampler,
  target,
  type Buffer,
  type Gpu,
  type Surface,
  type Target,
  type Texture,
} from "vgpu";

import {
  DETECTOR_INPUT_BYTES,
  DETECTOR_SIZE,
  LANDMARK_INPUT_BYTES,
  LANDMARK_POINTS_BUFFER_BYTES,
  LANDMARK_SIZE,
  MAX_HANDS,
} from "./hand-model-contract";
import type { HandRoi } from "./hand-pipeline";
import compositeWgsl from "./composite.wgsl";
import frostWgsl from "./frost.wgsl";
import handWgsl from "./hand.wgsl";
import handCropWgsl from "./hand-crop.wgsl";
import paintWgsl from "./paint.wgsl";

export const MASK_WIDTH = 960;
export const MASK_HEIGHT = 540;
export const MASK_TEXELS = MASK_WIDTH * MASK_HEIGHT;
export const MASK_BYTES = MASK_TEXELS * 4;
export const BRUSH_BUFFER_BYTES = 40 * MAX_HANDS;
const ROI_SLOT_COUNT = MAX_HANDS + 1;
const ROI_STRIDE_FLOATS = 4;
export const ROI_BYTES = ROI_SLOT_COUNT * ROI_STRIDE_FLOATS * 4;
export const ROI_DETECTOR_SLOT = MAX_HANDS;

const PAINT_WORKGROUPS = Math.ceil(MASK_TEXELS / 64);
const CROP_WORKGROUP_SIZE = 8;

export interface HandResultInput {
  readonly landmarks?: Buffer;
  readonly presence: number;
}

interface VisualFrameOptions {
  readonly dpr?: number;
  readonly hasFrame?: boolean;
  readonly showCursor?: boolean;
}

type Owned = {
  dispose?: () => void;
  destroy?: () => void;
};

function bytes(view: Float32Array | Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    view.buffer as ArrayBuffer,
    view.byteOffset,
    view.byteLength
  );
}

export function createLandmarkBuffer(
  gpu: Gpu,
  label = "air-painting",
  slot = 0
): Buffer {
  return gpu.device.createBuffer({
    size: LANDMARK_POINTS_BUFFER_BYTES,
    usage: ["storage", "copy_dst"],
    label: `${label}-landmarks-${slot}`,
  });
}

export function writeLandmarks(buffer: Buffer, landmarks: Float32Array): void {
  buffer.write(bytes(landmarks));
}

export function createVisualPipeline(
  gpu: Gpu,
  options: {
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly label?: string;
  }
) {
  const label = options.label ?? "air-painting";
  let sourceWidth = options.sourceWidth;
  let sourceHeight = options.sourceHeight;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new Error(
      `Frame size must be positive, received ${sourceWidth}x${sourceHeight}.`
    );
  }

  const owned: Owned[] = [];
  const own = <T extends Owned>(resource: T): T => {
    owned.push(resource);
    return resource;
  };
  const release = (resource: Owned) => {
    const index = owned.indexOf(resource);
    if (index < 0) return;
    owned.splice(index, 1);
    if (resource.dispose) resource.dispose();
    else resource.destroy?.();
  };
  const releaseMany = (resources: readonly Owned[]) => {
    let failure: unknown;
    for (const resource of resources) {
      try {
        release(resource);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
  const releaseAll = () => releaseMany([...owned].reverse());
  const createBuffer = (
    suffix: string,
    size: number,
    usage: ("storage" | "copy_src" | "copy_dst")[] = ["storage", "copy_dst"]
  ) =>
    own(
      gpu.device.createBuffer({
        size,
        usage,
        label: `${label}-${suffix}`,
      })
    );

  try {
    const mask = createBuffer("mask", MASK_BYTES);
    const brushes = createBuffer("brushes", BRUSH_BUFFER_BYTES);
    const rois = createBuffer("rois", ROI_BYTES);
    const detectorInput = createBuffer("detector-input", DETECTOR_INPUT_BYTES, [
      "storage",
      "copy_src",
      "copy_dst",
    ]);
    const landmarkInputs = Array.from({ length: MAX_HANDS }, (_, slot) =>
      createBuffer(`landmark-input-${slot}`, LANDMARK_INPUT_BYTES, [
        "storage",
        "copy_src",
        "copy_dst",
      ])
    );
    const idleLandmarks = createBuffer(
      "landmarks-idle",
      LANDMARK_POINTS_BUFFER_BYTES
    );
    let frameTexture = own(
      createFrameTexture(gpu, label, sourceWidth, sourceHeight)
    );
    let frostA = own(
      createFrostTarget(gpu, label, sourceWidth, sourceHeight, "a")
    );
    let frostB = own(
      createFrostTarget(gpu, label, sourceWidth, sourceHeight, "b")
    );
    const linearSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const crop = compute(gpu, handCropWgsl, { label: `${label}-crop` });
    const hand = compute(gpu, handWgsl, { label: `${label}-hand` });
    const paint = compute(gpu, paintWgsl, { label: `${label}-paint` });
    const frostH = effect(gpu, frostWgsl, { label: `${label}-frost-h` });
    const frostV = effect(gpu, frostWgsl, { label: `${label}-frost-v` });
    const composite = effect(gpu, compositeWgsl, {
      label: `${label}-composite`,
    });
    const roiScratch = new Float32Array(ROI_STRIDE_FLOATS);

    const writeRoi = (slot: number, roi: HandRoi) => {
      if (!Number.isInteger(slot) || slot < 0 || slot >= ROI_SLOT_COUNT) {
        throw new Error(
          `ROI slot ${slot} is out of range (0..${ROI_SLOT_COUNT - 1}).`
        );
      }
      roiScratch.set([roi.cx, roi.cy, roi.size, roi.rotation]);
      rois.write(bytes(roiScratch), slot * ROI_STRIDE_FLOATS * 4);
    };
    const writeDetectorRoi = () => {
      writeRoi(ROI_DETECTOR_SLOT, {
        cx: sourceWidth / 2,
        cy: sourceHeight / 2,
        size: Math.max(sourceWidth, sourceHeight),
        rotation: 0,
      });
    };
    const dispatchCrop = (
      roiIndex: number,
      outSize: number,
      output: Buffer
    ) => {
      crop.set({
        crop: {
          source: [sourceWidth, sourceHeight],
          out_size: outSize,
          roi_index: roiIndex,
        },
        src: frameTexture,
        samp: linearSampler,
        rois,
        out_buf: output,
      });
      const groups = Math.ceil(outSize / CROP_WORKGROUP_SIZE);
      crop.dispatch(groups, groups);
    };
    writeDetectorRoi();

    return {
      get sourceWidth() {
        return sourceWidth;
      },
      get sourceHeight() {
        return sourceHeight;
      },
      detectorInput,
      landmarkInput(slot: number) {
        const buffer = landmarkInputs[slot];
        if (!buffer) throw new Error(`Landmark slot ${slot} is out of range.`);
        return buffer;
      },
      writeRoi,
      cropDetectorInput() {
        dispatchCrop(ROI_DETECTOR_SLOT, DETECTOR_SIZE, detectorInput);
      },
      cropLandmarkInput(slot: number) {
        const buffer = landmarkInputs[slot];
        if (!buffer) throw new Error(`Landmark slot ${slot} is out of range.`);
        dispatchCrop(slot, LANDMARK_SIZE, buffer);
      },
      consumeHandLandmarks(
        results: readonly HandResultInput[],
        dtSeconds: number,
        options: { readonly reset?: boolean } = {}
      ) {
        const presence = [0, 0];
        const ran = [0, 0];
        const buffers: (Buffer | undefined)[] = [];
        for (let slot = 0; slot < Math.min(results.length, MAX_HANDS); slot++) {
          const result = results[slot];
          if (!result?.landmarks) continue;
          buffers[slot] = result.landmarks;
          presence[slot] = Number.isFinite(result.presence)
            ? result.presence
            : 0;
          ran[slot] = 1;
        }
        hand.set({
          uniforms: {
            source: [sourceWidth, sourceHeight],
            presence,
            ran,
            dt: dtSeconds,
            enter_confidence: 0.45,
            stay_confidence: 0.3,
            ema_tau: 0.075,
            max_jump: 0.18 * Math.SQRT2,
            reset: options.reset ? 1 : 0,
            crop_size: LANDMARK_SIZE,
            loopback_scale: 2,
          },
          lm0: buffers[0] ?? idleLandmarks,
          lm1: buffers[1] ?? idleLandmarks,
          rois,
          brushes,
        });
        hand.dispatch(1);
        paint.set({
          uniforms: {
            mask_size: [MASK_WIDTH, MASK_HEIGHT],
            radius: 30,
            feather: 4,
            decay: Math.exp(-Math.min(Math.max(dtSeconds, 0), 0.25) / 7),
            clear_epsilon: 1 / 255,
          },
          brushes,
          mask,
        });
        paint.dispatch(PAINT_WORKGROUPS);
      },
      renderVisualFrame(
        output: Surface | Target,
        options: VisualFrameOptions = {}
      ) {
        const dpr = Math.min(2, Math.max(1, options.dpr ?? 1));
        frostH.set({
          src: frameTexture,
          samp: linearSampler,
          frost: {
            texel_size: [1 / sourceWidth, 1 / sourceHeight],
            direction: [1, 0],
            sigma: 2.2,
          },
        });
        frostV.set({
          src: frostA.color,
          samp: linearSampler,
          frost: {
            texel_size: frostA.texelSize,
            direction: [0, 1],
            sigma: 2.2,
          },
        });
        composite.set({
          uniforms: {
            resolution: output.size,
            mask_size: [MASK_WIDTH, MASK_HEIGHT],
            source_size: [sourceWidth, sourceHeight],
            has_frame: options.hasFrame === false ? 0 : 1,
            show_cursor: options.showCursor === false ? 0 : 1,
            cursor_radius: 36,
            frost_lift: 0.1,
            frost_grain: 0.022,
            grain_cell: 4 * dpr,
          },
          frame_tex: frameTexture,
          frame_samp: linearSampler,
          mask,
          brushes,
          frost_tex: frostB.color,
        });
        frame(gpu, (currentFrame) => {
          currentFrame.pass({ target: frostA }, (pass) => pass.draw(frostH));
          currentFrame.pass({ target: frostB }, (pass) => pass.draw(frostV));
          currentFrame.pass({ target: output }, (pass) => pass.draw(composite));
        });
      },
      writeFrame(rgba: Uint8Array) {
        const expected = sourceWidth * sourceHeight * 4;
        if (rgba.byteLength !== expected) {
          throw new Error(
            `Frame upload expects ${expected} bytes for ${sourceWidth}x${sourceHeight}, received ${rgba.byteLength}.`
          );
        }
        gpu.gpu.queue.writeTexture(
          { texture: frameTexture.gpu },
          bytes(rgba),
          { bytesPerRow: sourceWidth * 4, rowsPerImage: sourceHeight },
          { width: sourceWidth, height: sourceHeight }
        );
      },
      copyExternalFrame(source: GPUCopyExternalImageSource) {
        gpu.gpu.queue.copyExternalImageToTexture(
          { source },
          { texture: frameTexture.gpu },
          { width: sourceWidth, height: sourceHeight }
        );
      },
      clearMask() {
        mask.write(new Uint8Array(MASK_BYTES));
      },
      resizeSource(nextWidth: number, nextHeight: number) {
        if (!(nextWidth > 0) || !(nextHeight > 0)) return;
        if (nextWidth === sourceWidth && nextHeight === sourceHeight) return;
        let nextFrame: Texture | undefined;
        let nextA: Target | undefined;
        let nextB: Target | undefined;
        try {
          nextFrame = own(
            createFrameTexture(gpu, label, nextWidth, nextHeight)
          );
          nextA = own(
            createFrostTarget(gpu, label, nextWidth, nextHeight, "a")
          );
          nextB = own(
            createFrostTarget(gpu, label, nextWidth, nextHeight, "b")
          );
        } catch (error) {
          try {
            releaseMany([nextB, nextA, nextFrame].filter(Boolean) as Owned[]);
          } catch {}
          throw error;
        }
        const previous = [frostB, frostA, frameTexture];
        sourceWidth = nextWidth;
        sourceHeight = nextHeight;
        frameTexture = nextFrame;
        frostA = nextA;
        frostB = nextB;
        releaseMany(previous);
        writeDetectorRoi();
      },
      dispose: releaseAll,
    };
  } catch (error) {
    try {
      releaseAll();
    } catch {}
    throw error;
  }
}

export type VisualPipeline = ReturnType<typeof createVisualPipeline>;

function createFrostTarget(
  gpu: Gpu,
  label: string,
  sourceWidth: number,
  sourceHeight: number,
  suffix: string
): Target & Owned {
  return target(gpu, {
    size: [
      Math.max(1, Math.ceil(sourceWidth / 4)),
      Math.max(1, Math.ceil(sourceHeight / 4)),
    ],
    format: "rgba8unorm",
    label: `${label}-frost-${suffix}`,
  }) as Target & Owned;
}

function createFrameTexture(
  gpu: Gpu,
  label: string,
  sourceWidth: number,
  sourceHeight: number
): Texture {
  return gpu.device.createTexture({
    size: [sourceWidth, sourceHeight],
    format: "rgba8unorm",
    usage: ["texture_binding", "copy_dst", "render_attachment"],
    label: `${label}-frame`,
  });
}
