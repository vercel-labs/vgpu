// GPU resources and the per-frame chain shared by the browser renderer and the
// thumbnail: simulate (compute) → stars (additive quads into an HDR scene) →
// bloom (half- and quarter-resolution Gaussian pairs) → composite (flare,
// dirty glass, ACES) into the output.

import {
  compute,
  draw,
  effect,
  frame,
  sampler,
  storage,
  target,
  type Frame,
  type Gpu,
  type StorageBuffer,
  type Surface,
  type Target,
} from 'vgpu';

import type { Animation } from './animation';
import { LAYER_FLOATS, MAX_FLARE_SOURCES, PROJECTED_FLOATS, type StarField } from './field';
import blurWgsl from './blur.wgsl';
import brightWgsl from './bright.wgsl';
import compositeWgsl from './composite.wgsl';
import dirtWgsl from './dirt.wgsl';
import simulateWgsl from './simulate.wgsl';
import starsWgsl from './stars.wgsl';

type Output = Surface | Target;

const CLEAR = [0, 0, 0, 1] as const;
const SCENE_FORMAT = 'rgba16float' as const;
const WORKGROUP_SIZE = 64;
export const DIRT_SIZE = [256, 192] as const;

// Half-resolution pair for tight halos, quarter-resolution pair for the wide glow.
const BLURS = [
  { direction: [1, 0], radius: 1.4 },
  { direction: [0, 1], radius: 1.4 },
  { direction: [1, 0], radius: 2.2 },
  { direction: [0, 1], radius: 2.2 },
] as const;

export interface Look {
  readonly bloomIntensity: number;
  readonly bloomThreshold: number;
  readonly bloomSmoothing: number;
  readonly exposure: number;
  readonly cameraY: number;
  readonly densityFalloff: number;
  readonly sizeFalloff: number;
  readonly lensFlare: {
    readonly enabled: boolean;
    readonly intensity: number;
    readonly halo: number;
    readonly streaks: number;
    readonly streakLength: number;
    readonly verticalStreaks: number;
    readonly ghosts: number;
    readonly secondary: number;
  };
  readonly dirtyGlass: {
    readonly enabled: boolean;
    readonly distortion: number;
    readonly grain: number;
    readonly procedural: number;
    readonly texture: number;
    readonly drift: number;
  };
}

export const DEFAULT_LOOK: Look = {
  bloomIntensity: 0.5,
  bloomThreshold: 0.08,
  bloomSmoothing: 0.18,
  exposure: 1,
  cameraY: 0.2,
  densityFalloff: 0.22,
  sizeFalloff: 0.45,
  lensFlare: {
    enabled: true,
    intensity: 0.28,
    halo: 0.12,
    streaks: 0.18,
    streakLength: 0.03485,
    verticalStreaks: 1,
    ghosts: 0.1,
    secondary: 0.55,
  },
  dirtyGlass: { enabled: true, distortion: 0.68, grain: 0.031, procedural: 0.35, texture: 0, drift: 0.28 },
};

export interface Resources {
  readonly stars: StorageBuffer;
  readonly paths: StorageBuffer;
  readonly layers: StorageBuffer;
  readonly motion: StorageBuffer;
  readonly projected: StorageBuffer;
  readonly flares: StorageBuffer;
  readonly motionClear: Float32Array<ArrayBuffer>;
  readonly dirt: Target;
}

export function createResources(gpu: Gpu, field: StarField): Resources {
  const owned: Array<StorageBuffer | Target> = [];
  const own = <T extends StorageBuffer | Target>(created: T): T => {
    owned.push(created);
    return created;
  };
  try {
    const stars = own(storage(gpu, field.stars.byteLength, 'read'));
    stars.write(field.stars);
    const paths = own(storage(gpu, Math.max(16, field.paths.byteLength), 'read'));
    if (field.paths.byteLength > 0) paths.write(field.paths);
    const layers = own(storage(gpu, Math.max(1, field.layers.length) * LAYER_FLOATS * 4, 'read'));
    const motionClear = new Float32Array(field.count * 4);
    const motion = own(storage(gpu, motionClear.byteLength, 'read-write'));
    motion.write(motionClear);
    const projected = own(storage(gpu, field.count * PROJECTED_FLOATS * 4, 'read-write'));
    const flares = own(storage(gpu, MAX_FLARE_SOURCES * 16, 'read-write'));
    flares.write(new Float32Array(MAX_FLARE_SOURCES * 4));
    const dirt = own(target(gpu, { size: DIRT_SIZE, format: 'rgba8unorm', label: 'spiral-galaxy-dirt' }));
    return { stars, paths, layers, motion, projected, flares, motionClear, dirt };
  } catch (error) {
    for (const created of owned.reverse()) destroy(created);
    throw error;
  }
}

export function destroyResources(resources: Resources): void {
  destroy(resources.dirt);
  destroy(resources.flares);
  destroy(resources.projected);
  destroy(resources.motion);
  destroy(resources.layers);
  destroy(resources.paths);
  destroy(resources.stars);
}

export function createEffects(gpu: Gpu, field: StarField, resources: Resources, look: Look = DEFAULT_LOOK) {
  const samp = sampler(gpu, {
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const additive = {
    color: { src: 'src-alpha', dst: 'one' },
    alpha: { src: 'one', dst: 'one-minus-src-alpha' },
  } as const;
  return {
    simulate: compute(gpu, simulateWgsl, {
      label: 'spiral-galaxy-simulate',
      set: {
        stars: resources.stars,
        paths: resources.paths,
        layers: resources.layers,
        motion: resources.motion,
        projected: resources.projected,
        flares: resources.flares,
        params: {
          viewport: [1, 1],
          world: [1, 1],
          scatter: [1, 1],
          pointer: [0, 0],
          previous: [0, 0],
          impulse: [0, 0],
          cameraY: look.cameraY,
          pixelRatio: 1,
          time: 0,
          intro: 0,
          densityFalloff: look.densityFalloff,
          sizeFalloff: look.sizeFalloff,
          twinkleSpeed: 0,
          intensity: 1,
          backgroundEnabled: 1,
          repelEnabled: 0,
          repelImpulse: 0,
          repelAge: 6,
          repelRadius: 0.2,
          count: field.count,
          coreLayer: Math.max(0, field.coreLayer),
          pad: 0,
        },
      },
    }),
    stars: draw(gpu, {
      shader: starsWgsl,
      vertices: 6,
      instances: field.count,
      blend: additive,
      label: 'spiral-galaxy-stars',
      set: { projected: resources.projected, view: { resolution: [1, 1] } },
    }),
    bright: effect(gpu, brightWgsl, {
      label: 'spiral-galaxy-bright',
      set: { samp, bright: { threshold: look.bloomThreshold, smoothing: look.bloomSmoothing } },
    }),
    blur: BLURS.map((options, i) =>
      effect(gpu, blurWgsl, { label: `spiral-galaxy-blur-${i}`, set: { samp, blur: options } }),
    ),
    dirt: effect(gpu, dirtWgsl, { label: 'spiral-galaxy-dirt', set: { dirt: { size: DIRT_SIZE } } }),
    composite: effect(gpu, compositeWgsl, {
      label: 'spiral-galaxy-composite',
      set: {
        samp,
        flares: resources.flares,
        dirt: resources.dirt,
        params: {
          aspect: 1,
          bloomIntensity: look.bloomIntensity,
          exposure: look.exposure,
          flareEnabled: look.lensFlare.enabled ? 1 : 0,
          intensity: look.lensFlare.intensity,
          halo: look.lensFlare.halo,
          streaks: look.lensFlare.streaks,
          streakLength: look.lensFlare.streakLength,
          verticalStreaks: look.lensFlare.verticalStreaks,
          ghosts: look.lensFlare.ghosts,
          secondary: look.lensFlare.secondary,
          dirtEnabled: look.dirtyGlass.enabled ? 1 : 0,
          distortion: look.dirtyGlass.distortion,
          grain: look.dirtyGlass.grain,
          procedural: look.dirtyGlass.procedural,
          textureDirt: look.dirtyGlass.texture,
          dirtAspect: DIRT_SIZE[0] / DIRT_SIZE[1],
          dirtRotation: 0,
          secondaryCount: Math.min(field.layers.filter((layer) => !layer.isCore).length, MAX_FLARE_SOURCES),
          coreLayer: Math.max(0, field.coreLayer),
          dirtOffset: [0, 0],
          pad: [0, 0],
        },
      },
    }),
  };
}

export type Effects = ReturnType<typeof createEffects>;

export function createTargets(gpu: Gpu, size: readonly [number, number]) {
  const owned: Target[] = [];
  const own = (created: Target) => {
    owned.push(created);
    return created;
  };
  const scaled = (divisor: number): [number, number] => [
    Math.max(1, Math.round(size[0] / divisor)),
    Math.max(1, Math.round(size[1] / divisor)),
  ];
  try {
    const half = scaled(2);
    const quarter = scaled(4);
    return {
      scene: own(target(gpu, { size, format: SCENE_FORMAT, label: 'spiral-galaxy-scene' })),
      near: [
        own(target(gpu, { size: half, format: SCENE_FORMAT, label: 'spiral-galaxy-near-a' })),
        own(target(gpu, { size: half, format: SCENE_FORMAT, label: 'spiral-galaxy-near-b' })),
      ] as const,
      far: [
        own(target(gpu, { size: quarter, format: SCENE_FORMAT, label: 'spiral-galaxy-far-a' })),
        own(target(gpu, { size: quarter, format: SCENE_FORMAT, label: 'spiral-galaxy-far-b' })),
      ] as const,
    };
  } catch (error) {
    for (const created of owned.reverse()) destroy(created);
    throw error;
  }
}

export type Targets = ReturnType<typeof createTargets>;

export function destroyTargets(targets: Targets): void {
  destroy(targets.far[1]);
  destroy(targets.far[0]);
  destroy(targets.near[1]);
  destroy(targets.near[0]);
  destroy(targets.scene);
}

function destroy(resource: unknown): void {
  (resource as { destroy?: () => void } | undefined)?.destroy?.();
}

/** Orthographic world extent: taller on portrait viewports so the arms still fit. */
export function worldSize(size: readonly [number, number]): [number, number] {
  const aspect = size[0] / Math.max(1, size[1]);
  const height = aspect < 0.72 ? 12.7 : 10.9;
  return [height * aspect, height];
}

export interface ViewOptions {
  readonly pixelRatio: number;
  readonly repelRadius: number;
}

export function setBindings(
  effects: Effects,
  targets: Targets,
  resources: Resources,
  view: ViewOptions,
): void {
  const size = targets.scene.size;
  const world = worldSize(size);
  effects.simulate.set({
    params: {
      viewport: [size[0], size[1]],
      world,
      scatter: [world[0] * 1.12, world[1] * 1.12],
      pixelRatio: view.pixelRatio,
      // Repel radius in NDC height units; the shader halves it into a falloff.
      repelRadius: (2 * view.repelRadius * view.pixelRatio) / Math.max(1, size[1]),
    },
  });
  effects.stars.set({ view: { resolution: [size[0], size[1]] } });
  effects.bright.set({ src: targets.scene });
  effects.blur[0]!.set({ src: targets.near[0], blur: { texelSize: targets.near[0].texelSize } });
  effects.blur[1]!.set({ src: targets.near[1], blur: { texelSize: targets.near[1].texelSize } });
  effects.blur[2]!.set({ src: targets.near[0], blur: { texelSize: targets.near[0].texelSize } });
  effects.blur[3]!.set({ src: targets.far[0], blur: { texelSize: targets.far[0].texelSize } });
  effects.composite.set({
    scene: targets.scene,
    bloomNear: targets.near[0],
    bloomFar: targets.far[1],
    dirt: resources.dirt,
    params: { aspect: size[0] / Math.max(1, size[1]) },
  });
}

export async function prewarm(effects: Effects, targets: Targets, resources: Resources, output: Output): Promise<void> {
  await Promise.all([
    effects.stars.compile(targets.scene),
    effects.bright.compile(targets.near[0]),
    effects.blur[0]!.compile(targets.near[1]),
    effects.blur[1]!.compile(targets.near[0]),
    effects.blur[2]!.compile(targets.far[0]),
    effects.blur[3]!.compile(targets.far[1]),
    effects.dirt.compile(resources.dirt),
    effects.composite.compile({ colors: [output.format] }),
  ]);
}

/** The dirt map never changes: bake it once instead of every frame. */
export function bakeDirt(gpu: Gpu, effects: Effects, resources: Resources): void {
  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: resources.dirt, clear: CLEAR }, (pass) => pass.draw(effects.dirt));
  });
}

export interface LookToggles {
  readonly lensFlare?: boolean;
  readonly dirtyGlass?: boolean;
}

/** Flips the optional finishing passes at runtime; both are uniform flags. */
export function setLook(effects: Effects, toggles: LookToggles): void {
  const params: Record<string, number> = {};
  if (toggles.lensFlare !== undefined) params.flareEnabled = toggles.lensFlare ? 1 : 0;
  if (toggles.dirtyGlass !== undefined) params.dirtEnabled = toggles.dirtyGlass ? 1 : 0;
  if (Object.keys(params).length > 0) effects.composite.set({ params });
}

/** Advances the animation and dispatches the star simulation for this frame. */
export function stepSimulation(
  effects: Effects,
  resources: Resources,
  field: StarField,
  animation: Animation,
  dt: number,
  look: Look = DEFAULT_LOOK,
): void {
  const values = animation.update(dt);
  if (animation.motionDirty) {
    resources.motion.write(resources.motionClear);
    animation.acknowledgeMotion();
  }
  resources.layers.write(animation.layerData);
  effects.simulate.set({
    params: {
      time: values.time,
      intro: values.intro,
      twinkleSpeed: values.twinkleSpeed,
      intensity: values.intensity,
      backgroundEnabled: values.backgroundEnabled,
      repelEnabled: values.repelEnabled,
      repelImpulse: values.repelImpulse,
      repelAge: values.repelAge,
      pointer: values.pointer,
      previous: values.previous,
      impulse: values.impulse,
    },
  });
  effects.simulate.dispatch(Math.ceil(field.count / WORKGROUP_SIZE));

  // The dirt drifts a little with the rotation, like a real front element.
  const strength = look.dirtyGlass.drift;
  const rx = animation.spin.x;
  const ry = animation.spin.y;
  effects.composite.set({
    params: {
      dirtOffset: [-(0.032 * Math.sin(ry)) * strength, 0.032 * Math.sin(rx) * strength],
      dirtRotation: -(0.055 * Math.sin(0.5 * ry)) * strength,
    },
  });
}

export function renderChain(currentFrame: Frame, effects: Effects, targets: Targets, output: Output): void {
  currentFrame.pass({ target: targets.scene, clear: CLEAR }, (pass) => pass.draw(effects.stars));
  currentFrame.pass({ target: targets.near[0], clear: CLEAR }, (pass) => pass.draw(effects.bright));
  currentFrame.pass({ target: targets.near[1], clear: CLEAR }, (pass) => pass.draw(effects.blur[0]!));
  currentFrame.pass({ target: targets.near[0], clear: CLEAR }, (pass) => pass.draw(effects.blur[1]!));
  currentFrame.pass({ target: targets.far[0], clear: CLEAR }, (pass) => pass.draw(effects.blur[2]!));
  currentFrame.pass({ target: targets.far[1], clear: CLEAR }, (pass) => pass.draw(effects.blur[3]!));
  currentFrame.pass({ target: output, clear: CLEAR }, (pass) => pass.draw(effects.composite));
}

