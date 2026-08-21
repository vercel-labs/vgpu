/**
 * Evidence collection for the Node GPU tests.
 *
 * Nothing in the browser imports this. It renders the same deterministic mesh,
 * wall and glass passes into a readable target so the physical and visual
 * invariants can be measured rather than asserted by eye.
 */

import type { Gpu, Target } from 'vgpu';

import { cameraView } from './camera';
import { prismMeshData } from './prism-mesh';
import {
  createScene,
  destroyScene,
  prepareScene,
  presentScene,
  setControls,
  setLampArc,
  setOrbit,
} from './scene';
import type { PrismControls } from './types';

const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

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

/** Renders the final deterministic composite into `output` in one frame. */
export async function renderComposite(
  gpu: Gpu,
  output: Target,
  options: CompositeOptions = {},
): Promise<void> {
  const scene = createScene(gpu, output.size, 'prism-rainbow-composite');
  try {
    if (options.controls) setControls(scene, options.controls);
    if (options.lampArc !== undefined) setLampArc(scene, options.lampArc);
    if (options.orbit) setOrbit(scene, options.orbit[0], options.orbit[1]);
    await prepareScene(scene, output);
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
