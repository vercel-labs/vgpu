import {
  effect,
  sampler,
  target,
  type Effect,
  type Frame,
  type Gpu,
  type Surface,
  type Target,
} from 'vgpu';
import type { CameraState } from './camera';
import bloomBlurWgsl from './bloom-blur.wgsl';
import bloomExtractWgsl from './bloom-extract.wgsl';
import presentWgsl from './present.wgsl';
import sculptureWgsl from './sculpture.wgsl';

type Output = Surface | Target;
type Vec3 = readonly [number, number, number];

export const SHAPES = ['knot', 'gyroid', 'droplets'] as const;
export const GLASS_TINTS = ['clear', 'rose', 'cobalt', 'emerald'] as const;
export const LIGHT_RIG_NAMES = ['studio', 'noir', 'gel', 'golden'] as const;
export const RENDER_SCALES = [0.5, 0.75, 1] as const;

export type Shape = (typeof SHAPES)[number];
export type GlassTint = (typeof GLASS_TINTS)[number];
export type LightRigName = (typeof LIGHT_RIG_NAMES)[number];
export type RenderScale = (typeof RENDER_SCALES)[number];

export interface SculptureControls {
  shape: Shape;
  glass: GlassTint;
  light: LightRigName;
  dispersion: boolean;
  spin: boolean;
  renderScale: RenderScale;
}

export const DEFAULT_CONTROLS: SculptureControls = {
  shape: 'gyroid',
  glass: 'clear',
  light: 'studio',
  dispersion: true,
  spin: true,
  renderScale: 0.75,
};

interface LightRig {
  readonly keyColor: Vec3;
  readonly keyPower: number;
  readonly rimColor: Vec3;
  readonly rimPower: number;
  readonly backgroundTop: Vec3;
  readonly backgroundBottom: Vec3;
  readonly floorLuminance: number;
}

interface MutableLightRig {
  keyColor: [number, number, number];
  keyPower: number;
  rimColor: [number, number, number];
  rimPower: number;
  backgroundTop: [number, number, number];
  backgroundBottom: [number, number, number];
  floorLuminance: number;
}

const LIGHT_RIGS: Readonly<Record<LightRigName, LightRig>> = {
  studio: {
    keyColor: [1, 0.92, 0.82],
    keyPower: 6,
    rimColor: [0.65, 0.8, 1],
    rimPower: 5,
    backgroundTop: [0.95, 0.96, 1],
    backgroundBottom: [0.3, 0.31, 0.34],
    floorLuminance: 1.4,
  },
  noir: {
    keyColor: [1, 0.97, 0.92],
    keyPower: 16,
    rimColor: [0.35, 0.45, 0.8],
    rimPower: 9,
    backgroundTop: [0.1, 0.1, 0.12],
    backgroundBottom: [0.02, 0.02, 0.03],
    floorLuminance: 1.6,
  },
  gel: {
    keyColor: [1, 0.4, 0.3],
    keyPower: 11,
    rimColor: [0.15, 0.8, 1],
    rimPower: 11,
    backgroundTop: [0.16, 0.08, 0.22],
    backgroundBottom: [0.04, 0.02, 0.07],
    floorLuminance: 1.3,
  },
  golden: {
    keyColor: [1, 0.72, 0.42],
    keyPower: 9,
    rimColor: [0.45, 0.55, 0.9],
    rimPower: 3,
    backgroundTop: [1, 0.78, 0.55],
    backgroundBottom: [0.36, 0.2, 0.14],
    floorLuminance: 1.25,
  },
};

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const BLOOM_STRENGTH = 0.45;
const RIG_EASE_RATE = 2.45;

interface SceneTargets {
  readonly hdr: Target;
  readonly bloomA: Target;
  readonly bloomB: Target;
}

export interface SculptureScene {
  prepare(output: Output): Promise<void>;
  resize(outputSize: readonly [number, number], renderScale: number): void;
  render(
    currentFrame: Frame,
    output: Output,
    camera: CameraState,
    controls: Readonly<SculptureControls>,
    state: {
      readonly sculptureTime: number;
      readonly clockTime: number;
      readonly deltaTime: number;
      readonly light: { readonly azimuth: number; readonly elevation: number };
    },
  ): void;
  destroy(): void;
}

export function createScene(
  gpu: Gpu,
  output: Output,
  controls: Readonly<SculptureControls>,
): SculptureScene {
  const linearSampler = sampler(gpu, {
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const sculpture = effect(gpu, sculptureWgsl, { label: 'glass-sculpture' });
  const extract = effect(gpu, bloomExtractWgsl, { label: 'glass-sculpture-bloom-extract' });
  const blurHorizontal = effect(gpu, bloomBlurWgsl, { label: 'glass-sculpture-bloom-horizontal' });
  const blurVertical = effect(gpu, bloomBlurWgsl, { label: 'glass-sculpture-bloom-vertical' });
  const present = effect(gpu, presentWgsl, { label: 'glass-sculpture-present' });
  const targets = createTargets(gpu, output.size, controls.renderScale);
  const rig = copyRig(LIGHT_RIGS[controls.light]);
  let destroyed = false;

  try {
    bindTargets();
  } catch (error) {
    destroyTarget(targets.bloomB);
    destroyTarget(targets.bloomA);
    destroyTarget(targets.hdr);
    throw error;
  }

  return {
    async prepare(currentOutput) {
      await Promise.all([
        sculpture.compile(targets.hdr),
        extract.compile(targets.bloomA),
        blurHorizontal.compile(targets.bloomB),
        blurVertical.compile(targets.bloomA),
        present.compile({ colors: [currentOutput.format] }),
      ]);
    },
    resize(outputSize, renderScale) {
      if (destroyed) return;
      const [width, height] = scaledSize(outputSize, renderScale);
      targets.hdr.resize([width, height]);
      const bloomSize: [number, number] = [
        Math.max(1, Math.floor(width / 4)),
        Math.max(1, Math.floor(height / 4)),
      ];
      targets.bloomA.resize(bloomSize);
      targets.bloomB.resize(bloomSize);
      bindTargets();
    },
    render(currentFrame, currentOutput, camera, currentControls, state) {
      if (destroyed) return;
      easeRig(rig, LIGHT_RIGS[currentControls.light], state.deltaTime);
      const keyDirection = lightDirection(camera.yaw + state.light.azimuth, state.light.elevation);
      const rimDirection = lightDirection(camera.yaw + state.light.azimuth + Math.PI * 0.85, 0.35);
      sculpture.set({
        params: {
          resolution: targets.hdr.size,
          shape: SHAPES.indexOf(currentControls.shape),
          tint: GLASS_TINTS.indexOf(currentControls.glass),
          time: state.sculptureTime,
          quality: currentControls.renderScale,
          yaw: camera.yaw,
          pitch: camera.pitch,
          radius: camera.radius,
          dispersion: currentControls.dispersion ? 1 : 0,
          strip_angle: 0.8 + state.clockTime * 0.1,
          floor_luminance: rig.floorLuminance,
          padding: 0,
          key: [...keyDirection, rig.keyPower],
          key_color: [...rig.keyColor, 0],
          rim: [...rimDirection, rig.rimPower],
          rim_color: [...rig.rimColor, 0],
          background_top: [...rig.backgroundTop, 0],
          background_bottom: [...rig.backgroundBottom, 0],
        },
      });
      present.set({ params: { time: state.clockTime } });
      currentFrame.pass(targets.hdr, sculpture);
      currentFrame.pass(targets.bloomA, extract);
      currentFrame.pass(targets.bloomB, blurHorizontal);
      currentFrame.pass(targets.bloomA, blurVertical);
      currentFrame.pass(currentOutput, present);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      destroyTarget(targets.bloomB);
      destroyTarget(targets.bloomA);
      destroyTarget(targets.hdr);
    },
  };

  function bindTargets() {
    extract.set({
      params: {
        texel: targets.hdr.texelSize,
        threshold: 1,
        padding: 0,
      },
      source: targets.hdr,
      linear_sampler: linearSampler,
    });
    blurHorizontal.set({
      params: { direction: [targets.bloomA.texelSize[0], 0], padding: [0, 0] },
      source: targets.bloomA,
      linear_sampler: linearSampler,
    });
    blurVertical.set({
      params: { direction: [0, targets.bloomB.texelSize[1]], padding: [0, 0] },
      source: targets.bloomB,
      linear_sampler: linearSampler,
    });
    present.set({
      params: { bloom_strength: BLOOM_STRENGTH, time: 0, padding: [0, 0] },
      scene_texture: targets.hdr,
      bloom_texture: targets.bloomA,
      linear_sampler: linearSampler,
    });
  }
}

function createTargets(gpu: Gpu, outputSize: readonly [number, number], renderScale: number): SceneTargets {
  const owned: Target[] = [];
  const own = (created: Target) => {
    owned.push(created);
    return created;
  };
  try {
    const [width, height] = scaledSize(outputSize, renderScale);
    const bloomSize: [number, number] = [
      Math.max(1, Math.floor(width / 4)),
      Math.max(1, Math.floor(height / 4)),
    ];
    return {
      hdr: own(target(gpu, { size: [width, height], format: HDR_FORMAT, label: 'glass-sculpture-hdr' })),
      bloomA: own(target(gpu, { size: bloomSize, format: HDR_FORMAT, label: 'glass-sculpture-bloom-a' })),
      bloomB: own(target(gpu, { size: bloomSize, format: HDR_FORMAT, label: 'glass-sculpture-bloom-b' })),
    };
  } catch (error) {
    for (const resource of owned.reverse()) destroyTarget(resource);
    throw error;
  }
}

function scaledSize(size: readonly [number, number], renderScale: number): [number, number] {
  const scale = Number.isFinite(renderScale)
    ? Math.max(RENDER_SCALES[0], Math.min(RENDER_SCALES.at(-1)!, renderScale))
    : DEFAULT_CONTROLS.renderScale;
  return [
    Math.max(1, Math.floor(size[0] * scale)),
    Math.max(1, Math.floor(size[1] * scale)),
  ];
}

function lightDirection(azimuth: number, elevation: number): Vec3 {
  const radius = Math.cos(elevation);
  return [Math.sin(azimuth) * radius, Math.sin(elevation), Math.cos(azimuth) * radius];
}

function copyRig(source: LightRig): MutableLightRig {
  return {
    keyColor: [...source.keyColor],
    keyPower: source.keyPower,
    rimColor: [...source.rimColor],
    rimPower: source.rimPower,
    backgroundTop: [...source.backgroundTop],
    backgroundBottom: [...source.backgroundBottom],
    floorLuminance: source.floorLuminance,
  };
}

function easeRig(current: MutableLightRig, goal: LightRig, deltaTime: number): void {
  const blend = 1 - Math.exp(-RIG_EASE_RATE * Math.max(0, Math.min(0.1, deltaTime)));
  for (let channel = 0; channel < 3; channel++) {
    current.keyColor[channel] += (goal.keyColor[channel] - current.keyColor[channel]) * blend;
    current.rimColor[channel] += (goal.rimColor[channel] - current.rimColor[channel]) * blend;
    current.backgroundTop[channel] += (goal.backgroundTop[channel] - current.backgroundTop[channel]) * blend;
    current.backgroundBottom[channel] += (goal.backgroundBottom[channel] - current.backgroundBottom[channel]) * blend;
  }
  current.keyPower += (goal.keyPower - current.keyPower) * blend;
  current.rimPower += (goal.rimPower - current.rimPower) * blend;
  current.floorLuminance += (goal.floorLuminance - current.floorLuminance) * blend;
}

function destroyTarget(resource: Target): void {
  (resource as Target & { destroy(): void }).destroy();
}

export function normalizeControls(controls: Readonly<SculptureControls>): SculptureControls {
  return {
    shape: SHAPES.includes(controls.shape) ? controls.shape : DEFAULT_CONTROLS.shape,
    glass: GLASS_TINTS.includes(controls.glass) ? controls.glass : DEFAULT_CONTROLS.glass,
    light: LIGHT_RIG_NAMES.includes(controls.light) ? controls.light : DEFAULT_CONTROLS.light,
    dispersion: controls.dispersion === true,
    spin: controls.spin !== false,
    renderScale: RENDER_SCALES.includes(controls.renderScale)
      ? controls.renderScale
      : DEFAULT_CONTROLS.renderScale,
  };
}
