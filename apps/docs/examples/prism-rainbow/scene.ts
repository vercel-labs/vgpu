/**
 * Resource graph and frame schedule.
 *
 * Two passes per frame. `trace` casts the 16 rays per fragment into one half of
 * a ping-pong pair while reading the other half, so each frame refines a running
 * average instead of replacing it; `present` upsamples that average onto the
 * canvas and composites the wall, the glass and the beam.
 *
 * The trace runs on a target narrower than the canvas because its cost is
 * per-fragment and the caustic it estimates is smooth. `present` samples it with
 * a filtering sampler, so the accumulation buffer's resolution trades noise for
 * frame time without changing the picture's framing.
 */

import type { Effect, Gpu, PingPongTargets, Surface, Target } from 'vgpu';
import { effect, frame, pingPong, sampler } from 'vgpu';

import presentWgsl from './present.wgsl';
import traceWgsl from './trace.wgsl';
import {
  DEFAULT_PRISM_CONTROLS,
  PRISM_DEFAULT_ARC,
  PRISM_DISPERSION_PRESETS,
  PRISM_EXPOSURE,
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

/** Longest edge the accumulation buffer is allowed to take. */
export const TRACE_MAX_EDGE = 640;
/** Fraction of the output resolution the accumulation buffer aims for. */
export const TRACE_SCALE = 0.6;

export interface PrismScene {
  readonly gpu: Gpu;
  /** Accumulation buffer size, not the canvas size. */
  size: readonly [number, number];
  accumulation: PingPongTargets;
  readonly trace: Effect;
  readonly present: Effect;
  readonly causticSampler: ReturnType<typeof sampler>;
  controls: PrismControls;
  /** Position along `PRISM_INCIDENCE_ARC`, in [0, 1]. */
  lampArc: number;
  /** Frames already folded into the running average. */
  accumulated: number;
  aspect: number;
  readonly label: string;
}

export function traceSize(output: readonly [number, number]): readonly [number, number] {
  const scale = Math.min(TRACE_SCALE, TRACE_MAX_EDGE / Math.max(output[0], output[1], 1));
  return [Math.max(1, Math.round(output[0] * scale)), Math.max(1, Math.round(output[1] * scale))];
}

export function createScene(gpu: Gpu, output: readonly [number, number], label: string): PrismScene {
  const size = traceSize(output);
  return {
    gpu,
    size,
    accumulation: pingPong(gpu, size[0], size[1], { format: 'rgba16float', label: `${label}.accumulation` }),
    trace: effect(gpu, traceWgsl, { label: `${label}.trace` }),
    present: effect(gpu, presentWgsl, { label: `${label}.present` }),
    causticSampler: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
    controls: DEFAULT_PRISM_CONTROLS,
    lampArc: PRISM_DEFAULT_ARC,
    accumulated: 0,
    aspect: output[0] / Math.max(1, output[1]),
    label,
  };
}

/** Drops the running average; the next frame starts a new one. */
export function resetAccumulation(scene: PrismScene): void {
  scene.accumulated = 0;
}

export function setControls(scene: PrismScene, controls: PrismControls): void {
  const dispersionChanged = controls.dispersion !== scene.controls.dispersion;
  scene.controls = controls;
  // Only the traced estimate has to start over; `causticOnly` just changes how
  // the same accumulation is composited.
  if (dispersionChanged) resetAccumulation(scene);
}

/** Moves the lamp along its arc. `position` is clamped into [0, 1]. */
export function setLampArc(scene: PrismScene, position: number): void {
  const next = Math.min(1, Math.max(0, position));
  if (next === scene.lampArc) return;
  scene.lampArc = next;
  resetAccumulation(scene);
}

export function resizeScene(scene: PrismScene, output: readonly [number, number]): void {
  const size = traceSize(output);
  scene.aspect = output[0] / Math.max(1, output[1]);
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

/** The uniform block both passes bind. Exported so the probe can bind the same one. */
export function sceneUniforms(scene: PrismScene): Record<string, unknown> {
  const dispersion = PRISM_DISPERSION_PRESETS[scene.controls.dispersion];
  const lamp = lampAt(scene.lampArc);
  return {
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
    aspect: scene.aspect,
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
    causticOnly: scene.controls.causticOnly ? 1 : 0,
  };
}

/** Compiles both pipelines against the target they will draw into. */
export async function prepareScene(scene: PrismScene, output: Output): Promise<void> {
  const values = sceneUniforms(scene);
  scene.trace.set({ scene: values, history: scene.accumulation.read });
  scene.present.set({ scene: values, caustic: scene.accumulation.read, causticSampler: scene.causticSampler });
  await Promise.all([
    scene.trace.compile(scene.accumulation.write),
    scene.present.compile(output),
  ]);
}

/** Folds one more frame of 16-rays-per-fragment into the running average. */
export function traceFrame(scene: PrismScene): void {
  const values = sceneUniforms(scene);
  scene.trace.set({ scene: values, history: scene.accumulation.read });
  frame(scene.gpu, (current) => {
    current.pass({ target: scene.accumulation.write }, (pass) => pass.draw(scene.trace));
  });
  scene.accumulation.swap();
  scene.accumulated += 1;
}

export function presentScene(scene: PrismScene, output: Output): void {
  scene.present.set({
    scene: sceneUniforms(scene),
    caustic: scene.accumulation.read,
    causticSampler: scene.causticSampler,
  });
  frame(scene.gpu, (current) => {
    current.pass({ target: output }, (pass) => pass.draw(scene.present));
  });
}

function destroyTargets(targets: PingPongTargets): void {
  for (const half of [targets.read, targets.write]) {
    (half as Target & { destroy?: () => void }).destroy?.();
  }
}

export function destroyScene(scene: PrismScene): void {
  destroyTargets(scene.accumulation);
}
