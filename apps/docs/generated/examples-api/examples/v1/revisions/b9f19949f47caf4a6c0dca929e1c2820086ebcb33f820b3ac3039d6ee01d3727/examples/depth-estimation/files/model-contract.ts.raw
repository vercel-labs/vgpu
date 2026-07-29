/**
 * The three selectable depth models, and the one presentation contract that
 * makes them interchangeable to the shader.
 *
 * Each network disagrees with the others about almost everything: input size,
 * how pixels are normalized, the rank of the output, and even what the numbers
 * mean. FastDepth predicts metric distance in metres (bigger = farther), while
 * MiDaS and Depth Anything predict *relative inverse* depth on an arbitrary
 * per-scene scale (bigger = nearer). This module is where that ends: everything
 * downstream consumes a flat row-major `array<f32>` plus a `Presentation` that
 * says how to turn it into normalized nearness in `[0,1]`, 1 = closest.
 *
 * This module is pure and ORT-free so the contract can be unit tested.
 */

export type DepthModelId = 'fastdepth-320x256' | 'midas-v21-small-256' | 'dav2-small';

/** How input pixels must be scaled before they reach the graph. */
export type Normalization = 'rgb255' | 'imagenet';

/** What the output numbers mean. */
export type DepthSemantics = 'metric' | 'inverse';

/**
 * How the shader turns raw output into nearness.
 *
 * - `log-metric` maps absolute metres through a fixed logarithmic range. It is
 *   stable frame to frame precisely because it is fixed, which is what keeps an
 *   animated scene from pumping.
 * - `auto-range` rescales by the minimum and maximum of the current output.
 *   Relative models have no absolute scale, so there is nothing fixed to map
 *   against. The range is reduced ON THE GPU (see `reduce-range.wgsl`); reading
 *   the tensor back to the CPU to compute it would defeat the entire point of
 *   the example.
 */
export type Presentation =
  | { readonly mode: 'log-metric'; readonly nearMeters: number; readonly farMeters: number }
  | { readonly mode: 'auto-range' };

/** Numeric encoding of `Presentation.mode` for the shader uniform. */
export const PRESENTATION_LOG_METRIC = 0;
export const PRESENTATION_AUTO_RANGE = 1;

export interface DepthModel {
  readonly id: DepthModelId;
  /** Shown in the picker. Deliberately just the name; sizes come from `bytes`. */
  readonly label: string;
  /** Same-origin URL; staged by `scripts/prepare-depth-models.mjs`. */
  readonly url: string;
  readonly bytes: number;
  /** Model input width/height in pixels. */
  readonly width: number;
  readonly height: number;
  readonly inputName: string;
  readonly outputName: string;
  /** NCHW input dims. */
  readonly inputDims: readonly [number, number, number, number];
  /** Output dims exactly as the graph declares them (rank 3 or 4). */
  readonly outputDims: readonly number[];
  readonly normalization: Normalization;
  readonly semantics: DepthSemantics;
  readonly presentation: Presentation;
  readonly license: string;
}

export const DEPTH_MODELS: readonly DepthModel[] = [
  {
    id: 'fastdepth-320x256',
    label: 'FastDepth',
    url: '/models/depth/fastdepth-320x256.onnx',
    bytes: 5420454,
    width: 320,
    height: 256,
    inputName: 'input.1',
    outputName: '424',
    inputDims: [1, 3, 256, 320],
    outputDims: [1, 1, 256, 320],
    normalization: 'rgb255',
    semantics: 'metric',
    // Indoor domain: NYU Depth v2 is furniture-scale, so 0.35 m to 10 m covers
    // the useful range and the log curve spends resolution where objects are.
    // Indoor band. A wider range would be safer in the abstract but wastes most
    // of the ramp on distances a room does not contain, which leaves the depth
    // panel a flat mid-grey; this model's output on interior scenes sits at
    // roughly 1-8 m. Fixed rather than per-frame so the image does not pump as
    // the camera moves.
    presentation: { mode: 'log-metric', nearMeters: 0.6, farMeters: 8 },
    license: 'MIT',
  },
  {
    id: 'midas-v21-small-256',
    label: 'MiDaS v2.1 small',
    url: '/models/depth/midas-v21-small-256.onnx',
    bytes: 66764249,
    width: 256,
    height: 256,
    inputName: '0',
    outputName: '797',
    inputDims: [1, 3, 256, 256],
    outputDims: [1, 256, 256],
    // NOT a mistake: this graph starts with Sub(ImageNet mean) / Div(ImageNet
    // std) on its own input, so it must be fed plain rgb/255. Normalizing here
    // as well would apply ImageNet twice and quietly wreck the output.
    normalization: 'rgb255',
    semantics: 'inverse',
    presentation: { mode: 'auto-range' },
    license: 'MIT',
  },
  {
    id: 'dav2-small',
    label: 'Depth Anything V2 small',
    url: '/models/depth/dav2-small.onnx',
    bytes: 99060839,
    // ViT-S/14 needs both sides to be multiples of 14; 560x448 is also exactly
    // the 5:4 of the source crop, so no aspect distortion is introduced.
    width: 560,
    height: 448,
    inputName: 'pixel_values',
    outputName: 'predicted_depth',
    inputDims: [1, 3, 448, 560],
    outputDims: [1, 448, 560],
    normalization: 'imagenet',
    semantics: 'inverse',
    presentation: { mode: 'auto-range' },
    license: 'Apache-2.0',
  },
];

export const DEFAULT_MODEL_ID: DepthModelId = 'fastdepth-320x256';

export function getDepthModel(id: DepthModelId): DepthModel {
  const model = DEPTH_MODELS.find((entry) => entry.id === id);
  if (!model) throw new Error(`Unknown depth model: ${id}`);
  return model;
}

/** Row-major scalar count of one depth result. */
export function depthElementCount(model: DepthModel): number {
  return model.width * model.height;
}

/** Byte size of one depth result; the wrapped GPU buffer is at least this big. */
export function depthByteLength(model: DepthModel): number {
  return depthElementCount(model) * 4;
}

/** ImageNet statistics, applied only by models that do not bake them in. */
export const IMAGENET_MEAN: readonly [number, number, number] = [0.485, 0.456, 0.406];
export const IMAGENET_STD: readonly [number, number, number] = [0.229, 0.224, 0.225];

/**
 * Reference implementation of the shader's nearness mapping.
 *
 * `relief.wgsl` reimplements this in WGSL; the tests assert the two agree on
 * the semantics (metric depth inverts, relative depth does not) so a change to
 * one without the other is caught.
 */
export function nearnessFor(
  presentation: Presentation,
  value: number,
  range?: { min: number; max: number },
): number {
  const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
  if (presentation.mode === 'log-metric') {
    const { nearMeters, farMeters } = presentation;
    const far = Math.log(farMeters / nearMeters);
    const scaled = Math.log(Math.max(value, nearMeters) / nearMeters) / far;
    // Metric depth grows with distance, so nearness is its complement.
    return 1 - clamp01(scaled);
  }
  const min = range?.min ?? 0;
  const max = range?.max ?? 1;
  const span = max - min;
  // Relative inverse depth already grows towards the camera.
  return span > 1e-9 ? clamp01((value - min) / span) : 0;
}
