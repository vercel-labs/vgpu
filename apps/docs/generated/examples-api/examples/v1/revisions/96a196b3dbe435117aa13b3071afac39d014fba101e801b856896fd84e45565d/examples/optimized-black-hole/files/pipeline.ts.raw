import type { Effect, Frame, Gpu, Surface, Target } from "vgpu";

import bakeWgsl from "./bake.wgsl";
import bloomWgsl from "./bloom.wgsl";
import compositeWgsl from "./composite.wgsl";
import {
  createNoiseVolume,
  NOISE_VOLUME_SIZE,
  noiseVolumeSampler,
} from "./noise-volume.mjs";
import refineWgsl from "./refine.wgsl";
import shadeWgsl from "./shade.wgsl";
import type { HeroSettings } from "./settings";

export type VgpuApi = typeof import("vgpu");
type Output = Surface | Target;
type NoiseVolume = ReturnType<typeof createNoiseVolume>;

export interface Effects {
  bake: Effect;
  refine: Effect;
  shade: Effect;
  bloomExtract: Effect;
  bloomBlurH0: Effect;
  bloomBlurV0: Effect;
  bloomDown1: Effect;
  bloomBlurH1: Effect;
  bloomBlurV1: Effect;
  bloomDown2: Effect;
  bloomBlurH2: Effect;
  bloomBlurV2: Effect;
  composite: Effect;
  postSampler: GPUSampler;
  noiseVolume: NoiseVolume;
  noiseSampler: GPUSampler;
}

export interface Targets {
  gbuffer: Target;
  aa: Target;
  scene: Target;
  bloom0: Target;
  bloomPing0: Target;
  bloom1: Target;
  bloomPing1: Target;
  bloom2: Target;
  bloomPing2: Target;
}

const GBUFFER_FORMATS: readonly GPUTextureFormat[] = [
  "rg32float",
  "rg32float",
  "rgba16float",
  "rgba16float",
];
const AA_FORMATS: readonly GPUTextureFormat[] = ["rg8unorm", "rgba16float"];
const CLEAR: readonly [number, number, number, number] = [0, 0, 0, 1];

export function createEffects(vgpu: VgpuApi, gpu: Gpu): Effects {
  const postSampler = vgpu.sampler(gpu, {
    minFilter: "linear",
    magFilter: "linear",
  });
  const noiseSampler = noiseVolumeSampler(vgpu, gpu);
  return {
    bake: vgpu.effect(gpu, bakeWgsl),
    refine: vgpu.effect(gpu, refineWgsl),
    shade: vgpu.effect(gpu, shadeWgsl),
    bloomExtract: vgpu.effect(gpu, bloomWgsl),
    bloomBlurH0: vgpu.effect(gpu, bloomWgsl),
    bloomBlurV0: vgpu.effect(gpu, bloomWgsl),
    bloomDown1: vgpu.effect(gpu, bloomWgsl),
    bloomBlurH1: vgpu.effect(gpu, bloomWgsl),
    bloomBlurV1: vgpu.effect(gpu, bloomWgsl),
    bloomDown2: vgpu.effect(gpu, bloomWgsl),
    bloomBlurH2: vgpu.effect(gpu, bloomWgsl),
    bloomBlurV2: vgpu.effect(gpu, bloomWgsl),
    composite: vgpu.effect(gpu, compositeWgsl),
    postSampler,
    noiseSampler,
    noiseVolume: createNoiseVolume(gpu, NOISE_VOLUME_SIZE),
  };
}

export function createTargets(
  vgpu: VgpuApi,
  gpu: Gpu,
  size: readonly [number, number]
): Targets {
  const full = normalizeSize(size),
    half = scaleSize(full, 2),
    quarter = scaleSize(full, 4),
    eighth = scaleSize(full, 8);
  const postTarget = (targetSize: readonly [number, number]) =>
    vgpu.target(gpu, {
      size: targetSize,
      colors: [{ format: "rgba16float" }],
    });
  const created: Target[] = [];
  const own = (value: Target) => {
    created.push(value);
    return value;
  };
  try {
    return {
      gbuffer: own(
        vgpu.target(gpu, {
          size: full,
          colors: GBUFFER_FORMATS.map((format) => ({ format })),
        })
      ),
      aa: own(
        vgpu.target(gpu, {
          size: full,
          colors: AA_FORMATS.map((format) => ({ format })),
        })
      ),
      scene: own(postTarget(full)),
      bloom0: own(postTarget(half)),
      bloomPing0: own(postTarget(half)),
      bloom1: own(postTarget(quarter)),
      bloomPing1: own(postTarget(quarter)),
      bloom2: own(postTarget(eighth)),
      bloomPing2: own(postTarget(eighth)),
    };
  } catch (error) {
    try {
      destroyTargetList(created.reverse());
    } catch {
      // The allocation failure remains the primary error.
    }
    throw error;
  }
}

export function destroyTargets(targets: Targets): void {
  destroyTargetList([
    targets.gbuffer,
    targets.aa,
    targets.scene,
    targets.bloom0,
    targets.bloomPing0,
    targets.bloom1,
    targets.bloomPing1,
    targets.bloom2,
    targets.bloomPing2,
  ]);
}

function destroyTargetList(values: readonly Target[]): void {
  let failed = false;
  let failure: unknown;
  for (const value of values) {
    try {
      destroyTarget(value);
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    }
  }
  if (failed) throw failure;
}

function destroyTarget(value: Target | undefined): void {
  (value as { destroy?: () => void } | undefined)?.destroy?.();
}

export function setBindings(effects: Effects, targets: Targets): void {
  const [hit1, hit2, sky, view] = targets.gbuffer.colors;
  const [aa, aaGeom] = targets.aa.colors;
  effects.bake.set({ bake: { resolution: targets.gbuffer.size } });
  effects.refine.set({
    gHit1: hit1,
    gSky: sky,
    refine: { resolution: targets.gbuffer.size },
  });
  effects.shade.set({
    gHit1: hit1,
    gHit2: hit2,
    gSky: sky,
    gView: view,
    gAa: aa,
    gAaGeom: aaGeom,
    noiseVolume: effects.noiseVolume,
    noiseSampler: effects.noiseSampler,
    shade: { resolution: targets.gbuffer.size },
  });
  const scene = targets.scene.colors[0]!,
    bloom0 = targets.bloom0.colors[0]!,
    bloomPing0 = targets.bloomPing0.colors[0]!,
    bloom1 = targets.bloom1.colors[0]!,
    bloomPing1 = targets.bloomPing1.colors[0]!,
    bloom2 = targets.bloom2.colors[0]!,
    bloomPing2 = targets.bloomPing2.colors[0]!;
  effects.bloomExtract.set({
    source: scene,
    linearSampler: effects.postSampler,
  });
  effects.bloomBlurH0.set({
    source: bloom0,
    linearSampler: effects.postSampler,
  });
  effects.bloomBlurV0.set({
    source: bloomPing0,
    linearSampler: effects.postSampler,
  });
  effects.bloomDown1.set({
    source: bloom0,
    linearSampler: effects.postSampler,
  });
  effects.bloomBlurH1.set({
    source: bloom1,
    linearSampler: effects.postSampler,
  });
  effects.bloomBlurV1.set({
    source: bloomPing1,
    linearSampler: effects.postSampler,
  });
  effects.bloomDown2.set({
    source: bloom1,
    linearSampler: effects.postSampler,
  });
  effects.bloomBlurH2.set({
    source: bloom2,
    linearSampler: effects.postSampler,
  });
  effects.bloomBlurV2.set({
    source: bloomPing2,
    linearSampler: effects.postSampler,
  });
  effects.composite.set({
    scene,
    bloomNear: bloom0,
    bloomMedium: bloom1,
    bloomFar: bloom2,
    linearSampler: effects.postSampler,
  });
}

export function setBakeUniforms(
  effects: Effects,
  targets: Targets,
  settings: HeroSettings
): void {
  const geometry = {
    resolution: targets.gbuffer.size,
    yaw: 0,
    pitch: settings.cameraY,
    orbitRadius: settings.distance,
    diskOuter: settings.diskRadius,
    fov: settings.fov,
    centerX: settings.centerX,
    centerY: settings.centerY,
    roll: settings.cameraRoll,
  };
  effects.bake.set({ bake: geometry });
  effects.refine.set({ refine: geometry });
}
export function setShadeUniforms(
  effects: Effects,
  targets: Targets,
  settings: HeroSettings,
  time: number,
  sceneYaw: number
): void {
  effects.shade.set({
    shade: {
      resolution: targets.gbuffer.size,
      time,
      diskOuter: settings.diskRadius,
      sceneYaw,
      centerFade: settings.centerFade,
    },
    disk: settings.disk,
    stars: settings.stars,
  });
}
export function setPostUniforms(
  effects: Effects,
  targets: Targets,
  settings: HeroSettings
): void {
  const threshold = Math.max(0, settings.bloom.threshold),
    knee = Math.max(0.0001, settings.bloom.knee),
    radius = Math.max(0.1, settings.bloom.radius);
  const downsample = (
    sourceSize: readonly [number, number],
    applyThreshold: boolean
  ) => ({
    sourceSize,
    direction: [0, 0],
    params: [applyThreshold ? threshold : -1, knee, radius, 0],
  });
  const blur = (
    sourceSize: readonly [number, number],
    x: number,
    y: number
  ) => ({
    sourceSize,
    direction: [x, y],
    params: [-1, knee, radius, 1],
  });
  effects.bloomExtract.set({ bloom: downsample(targets.scene.size, true) });
  effects.bloomBlurH0.set({ bloom: blur(targets.bloom0.size, 1, 0) });
  effects.bloomBlurV0.set({ bloom: blur(targets.bloomPing0.size, 0, 1) });
  effects.bloomDown1.set({ bloom: downsample(targets.bloom0.size, false) });
  effects.bloomBlurH1.set({ bloom: blur(targets.bloom1.size, 1, 0) });
  effects.bloomBlurV1.set({ bloom: blur(targets.bloomPing1.size, 0, 1) });
  effects.bloomDown2.set({ bloom: downsample(targets.bloom1.size, false) });
  effects.bloomBlurH2.set({ bloom: blur(targets.bloom2.size, 1, 0) });
  effects.bloomBlurV2.set({ bloom: blur(targets.bloomPing2.size, 0, 1) });
  effects.composite.set({
    composite: {
      params: [Math.max(0, settings.bloom.strength), 0, 0, 0],
    },
  });
}

export async function prewarm(
  effects: Effects,
  targets: Targets,
  output: Output
): Promise<void> {
  const bloomOutput = { colors: [targets.bloom0.format] };
  await Promise.all([
    effects.bake.compile(targets.gbuffer),
    effects.refine.compile(targets.aa),
    effects.shade.compile(targets.scene),
    effects.bloomExtract.compile(bloomOutput),
    effects.bloomBlurH0.compile(bloomOutput),
    effects.bloomBlurV0.compile(bloomOutput),
    effects.bloomDown1.compile(bloomOutput),
    effects.bloomBlurH1.compile(bloomOutput),
    effects.bloomBlurV1.compile(bloomOutput),
    effects.bloomDown2.compile(bloomOutput),
    effects.bloomBlurH2.compile(bloomOutput),
    effects.bloomBlurV2.compile(bloomOutput),
    effects.composite.compile({ colors: [output.format] }),
  ]);
}

export function renderChain(
  frame: Frame,
  effects: Effects,
  targets: Targets,
  output: Output,
  bake: boolean
): void {
  if (bake) {
    frame.pass({ target: targets.gbuffer, clear: CLEAR }, (pass) =>
      pass.draw(effects.bake)
    );
    frame.pass({ target: targets.aa, clear: CLEAR }, (pass) =>
      pass.draw(effects.refine)
    );
  }
  frame.pass({ target: targets.scene, clear: CLEAR }, (pass) =>
    pass.draw(effects.shade)
  );
  frame.pass({ target: targets.bloom0, clear: CLEAR }, (pass) =>
    pass.draw(effects.bloomExtract)
  );
  frame.pass({ target: targets.bloomPing0, clear: CLEAR }, (pass) =>
    pass.draw(effects.bloomBlurH0)
  );
  frame.pass({ target: targets.bloom0, clear: CLEAR }, (pass) =>
    pass.draw(effects.bloomBlurV0)
  );
  frame.pass({ target: targets.bloom1, clear: CLEAR }, (pass) =>
    pass.draw(effects.bloomDown1)
  );
  frame.pass({ target: targets.bloomPing1, clear: CLEAR }, (pass) =>
    pass.draw(effects.bloomBlurH1)
  );
  frame.pass({ target: targets.bloom1, clear: CLEAR }, (pass) =>
    pass.draw(effects.bloomBlurV1)
  );
  frame.pass({ target: targets.bloom2, clear: CLEAR }, (pass) =>
    pass.draw(effects.bloomDown2)
  );
  frame.pass({ target: targets.bloomPing2, clear: CLEAR }, (pass) =>
    pass.draw(effects.bloomBlurH2)
  );
  frame.pass({ target: targets.bloom2, clear: CLEAR }, (pass) =>
    pass.draw(effects.bloomBlurV2)
  );
  frame.pass({ target: output, clear: CLEAR }, (pass) =>
    pass.draw(effects.composite)
  );
}

function normalizeSize(size: readonly [number, number]): [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}
function scaleSize(
  size: readonly [number, number],
  divisor: number
): [number, number] {
  return [
    Math.max(1, Math.floor(size[0] / divisor)),
    Math.max(1, Math.floor(size[1] / divisor)),
  ];
}
