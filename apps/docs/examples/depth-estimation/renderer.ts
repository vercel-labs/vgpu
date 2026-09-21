import type { Buffer, Compute, Effect, Gpu, Surface, Target } from "vgpu";
import { compute, effect, frame } from "vgpu";
import reduceRangeWgsl from "./reduce-range.wgsl";
import sideBySideWgsl from "./side-by-side.wgsl";

export const DEPTH_MODELS = [
  {
    id: "fastdepth-320x256",
    label: "FastDepth · 5.2 MiB",
    url: "/models/depth/fastdepth-320x256.onnx",
    width: 320,
    height: 256,
    inputName: "input.1",
    outputName: "424",
    outputDims: [1, 1, 256, 320],
    normalization: "rgb255",
    presentation: { mode: "log-metric", nearMeters: 0.6, farMeters: 8 },
  },
  {
    id: "midas-v21-small-256",
    label: "MiDaS v2.1 small · 63.7 MiB",
    url: "/models/depth/midas-v21-small-256.onnx",
    width: 256,
    height: 256,
    inputName: "0",
    outputName: "797",
    outputDims: [1, 256, 256],
    // This graph applies ImageNet normalization internally.
    normalization: "rgb255",
    presentation: { mode: "auto-range" },
  },
  {
    id: "dav2-small",
    label: "Depth Anything V2 small · 94.5 MiB",
    url: "/models/depth/dav2-small.onnx",
    width: 560,
    height: 448,
    inputName: "pixel_values",
    outputName: "predicted_depth",
    outputDims: [1, 448, 560],
    normalization: "imagenet",
    presentation: { mode: "auto-range" },
  },
] as const;

export type DepthModel = (typeof DEPTH_MODELS)[number];
export type DepthModelId = DepthModel["id"];

export const DEFAULT_MODEL_ID: DepthModelId = "fastdepth-320x256";

export function getDepthModel(id: DepthModelId): DepthModel {
  const model = DEPTH_MODELS.find((entry) => entry.id === id);
  if (!model) throw new Error(`Unknown depth model: ${id}`);
  return model;
}

export function coverCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
) {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error(`Invalid source size ${sourceWidth}x${sourceHeight}.`);
  }
  if (targetWidth <= 0 || targetHeight <= 0) {
    throw new Error(`Invalid target size ${targetWidth}x${targetHeight}.`);
  }
  const targetAspect = targetWidth / targetHeight;
  let sw = sourceWidth;
  let sh = sourceHeight;
  if (sourceWidth / sourceHeight > targetAspect)
    sw = Math.round(sh * targetAspect);
  else sh = Math.round(sw / targetAspect);
  return {
    sx: Math.round((sourceWidth - sw) / 2),
    sy: Math.round((sourceHeight - sh) / 2),
    sw,
    sh,
  };
}

const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

export function rgbaToNchw(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  normalization: DepthModel["normalization"]
): Float32Array {
  const pixels = width * height;
  if (rgba.length < pixels * 4) {
    throw new Error(
      `Expected ${pixels * 4} RGBA bytes for ${width}x${height}, got ${
        rgba.length
      }.`
    );
  }
  const output = new Float32Array(pixels * 3);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = rgba[pixel * 4 + channel]! / 255;
      output[channel * pixels + pixel] =
        normalization === "imagenet"
          ? (value - IMAGENET_MEAN[channel]!) / IMAGENET_STD[channel]!
          : value;
    }
  }
  return output;
}

export function createPreprocessScratch(width: number, height: number) {
  const canvas =
    typeof OffscreenCanvas === "undefined"
      ? Object.assign(document.createElement("canvas"), { width, height })
      : new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!context)
    throw new Error("depth-estimation: 2D canvas context is unavailable.");
  return { canvas, context };
}

export type PreprocessScratch = ReturnType<typeof createPreprocessScratch>;

export function preprocessDepthSource(
  source: CanvasImageSource,
  model: DepthModel,
  scratch: PreprocessScratch
) {
  const video =
    typeof HTMLVideoElement !== "undefined" &&
    source instanceof HTMLVideoElement;
  const image =
    typeof HTMLImageElement !== "undefined" &&
    source instanceof HTMLImageElement;
  const sourceWidth = video
    ? source.videoWidth
    : image
    ? source.naturalWidth
    : Number((source as { width?: number }).width ?? 0);
  const sourceHeight = video
    ? source.videoHeight
    : image
    ? source.naturalHeight
    : Number((source as { height?: number }).height ?? 0);
  if (!sourceWidth || !sourceHeight) {
    throw new Error("depth-estimation: source has no intrinsic size yet.");
  }

  const { sx, sy, sw, sh } = coverCrop(
    sourceWidth,
    sourceHeight,
    model.width,
    model.height
  );
  const { canvas, context } = scratch;
  if (canvas.width !== model.width || canvas.height !== model.height) {
    canvas.width = model.width;
    canvas.height = model.height;
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, sx, sy, sw, sh, 0, 0, model.width, model.height);
  const { data } = context.getImageData(0, 0, model.width, model.height);
  return {
    nchw: rgbaToNchw(data, model.width, model.height, model.normalization),
    rgba: data,
  };
}

function bytes(
  view: Float32Array | Uint32Array | Uint8ClampedArray
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    view.buffer as ArrayBuffer,
    view.byteOffset,
    view.byteLength
  );
}

export function createSideBySidePipeline(gpu: Gpu, label = "depth-estimation") {
  const view: Effect = effect(gpu, sideBySideWgsl, { label: `${label}-view` });
  const reducer: Compute = compute(gpu, reduceRangeWgsl, {
    label: `${label}-range`,
  });
  const range = gpu.device.createBuffer({
    size: 8,
    usage: ["storage", "copy_dst"],
    label: `${label}-range`,
  });

  return {
    draw(
      currentGpu: Gpu,
      output: Surface | Target,
      depth: Buffer,
      colour: Buffer,
      model: DepthModel,
      { hasResult = true } = {}
    ) {
      const autoRange = model.presentation.mode === "auto-range";
      if (hasResult && autoRange) {
        range.write(bytes(new Uint32Array([0xffffffff, 0])));
        reducer.set({
          uniforms: { count: model.width * model.height },
          depth,
          range,
        });
        reducer.dispatch(1);
      }
      view.set({
        uniforms: {
          resolution: output.size,
          depth_size: [model.width, model.height],
          mode: autoRange ? 1 : 0,
          near_meters:
            model.presentation.mode === "log-metric"
              ? model.presentation.nearMeters
              : 0.35,
          far_meters:
            model.presentation.mode === "log-metric"
              ? model.presentation.farMeters
              : 10,
          has_result: hasResult ? 1 : 0,
        },
        depth,
        range,
        colour,
      });
      frame(currentGpu, (current) =>
        current.pass({ target: output }, (pass) => pass.draw(view))
      );
    },
    dispose: () => range.dispose(),
  };
}

export type SideBySidePipeline = ReturnType<typeof createSideBySidePipeline>;

export function createDepthBuffer(
  gpu: Gpu,
  model: DepthModel,
  label = "depth-estimation"
) {
  return gpu.device.createBuffer({
    size: model.width * model.height * 4,
    usage: ["storage", "copy_dst"],
    label: `${label}-depth`,
  });
}

export function createColourBuffer(
  gpu: Gpu,
  model: DepthModel,
  label = "depth-estimation"
) {
  return gpu.device.createBuffer({
    size: model.width * model.height * 4,
    usage: ["storage", "copy_dst"],
    label: `${label}-colour`,
  });
}

export const writeDepth = (buffer: Buffer, values: Float32Array) =>
  buffer.write(bytes(values));
export const writeColour = (buffer: Buffer, values: Uint8ClampedArray) =>
  buffer.write(bytes(values));
