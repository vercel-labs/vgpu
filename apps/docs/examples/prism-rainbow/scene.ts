/**
 * Resource graph and frame schedule.
 *
 * Three things happen per frame, and only the first of them is expensive.
 *
 *  - `trace` casts the 16 rays per fragment into one half of a ping-pong pair
 *    while reading the other half, so each frame refines a running average of the
 *    light landing on the wall instead of replacing it. It works in the wall's own
 *    coordinates and knows nothing about the camera, which is why the estimate
 *    survives a moving view and only restarts when the optics change.
 *  - `wall` rasterizes that average onto a plane at `z = 0`, together with the
 *    wall's own shade and the direct beam, into an offscreen target.
 *  - `present` copies that target to the output and `glass` draws the extruded
 *    prism over it, refracting the copy underneath.
 *
 * The trace runs on a target narrower than the output because its cost is
 * per-fragment and the caustic it estimates is smooth. The wall samples it with a
 * filtering sampler, so the accumulation buffer's resolution trades noise for
 * frame time without changing the picture's framing.
 */

import type { Draw, Effect, Geometry, Gpu, PingPongTargets, Surface, Target } from 'vgpu';
import { draw, effect, frame, pingPong, sampler, target } from 'vgpu';

import { cameraView, rotationMatrix, wallHalfHeight, type CameraView } from './camera';
import glassWgsl from './glass.wgsl';
import presentWgsl from './present.wgsl';
import { prismGeometry } from './prism-mesh';
import traceWgsl from './trace.wgsl';
import wallWgsl from './wall.wgsl';
import {
  DEFAULT_PRISM_CONTROLS,
  PRISM_BACK_Z,
  PRISM_DEFAULT_ARC,
  PRISM_DISPERSION_PRESETS,
  PRISM_EXPOSURE,
  PRISM_FRONT_Z,
  PRISM_GLASS,
  PRISM_HAZE,
  PRISM_INCIDENCE_ARC,
  PRISM_MAX_INTERNAL_BOUNCES,
  PRISM_RAYS_PER_FRAGMENT,
  PRISM_TRIANGLE,
  PRISM_WAVELENGTHS,
  lampForIncidence,
  type PrismControls,
  type SpotLight,
} from './types';

type Output = Surface | Target;

/** The studio's orientation never changes, so its matrix is built once. */
const ENVIRONMENT_ROTATION = rotationMatrix(PRISM_GLASS.environmentRotation);

/** Longest edge the accumulation buffer is allowed to take. */
export const TRACE_MAX_EDGE = 640;
/** Fraction of the output resolution the accumulation buffer aims for. */
export const TRACE_SCALE = 0.6;

export interface PrismScene {
  readonly gpu: Gpu;
  /** Accumulation buffer size, not the output size. */
  size: readonly [number, number];
  accumulation: PingPongTargets;
  /**
   * The rasterized wall, drawn before the glass so the glass can sample it.
   * Created on the first `prepareScene`, because it has to match the output's
   * format as well as its size.
   */
  wallTarget?: Target;
  outputSize: readonly [number, number];
  readonly trace: Effect;
  readonly wall: Draw;
  readonly present: Effect;
  readonly glass: Draw;
  readonly prism: Geometry;
  readonly causticSampler: ReturnType<typeof sampler>;
  readonly sceneSampler: ReturnType<typeof sampler>;
  controls: PrismControls;
  /** Position along `PRISM_INCIDENCE_ARC`, in [0, 1]. */
  lampArc: number;
  /** Camera offset from centre, both components in [-1, 1]. */
  orbit: readonly [number, number];
  /** Frames already folded into the running average. */
  accumulated: number;
  aspect: number;
  /**
   * The camera the last frame was assembled with, kept because three of the
   * uniform blocks written per frame need it and building one allocates.
   */
  view: CameraView;
  readonly label: string;
}

export function traceSize(output: readonly [number, number]): readonly [number, number] {
  const scale = Math.min(TRACE_SCALE, TRACE_MAX_EDGE / Math.max(output[0], output[1], 1));
  return [Math.max(1, Math.round(output[0] * scale)), Math.max(1, Math.round(output[1] * scale))];
}

export function createScene(gpu: Gpu, output: readonly [number, number], label: string): PrismScene {
  const size = traceSize(output);
  const prism = prismGeometry(gpu, `${label}.prism`);
  return {
    gpu,
    size,
    outputSize: output,
    accumulation: pingPong(gpu, size[0], size[1], { format: 'rgba16float', label: `${label}.accumulation` }),
    trace: effect(gpu, traceWgsl, { label: `${label}.trace` }),
    // No vertex buffer: `wall.wgsl` derives its four corners from the same
    // uniform block the tracer integrated against.
    wall: draw(gpu, { shader: wallWgsl, vertices: 6, cull: 'back', depth: false, label: `${label}.wall` }),
    present: effect(gpu, presentWgsl, { label: `${label}.present` }),
    glass: draw(gpu, { shader: glassWgsl, geometry: prism, cull: 'back', depth: false, label: `${label}.glass` }),
    prism,
    causticSampler: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
    sceneSampler: sampler(gpu, {
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    }),
    controls: DEFAULT_PRISM_CONTROLS,
    lampArc: PRISM_DEFAULT_ARC,
    orbit: [0, 0],
    accumulated: 0,
    aspect: output[0] / Math.max(1, output[1]),
    view: cameraView(output[0] / Math.max(1, output[1])),
    label,
  };
}

/** Rebuilds the cached camera after the canvas or the pointer has moved it. */
function refreshCamera(scene: PrismScene): void {
  scene.view = cameraView(scene.aspect, scene.orbit[0], scene.orbit[1]);
}

/** Drops the running average; the next frame starts a new one. */
export function resetAccumulation(scene: PrismScene): void {
  scene.accumulated = 0;
}

export function setControls(scene: PrismScene, controls: PrismControls): void {
  const dispersionChanged = controls.dispersion !== scene.controls.dispersion;
  scene.controls = controls;
  // Only the traced estimate has to start over; the view just changes how the
  // same accumulation is composited.
  if (dispersionChanged) resetAccumulation(scene);
}

/** Moves the lamp along its arc. `position` is clamped into [0, 1]. */
export function setLampArc(scene: PrismScene, position: number): void {
  const next = Math.min(1, Math.max(0, position));
  if (next === scene.lampArc) return;
  scene.lampArc = next;
  resetAccumulation(scene);
}

/**
 * Points the camera. Both components are clamped into [-1, 1].
 *
 * Deliberately does not reset the accumulation: the estimate is a property of
 * the wall, not of the view, so it keeps converging while the camera moves.
 */
export function setOrbit(scene: PrismScene, x: number, y: number): void {
  scene.orbit = [Math.min(1, Math.max(-1, x)), Math.min(1, Math.max(-1, y))];
  refreshCamera(scene);
}

export function resizeScene(scene: PrismScene, output: readonly [number, number]): void {
  const size = traceSize(output);
  scene.outputSize = output;
  scene.aspect = output[0] / Math.max(1, output[1]);
  scene.wallTarget?.resize(output);
  refreshCamera(scene);
  if (size[0] === scene.size[0] && size[1] === scene.size[1]) {
    // Same accumulation resolution, different aspect: the scene mapping moved,
    // so the average is stale either way.
    resetAccumulation(scene);
    return;
  }
  const previous = scene.accumulation;
  scene.accumulation = pingPong(scene.gpu, size[0], size[1], {
    format: 'rgba16float',
    label: `${scene.label}.accumulation`,
  });
  scene.size = size;
  destroyTargets(previous);
  resetAccumulation(scene);
}

/** Angle of incidence for a position along `PRISM_INCIDENCE_ARC`. */
export function incidenceAt(position: number): number {
  const clamped = Math.min(1, Math.max(0, position));
  return PRISM_INCIDENCE_ARC.min + (PRISM_INCIDENCE_ARC.max - PRISM_INCIDENCE_ARC.min) * clamped;
}

/** The lamp for a position along the arc; `PRISM_DEFAULT_ARC` gives `PRISM_LIGHT`. */
export function lampAt(position: number): SpotLight {
  return lampForIncidence(incidenceAt(position));
}

/** Half-extents of the traced rectangle for a canvas of this shape. */
export function wallExtent(aspect: number): readonly [number, number] {
  const halfHeight = wallHalfHeight(aspect);
  return [halfHeight * aspect, halfHeight];
}

/** The uniform block the trace, wall and probe passes bind. */
export function sceneUniforms(scene: PrismScene): Record<string, unknown> {
  const dispersion = PRISM_DISPERSION_PRESETS[scene.controls.dispersion];
  const lamp = lampAt(scene.lampArc);
  return {
    viewProjection: scene.view.camera.viewProjection,
    prismA: PRISM_TRIANGLE.a,
    prismB: PRISM_TRIANGLE.b,
    prismC: PRISM_TRIANGLE.c,
    lampCenter: lamp.center,
    lampDirection: lamp.direction,
    lampRadius: lamp.radius,
    lampInnerAngle: lamp.innerAngle,
    lampOuterAngle: lamp.outerAngle,
    iorBase: dispersion.base,
    iorStrength: dispersion.strength,
    wallHalfExtent: wallExtent(scene.aspect),
    exposure: PRISM_EXPOSURE,
    wavelengthMin: PRISM_WAVELENGTHS.min,
    wavelengthMax: PRISM_WAVELENGTHS.max,
    haze: PRISM_HAZE,
    // The first frame has no history to average against, so it takes the whole
    // weight; after that this is 1/n, the running mean.
    blend: 1 / (scene.accumulated + 1),
    // Wide while the estimate is still mostly noise, tightening as it converges.
    causticBlur: Math.min(5, Math.max(1.2, 5 / Math.sqrt(scene.accumulated + 1))),
    raysPerFragment: PRISM_RAYS_PER_FRAGMENT,
    maxBounces: PRISM_MAX_INTERNAL_BOUNCES,
    frameIndex: scene.accumulated,
    causticOnly: scene.controls.view === 'caustic' ? 1 : 0,
  };
}

/** The uniform block the glass pass binds. */
export function glassUniforms(scene: PrismScene): Record<string, unknown> {
  return {
    viewProjection: scene.view.camera.viewProjection,
    environmentRotation: ENVIRONMENT_ROTATION,
    cameraPosition: scene.view.position,
    absorption: PRISM_GLASS.absorption,
    prismA: PRISM_TRIANGLE.a,
    prismB: PRISM_TRIANGLE.b,
    prismC: PRISM_TRIANGLE.c,
    resolution: scene.outputSize,
    frontZ: PRISM_FRONT_Z,
    backZ: PRISM_BACK_Z,
    ior: PRISM_GLASS.ior,
    reflectionStrength: PRISM_GLASS.reflectionStrength,
    frostRadius: PRISM_GLASS.frostRadius,
    dispersion: PRISM_GLASS.dispersion,
    iridescenceStrength: PRISM_GLASS.iridescenceStrength,
    iridescenceFrequency: PRISM_GLASS.iridescenceFrequency,
    environmentExposure: PRISM_GLASS.environmentExposure,
  };
}

/** Compiles every pipeline against the target it will draw into. */
export async function prepareScene(scene: PrismScene, output: Output): Promise<void> {
  scene.outputSize = output.size;
  scene.aspect = output.size[0] / Math.max(1, output.size[1]);
  refreshCamera(scene);
  const wallTarget = scene.wallTarget ?? target(scene.gpu, {
    size: output.size,
    format: output.format,
    label: `${scene.label}.wall`,
  });
  scene.wallTarget = wallTarget;
  if (wallTarget.size[0] !== output.size[0] || wallTarget.size[1] !== output.size[1]) {
    wallTarget.resize(output.size);
  }
  bind(scene, wallTarget);
  await Promise.all([
    scene.trace.compile(scene.accumulation.write),
    scene.wall.compile(wallTarget),
    scene.present.compile(output),
    scene.glass.compile(output),
  ]);
}

/** Folds one more frame of 16-rays-per-fragment into the running average. */
export function traceFrame(scene: PrismScene): void {
  scene.trace.set({ scene: sceneUniforms(scene), history: scene.accumulation.read });
  frame(scene.gpu, (current) => {
    current.pass({ target: scene.accumulation.write }, (pass) => pass.draw(scene.trace));
  });
  scene.accumulation.swap();
  scene.accumulated += 1;
}

/** Draws the wall, copies it to `output`, and stands the glass in front of it. */
export function presentScene(scene: PrismScene, output: Output): void {
  const wallTarget = scene.wallTarget;
  if (!wallTarget) throw new Error('prepareScene must run before presentScene.');
  bind(scene, wallTarget);
  frame(scene.gpu, (current) => {
    current.pass({ target: wallTarget }, (pass) => pass.draw(scene.wall));
    current.pass({ target: output }, (pass) => {
      pass.draw(scene.present);
      if (scene.controls.view === 'glass') pass.draw(scene.glass);
    });
  });
}

function bind(scene: PrismScene, wallTarget: Target): void {
  const values = sceneUniforms(scene);
  scene.trace.set({ scene: values, history: scene.accumulation.read });
  scene.wall.set({
    scene: values,
    caustic: scene.accumulation.read,
    causticSampler: scene.causticSampler,
  });
  scene.present.set({ sceneTexture: wallTarget });
  scene.glass.set({
    params: glassUniforms(scene),
    sceneTexture: wallTarget,
    sceneSampler: scene.sceneSampler,
  });
}

function destroyTargets(targets: PingPongTargets): void {
  for (const half of [targets.read, targets.write]) {
    (half as Target & { destroy?: () => void }).destroy?.();
  }
}

export function destroyScene(scene: PrismScene): void {
  destroyTargets(scene.accumulation);
  (scene.wallTarget as (Target & { destroy?: () => void }) | undefined)?.destroy?.();
  scene.wallTarget = undefined;
  scene.prism.destroy();
}
