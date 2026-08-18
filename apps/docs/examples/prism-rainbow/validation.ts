/**
 * Evidence collection for the Node GPU tests.
 *
 * Nothing in the browser imports this. It renders `probe.wgsl` into an
 * `rgba32float` target and decodes the result, which is what lets a test compare
 * the shader's refraction, dispersion, sampling and connection numbers against
 * the CPU reference in `optics.ts` value by value instead of squinting at an
 * image. It also reads back the accumulation buffer, so convergence can be
 * measured rather than asserted.
 */

import type { Gpu, Target } from 'vgpu';
import { effect, frame, target } from 'vgpu';

import { cameraView } from './camera';
import { prismMeshData } from './prism-mesh';
import probeWgsl from './probe.wgsl';
import {
  createScene,
  destroyScene,
  prepareScene,
  presentScene,
  sceneUniforms,
  setControls,
  setLampArc,
  setOrbit,
  traceFrame,
} from './scene';
import type { PrismControls } from './types';

/** Rows written by `probe.wgsl`, in order. Keep in step with its header comment. */
export const PROBE_LAYOUT = ['ray', 'path', 'connection', 'radiance'] as const;
export const PROBE_SLOTS = 32;

export interface ProbeSlot {
  readonly slot: number;
  /** The room point this slot probes, as the shader computed it. */
  readonly point: readonly [number, number];
  /** Point on the prism's face the ray was aimed at. */
  readonly aim: readonly [number, number];
  readonly wavelength: number;
  readonly ior: number;
  /** Where the ray left the glass, and the unit direction it left with. */
  readonly exitOrigin: readonly [number, number];
  readonly exitDirection: readonly [number, number];
  readonly weight: number;
  readonly bounces: number;
  readonly valid: boolean;
  /** The full 16-ray estimate for this slot. */
  readonly radiance: readonly [number, number, number];
}

export interface ProbeOptions {
  readonly controls?: PrismControls;
  readonly lampArc?: number;
  readonly frameIndex?: number;
  /** Aspect the probe's scene mapping assumes; only used by `point`. */
  readonly aspect?: number;
}

/** Renders `probe.wgsl` and decodes every slot. */
export async function readProbe(gpu: Gpu, options: ProbeOptions = {}): Promise<readonly ProbeSlot[]> {
  const scene = createScene(gpu, [PROBE_SLOTS, PROBE_LAYOUT.length], 'prism-rainbow-probe');
  const output = target(gpu, {
    size: [PROBE_SLOTS, PROBE_LAYOUT.length],
    format: 'rgba32float',
    label: 'prism-rainbow-probe',
  });
  try {
    if (options.controls) setControls(scene, options.controls);
    if (options.lampArc !== undefined) setLampArc(scene, options.lampArc);
    if (options.aspect !== undefined) scene.aspect = options.aspect;
    scene.accumulated = options.frameIndex ?? 0;
    const probe = effect(gpu, probeWgsl, { label: 'prism-rainbow-probe' });
    probe.set({ scene: sceneUniforms(scene) });
    frame(gpu, (current) => {
      current.pass({ target: output }, (pass) => pass.draw(probe));
    });
    const floats = await output.readFloats();
    const row = (index: number, slot: number): readonly [number, number, number, number] => {
      const base = (index * PROBE_SLOTS + slot) * 4;
      return [floats[base]!, floats[base + 1]!, floats[base + 2]!, floats[base + 3]!];
    };
    const slots: ProbeSlot[] = [];
    for (let slot = 0; slot < PROBE_SLOTS; slot++) {
      const ray = row(0, slot);
      const path = row(1, slot);
      const connection = row(2, slot);
      const radiance = row(3, slot);
      slots.push({
        slot,
        point: [connection[3], radiance[3]],
        aim: [ray[0], ray[1]],
        wavelength: ray[2],
        ior: ray[3],
        exitOrigin: [path[0], path[1]],
        exitDirection: [path[2], path[3]],
        weight: connection[0],
        bounces: connection[1],
        valid: connection[2] > 0.5,
        radiance: [radiance[0], radiance[1], radiance[2]],
      });
    }
    return slots;
  } finally {
    (output as Target & { destroy?: () => void }).destroy?.();
    destroyScene(scene);
  }
}

export interface AccumulationStats {
  readonly frames: number;
  /** Mean luminance over the accumulation buffer. */
  readonly mean: number;
  /** Standard deviation of luminance between a pixel and its right neighbour. */
  readonly neighbourNoise: number;
  readonly max: number;
  readonly finite: boolean;
  readonly negative: number;
}

const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/**
 * Statistics of the accumulation buffer after `frames` traced frames.
 *
 * `neighbourNoise` is the interesting one: the caustic is a smooth field, so the
 * difference between neighbouring pixels is almost entirely Monte Carlo noise,
 * and watching it fall as frames accumulate is what proves the accumulation is
 * doing something. Comparing whole images frame to frame could not tell a
 * converging estimate from a frozen one.
 */
export async function accumulate(
  gpu: Gpu,
  size: readonly [number, number],
  frames: number,
  options: { readonly controls?: PrismControls; readonly lampArc?: number } = {},
): Promise<AccumulationStats> {
  const scene = createScene(gpu, size, 'prism-rainbow-accumulate');
  let floats: Float32Array;
  let width: number;
  let height: number;
  try {
    if (options.controls) setControls(scene, options.controls);
    if (options.lampArc !== undefined) setLampArc(scene, options.lampArc);
    for (let index = 0; index < frames; index++) traceFrame(scene);
    await gpu.gpu.queue.onSubmittedWorkDone();
    floats = await scene.accumulation.read.readFloats();
    [width, height] = scene.accumulation.read.size;
  } finally {
    destroyScene(scene);
  }
  let sum = 0;
  let max = 0;
  let negative = 0;
  let finite = true;
  let differenceSquares = 0;
  let differences = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * 4;
      const luma = LUMA[0] * floats[base]! + LUMA[1] * floats[base + 1]! + LUMA[2] * floats[base + 2]!;
      if (!Number.isFinite(luma)) finite = false;
      if (luma < -1e-6) negative++;
      sum += luma;
      max = Math.max(max, luma);
      if (x + 1 < width) {
        const right = (y * width + x + 1) * 4;
        const neighbour = LUMA[0] * floats[right]! + LUMA[1] * floats[right + 1]! + LUMA[2] * floats[right + 2]!;
        differenceSquares += (luma - neighbour) ** 2;
        differences++;
      }
    }
  }
  const pixels = width * height;
  return {
    frames,
    mean: sum / pixels,
    neighbourNoise: Math.sqrt(differenceSquares / Math.max(1, differences)),
    max,
    finite,
    negative,
  };
}

export interface RegionStats {
  readonly mean: readonly [number, number, number];
  readonly meanLuma: number;
  /** Fraction of pixels whose most and least intense channels differ by 35%. */
  readonly colorfulShare: number;
}

/** Averages a rectangle of an already-rendered target, in normalized coordinates. */
export async function regionStats(
  output: Target,
  region: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number },
): Promise<RegionStats> {
  const floats = await output.readFloats();
  const [width, height] = output.size;
  const from = [Math.floor(region.x0 * width), Math.floor(region.y0 * height)] as const;
  const to = [Math.ceil(region.x1 * width), Math.ceil(region.y1 * height)] as const;
  let r = 0;
  let g = 0;
  let b = 0;
  let colorful = 0;
  let count = 0;
  for (let y = from[1]; y < to[1]; y++) {
    for (let x = from[0]; x < to[0]; x++) {
      const base = (y * width + x) * 4;
      const pixel: readonly [number, number, number] = [floats[base]!, floats[base + 1]!, floats[base + 2]!];
      r += pixel[0];
      g += pixel[1];
      b += pixel[2];
      const top = Math.max(...pixel);
      if (top > 0.08 && (top - Math.min(...pixel)) / top > 0.35) colorful++;
      count++;
    }
  }
  const divisor = Math.max(1, count);
  const mean: readonly [number, number, number] = [r / divisor, g / divisor, b / divisor];
  return {
    mean,
    meanLuma: LUMA[0] * mean[0] + LUMA[1] * mean[1] + LUMA[2] * mean[2],
    colorfulShare: colorful / divisor,
  };
}

export interface CompositeOptions {
  readonly controls?: PrismControls;
  readonly lampArc?: number;
  /** Camera offset from centre, both components in [-1, 1]. */
  readonly orbit?: readonly [number, number];
}

/** Renders the composited picture into `output` after `frames` traced frames. */
export async function renderComposite(
  gpu: Gpu,
  output: Target,
  frames: number,
  options: CompositeOptions = {},
): Promise<void> {
  const scene = createScene(gpu, output.size, 'prism-rainbow-composite');
  try {
    if (options.controls) setControls(scene, options.controls);
    if (options.lampArc !== undefined) setLampArc(scene, options.lampArc);
    if (options.orbit) setOrbit(scene, options.orbit[0], options.orbit[1]);
    await prepareScene(scene, output);
    for (let index = 0; index < frames; index++) traceFrame(scene);
    presentScene(scene, output);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    destroyScene(scene);
  }
}

/**
 * Where the prism's silhouette lands on the frame, in normalized coordinates.
 *
 * The GPU tests need to look inside and outside the glass, and the whole point of
 * the restructure is that those are different places: the object is a solid in
 * front of the wall, so its outline on screen is its own projection and not the
 * triangle the tracer drew. Projecting the mesh with the same camera the frame
 * was rendered with is the only honest way to find it.
 */
export function prismSilhouette(
  aspect: number,
  orbit: readonly [number, number] = [0, 0],
): { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } {
  const { camera } = cameraView(aspect, orbit[0], orbit[1]);
  const matrix = camera.viewProjection;
  const { vertices } = prismMeshData();
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let index = 0; index < vertices.length; index += 6) {
    const [x, y, z] = [vertices[index]!, vertices[index + 1]!, vertices[index + 2]!];
    const clip = [0, 1, 3].map((row) =>
      matrix[row]! * x + matrix[4 + row]! * y + matrix[8 + row]! * z + matrix[12 + row]!);
    const w = Math.max(1e-6, clip[2]!);
    const u = (clip[0]! / w) * 0.5 + 0.5;
    const v = 0.5 - (clip[1]! / w) * 0.5;
    x0 = Math.min(x0, u);
    x1 = Math.max(x1, u);
    y0 = Math.min(y0, v);
    y1 = Math.max(y1, v);
  }
  return { x0, y0, x1, y1 };
}
