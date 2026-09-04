import {
  effect,
  frame,
  sampler,
  target,
  type Effect,
  type Gpu,
  type Surface,
  type Target,
} from "vgpu";

import type { CameraView } from "./camera";
import sculptureWgsl from "./sculpture.wgsl";
import bloomExtractWgsl from "./bloom-extract.wgsl";
import bloomBlurWgsl from "./bloom-blur.wgsl";
import presentWgsl from "./present.wgsl";

type Output = Surface | Target;
type Vec3 = readonly [number, number, number];

export const SHAPES = ["knot", "gyroid", "droplets"] as const;
export const GLASSES = ["clear", "rose", "cobalt", "emerald"] as const;
export const LIGHT_RIGS = ["studio", "noir", "gel", "golden"] as const;
export const RENDER_SCALES = [0.5, 0.75, 1] as const;

export type Shape = (typeof SHAPES)[number];
export type Glass = (typeof GLASSES)[number];
export type LightRigName = (typeof LIGHT_RIGS)[number];
export type RenderScale = (typeof RENDER_SCALES)[number];

export interface SculptureControls {
  shape: Shape;
  glass: Glass;
  light: LightRigName;
  dispersion: boolean;
  spin: boolean;
  renderScale: RenderScale;
}

export const DEFAULT_CONTROLS: SculptureControls = {
  shape: "gyroid",
  glass: "clear",
  light: "studio",
  dispersion: true,
  spin: true,
  renderScale: 0.75,
};

export interface LightRig {
  readonly keyColor: Vec3;
  readonly keyPower: number;
  readonly rimColor: Vec3;
  readonly rimPower: number;
  readonly backgroundTop: Vec3;
  readonly backgroundBottom: Vec3;
  readonly floorLuminance: number;
}

/** Four studio setups. Switching rigs interpolates every value, so the light never cuts. */
export const RIGS: Readonly<Record<LightRigName, LightRig>> = {
  studio: {
    keyColor: [1.0, 0.92, 0.82],
    keyPower: 6,
    rimColor: [0.65, 0.8, 1.0],
    rimPower: 5,
    backgroundTop: [0.95, 0.96, 1.0],
    backgroundBottom: [0.3, 0.31, 0.34],
    floorLuminance: 1.4,
  },
  noir: {
    keyColor: [1.0, 0.97, 0.92],
    keyPower: 16,
    rimColor: [0.35, 0.45, 0.8],
    rimPower: 9,
    backgroundTop: [0.1, 0.1, 0.12],
    backgroundBottom: [0.02, 0.02, 0.03],
    floorLuminance: 1.6,
  },
  gel: {
    keyColor: [1.0, 0.4, 0.3],
    keyPower: 11,
    rimColor: [0.15, 0.8, 1.0],
    rimPower: 11,
    backgroundTop: [0.16, 0.08, 0.22],
    backgroundBottom: [0.04, 0.02, 0.07],
    floorLuminance: 1.3,
  },
  golden: {
    keyColor: [1.0, 0.72, 0.42],
    keyPower: 9,
    rimColor: [0.45, 0.55, 0.9],
    rimPower: 3,
    backgroundTop: [1.0, 0.78, 0.55],
    backgroundBottom: [0.36, 0.2, 0.14],
    floorLuminance: 1.25,
  },
};

export interface LightState {
  /** Key light azimuth relative to the camera, radians. */
  readonly azimuth: number;
  /** Key light elevation, radians. */
  readonly elevation: number;
}

export interface FrameState {
  /** Sculpture time in seconds; freezing it stops the turntable. */
  readonly time: number;
  /** Wall-clock seconds, used for grain and the rotating strip light. */
  readonly clock: number;
  readonly light: LightState;
}

const HDR_FORMAT: GPUTextureFormat = "rgba16float";
const BLOOM_THRESHOLD = 1.0;
const BLOOM_STRENGTH = 0.45;
const RIM_AZIMUTH_OFFSET = Math.PI * 0.85;
const RIM_ELEVATION = 0.35;

export interface Targets {
  readonly scene: Target;
  readonly bloomA: Target;
  readonly bloomB: Target;
}

export interface Scene {
  readonly sculpture: Effect;
  readonly extract: Effect;
  readonly blurHorizontal: Effect;
  readonly blurVertical: Effect;
  readonly present: Effect;
  readonly linearSampler: GPUSampler;
  targets: Targets;
  /** The rig currently on screen; eased toward the selected rig every frame. */
  rig: MutableRig;
}

interface MutableRig {
  keyColor: [number, number, number];
  keyPower: number;
  rimColor: [number, number, number];
  rimPower: number;
  backgroundTop: [number, number, number];
  backgroundBottom: [number, number, number];
  floorLuminance: number;
}

export async function createScene(
  gpu: Gpu,
  output: Output,
  controls: Readonly<SculptureControls> = DEFAULT_CONTROLS
): Promise<Scene> {
  const targets = createTargets(gpu, output.size, controls.renderScale);
  try {
    const linearSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const scene: Scene = {
      sculpture: effect(gpu, sculptureWgsl, { label: "glass-sculpture" }),
      extract: effect(gpu, bloomExtractWgsl, { label: "glass-bloom-extract" }),
      blurHorizontal: effect(gpu, bloomBlurWgsl, {
        label: "glass-bloom-blur-h",
      }),
      blurVertical: effect(gpu, bloomBlurWgsl, {
        label: "glass-bloom-blur-v",
      }),
      present: effect(gpu, presentWgsl, { label: "glass-present" }),
      linearSampler,
      targets,
      rig: copyRig(RIGS[controls.light]),
    };
    bindTargets(scene);
    await Promise.all([
      scene.sculpture.compile(targets.scene),
      scene.extract.compile(targets.bloomA),
      scene.blurHorizontal.compile(targets.bloomB),
      scene.blurVertical.compile(targets.bloomA),
      scene.present.compile({ colors: [output.format] }),
    ]);
    return scene;
  } catch (error) {
    rethrow(error, () => destroyTargets(targets));
  }
}

export function createTargets(
  gpu: Gpu,
  size: readonly [number, number],
  renderScale: number
): Targets {
  const scale = clampScale(renderScale);
  const width = Math.max(1, Math.floor(size[0] * scale));
  const height = Math.max(1, Math.floor(size[1] * scale));
  const bloomWidth = Math.max(1, width >> 2);
  const bloomHeight = Math.max(1, height >> 2);
  const scene = target(gpu, {
    size: [width, height],
    format: HDR_FORMAT,
    label: "glass-scene",
  });
  try {
    const bloomA = target(gpu, {
      size: [bloomWidth, bloomHeight],
      format: HDR_FORMAT,
      label: "glass-bloom-a",
    });
    try {
      const bloomB = target(gpu, {
        size: [bloomWidth, bloomHeight],
        format: HDR_FORMAT,
        label: "glass-bloom-b",
      });
      return { scene, bloomA, bloomB };
    } catch (error) {
      rethrow(error, () => destroyResource(bloomA));
    }
  } catch (error) {
    rethrow(error, () => destroyResource(scene));
  }
}

/** Rebuilds the offscreen targets for a new output size or render scale. */
export function replaceTargets(
  gpu: Gpu,
  scene: Scene,
  size: readonly [number, number],
  renderScale: number
): void {
  const previous = scene.targets;
  const next = createTargets(gpu, size, renderScale);
  try {
    scene.targets = next;
    bindTargets(scene);
  } catch (error) {
    scene.targets = previous;
    rethrow(
      error,
      () => bindTargets(scene),
      () => destroyTargets(next)
    );
  }
  destroyTargets(previous);
}

export function renderScene(
  gpu: Gpu,
  scene: Scene,
  output: Output,
  camera: CameraView | (() => CameraView),
  controls: Readonly<SculptureControls>,
  state: FrameState
): void {
  const view = typeof camera === "function" ? camera() : camera;
  const { targets } = scene;
  const rig = scene.rig;
  easeRig(rig, RIGS[controls.light], 0.04);
  const key = lightDirection(view.yaw + state.light.azimuth, state.light.elevation);
  const rim = lightDirection(
    view.yaw + state.light.azimuth + RIM_AZIMUTH_OFFSET,
    RIM_ELEVATION
  );

  scene.sculpture.set({
    params: {
      resolution: targets.scene.size,
      time: state.time,
      shape: SHAPES.indexOf(controls.shape),
      tint: GLASSES.indexOf(controls.glass),
      quality: controls.renderScale >= 1 ? 1 : controls.renderScale,
      yaw: view.yaw,
      pitch: view.pitch,
      radius: view.radius,
      dispersion: controls.dispersion ? 1 : 0,
      strip_angle: 0.8 + state.clock * 0.1,
      floor_luminance: rig.floorLuminance,
      key: [...key, rig.keyPower],
      key_color: [...rig.keyColor, 0],
      rim: [...rim, rig.rimPower],
      rim_color: [...rig.rimColor, 0],
      background_top: [...rig.backgroundTop, 0],
      background_bottom: [...rig.backgroundBottom, 0],
    },
  });
  scene.present.set({ params: { time: state.clock } });

  frame(gpu, (currentFrame) => {
    currentFrame.pass(targets.scene, scene.sculpture);
    currentFrame.pass(targets.bloomA, scene.extract);
    currentFrame.pass(targets.bloomB, scene.blurHorizontal);
    currentFrame.pass(targets.bloomA, scene.blurVertical);
    currentFrame.pass(output, scene.present);
  });
}

/** Unit vector for a light at the given azimuth (around +y) and elevation. */
export function lightDirection(azimuth: number, elevation: number): Vec3 {
  const cosElevation = Math.cos(elevation);
  return [
    Math.sin(azimuth) * cosElevation,
    Math.sin(elevation),
    Math.cos(azimuth) * cosElevation,
  ];
}

export function normalizeControls(
  controls: Readonly<SculptureControls>
): SculptureControls {
  return {
    shape: SHAPES.includes(controls.shape)
      ? controls.shape
      : DEFAULT_CONTROLS.shape,
    glass: GLASSES.includes(controls.glass)
      ? controls.glass
      : DEFAULT_CONTROLS.glass,
    light: LIGHT_RIGS.includes(controls.light)
      ? controls.light
      : DEFAULT_CONTROLS.light,
    dispersion: controls.dispersion === true,
    spin: controls.spin !== false,
    renderScale: RENDER_SCALES.includes(controls.renderScale)
      ? controls.renderScale
      : DEFAULT_CONTROLS.renderScale,
  };
}

export function aspectOf(output: Output): number {
  return output.size[0] / Math.max(1, output.size[1]);
}

export function destroyScene(scene: Scene): void {
  destroyTargets(scene.targets);
}

export function destroyTargets(targets: Targets): void {
  let firstError: unknown;
  let failed = false;
  for (const resource of [targets.bloomB, targets.bloomA, targets.scene]) {
    try {
      destroyResource(resource);
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
}

function bindTargets(scene: Scene): void {
  const { targets, linearSampler } = scene;
  const sceneTexel = [1 / targets.scene.size[0], 1 / targets.scene.size[1]];
  const bloomTexel = [1 / targets.bloomA.size[0], 1 / targets.bloomA.size[1]];
  scene.extract.set({
    params: { texel: sceneTexel, threshold: BLOOM_THRESHOLD, padding: 0 },
    source: targets.scene,
    source_sampler: linearSampler,
  });
  scene.blurHorizontal.set({
    params: { direction: [bloomTexel[0], 0], padding: [0, 0] },
    source: targets.bloomA,
    source_sampler: linearSampler,
  });
  scene.blurVertical.set({
    params: { direction: [0, bloomTexel[1]], padding: [0, 0] },
    source: targets.bloomB,
    source_sampler: linearSampler,
  });
  scene.present.set({
    params: { bloom: BLOOM_STRENGTH, time: 0, padding: [0, 0] },
    scene: targets.scene,
    bloom: targets.bloomA,
    scene_sampler: linearSampler,
  });
}

function easeRig(current: MutableRig, goal: LightRig, blend: number): void {
  for (let i = 0; i < 3; i++) {
    current.keyColor[i] += (goal.keyColor[i] - current.keyColor[i]) * blend;
    current.rimColor[i] += (goal.rimColor[i] - current.rimColor[i]) * blend;
    current.backgroundTop[i] +=
      (goal.backgroundTop[i] - current.backgroundTop[i]) * blend;
    current.backgroundBottom[i] +=
      (goal.backgroundBottom[i] - current.backgroundBottom[i]) * blend;
  }
  current.keyPower += (goal.keyPower - current.keyPower) * blend;
  current.rimPower += (goal.rimPower - current.rimPower) * blend;
  current.floorLuminance +=
    (goal.floorLuminance - current.floorLuminance) * blend;
}

function copyRig(rig: LightRig): MutableRig {
  return {
    keyColor: [...rig.keyColor],
    keyPower: rig.keyPower,
    rimColor: [...rig.rimColor],
    rimPower: rig.rimPower,
    backgroundTop: [...rig.backgroundTop],
    backgroundBottom: [...rig.backgroundBottom],
    floorLuminance: rig.floorLuminance,
  };
}

function clampScale(scale: number): number {
  return Number.isFinite(scale) ? Math.max(0.25, Math.min(1, scale)) : 0.75;
}

function destroyResource(resource: object): void {
  (resource as { destroy?: () => void }).destroy?.();
}

function rethrow(error: unknown, ...cleanups: readonly (() => void)[]): never {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Cleanup must not mask the primary failure.
    }
  }
  throw error;
}
