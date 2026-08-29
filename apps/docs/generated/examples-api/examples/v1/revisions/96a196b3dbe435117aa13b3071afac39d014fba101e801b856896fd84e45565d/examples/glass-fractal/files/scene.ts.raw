import type { Draw, Effect, Gpu, Surface, Target } from "vgpu";
import { draw, effect, frame, sampler, target } from "vgpu";
import { perspectiveCamera } from "vgpu/scene";

import type { HeroGlassAssets } from "./hero-glass-assets-core";
import heroFractalBackgroundDrawWgsl from "./hero-fractal-background-draw.wgsl";
import heroFractalMeshWgsl from "./hero-fractal-mesh.wgsl";
import heroFractalPresentWgsl from "./hero-fractal-present.wgsl";
import heroGlassTransmissionWgsl from "./hero-glass-transmission.wgsl";
import heroGlassWgsl from "./hero-glass.wgsl";
import type {
  HeroFractalCamera,
  HeroFractalGlass,
  HeroFractalMaterial,
} from "./settings";

const HERO_LIGHT_CLEAR = 250 / 255;
const GLASS_MODEL_MATRIX = modelMatrix(1, [0, 0, 0]);
export const HERO_FLOOR_AO_DEFAULTS = {
  glassAoScale: 0.54,
  glassAoAmplitude: 0.41,
  glassAoOpacity: 0.11,
  fractalAoScale: 0.88,
  fractalAoAmplitude: 0.18,
  fractalAoOpacity: 0.57,
  orbAoScale: 0.58,
  orbAoAmplitude: 0.59,
  orbAoOpacity: 0.73,
};

export type HeroFloorAo = typeof HERO_FLOOR_AO_DEFAULTS;

type SceneOutput = Surface | Target;

export interface HeroFractalScene {
  readonly present: Effect;
  readonly background: Draw;
  readonly glassBack: Draw;
  readonly fractal: Draw;
  readonly glassFront: Draw;
  readonly interior: Target;
  readonly sceneSampler: GPUSampler;
  readonly environmentSampler: GPUSampler;
}

export interface HeroFractalSceneSettings {
  readonly camera: Readonly<HeroFractalCamera>;
  readonly fractalMaterial: Readonly<HeroFractalMaterial>;
  readonly orbMaterial: Readonly<HeroFractalMaterial>;
  readonly glass: Readonly<HeroFractalGlass>;
  readonly time?: number;
  readonly view?: {
    readonly position: readonly [number, number, number];
    readonly target: readonly [number, number, number];
    readonly up: readonly [number, number, number];
    readonly fov: number;
    readonly pointer: readonly [number, number];
    readonly maxMouseRotation: number;
  };
  readonly floorAo?: Readonly<HeroFloorAo>;
  readonly floorGrid?: boolean;
  readonly morphDirection?: number;
  readonly reflectionDebug?: boolean;
}

export interface HeroFractalFrameState {
  readonly viewProjection: Float32Array;
  readonly environmentRotation: Float32Array;
  readonly fractalModel: Float32Array;
  readonly sphereMix: number;
  readonly time: number;
}

export function createCameraControls(camera: Readonly<HeroFractalCamera>) {
  return {
    position: add3(
      camera.cameraTarget,
      rotateCamera(camera.cameraDistance, camera.cameraRotation)
    ),
    target: [...camera.cameraTarget] as [number, number, number],
    up: rotateCamera([0, 1, 0], camera.cameraRotation),
    fov: camera.fov,
    maxMouseRotation: camera.maxMouseRotation,
    mouseLerp: camera.mouseLerp,
  };
}

/** Creates and compiles the production GPU scene shared by browser and headless rendering. */
export async function createHeroFractalScene(
  gpu: Gpu,
  output: SceneOutput,
  assets: HeroGlassAssets,
  label = "homepage-light"
): Promise<HeroFractalScene> {
  const scene = {
    present: effect(gpu, heroFractalPresentWgsl, {
      blend: "premultiplied",
      label: `${label}-fractal-present`,
    }),
    background: draw(gpu, {
      shader: heroFractalBackgroundDrawWgsl,
      vertices: 3,
      depth: false,
      label: `${label}-fractal-background`,
    }),
    glassBack: draw(gpu, {
      shader: heroGlassWgsl,
      geometry: assets.geometry,
      cull: "front",
      depth: { write: false },
      blend: "premultiplied",
      label: `${label}-glass-back`,
    }),
    fractal: draw(gpu, {
      shader: heroFractalMeshWgsl,
      geometry: assets.fractalGeometry,
      instances: 4,
      cull: "back",
      label: `${label}-fractal-face-instances-l7`,
    }),
    glassFront: draw(gpu, {
      shader: heroGlassTransmissionWgsl,
      geometry: assets.geometry,
      cull: "back",
      depth: false,
      label: `${label}-glass-front-transmission`,
    }),
    sceneSampler: sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    }),
    environmentSampler: sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    }),
    interior: target(gpu, {
      size: output.size,
      format: output.format,
      depth: true,
      label: `${label}-fractal-glass-interior`,
    }),
  } satisfies HeroFractalScene;

  try {
    await Promise.all([
      scene.background.compile(scene.interior),
      scene.glassBack.compile(scene.interior),
      scene.fractal.compile(scene.interior),
      scene.glassFront.compile({ colors: [output.format] }),
      scene.present.compile({ colors: [output.format] }),
    ]);
    return scene;
  } catch (error) {
    try {
      destroyHeroFractalScene(scene);
    } catch {
      // Preserve the compilation failure.
    }
    throw error;
  }
}

/** Applies the deterministic, input-free state used by the thumbnail renderer. */
export function setHeroFractalSceneSettings(
  scene: HeroFractalScene,
  assets: HeroGlassAssets,
  resolution: readonly [number, number],
  settings: HeroFractalSceneSettings
): HeroFractalFrameState {
  const { camera, fractalMaterial, orbMaterial, glass } = settings;
  const target = settings.view?.target ?? camera.cameraTarget;
  const up =
    settings.view?.up ?? rotateCamera([0, 1, 0], camera.cameraRotation);
  const basePosition =
    settings.view?.position ??
    add3(target, rotateCamera(camera.cameraDistance, camera.cameraRotation));
  const position = settings.view
    ? orbitCameraPosition(
        basePosition,
        target,
        up,
        settings.view.pointer,
        settings.view.maxMouseRotation
      )
    : basePosition;
  const fov = settings.view?.fov ?? camera.fov;
  const view = perspectiveCamera({
    fov,
    aspect: resolution[0] / Math.max(resolution[1], 1),
    near: 0.05,
    far: 20,
    position,
    target,
    up,
  });
  const materialMix = clamp01(glass.sphereMix);
  const innerScale =
    glass.fractalScale * (1 - materialMix) + glass.orbScale * materialMix;
  const material = blendMaterial(fractalMaterial, orbMaterial, materialMix);
  const environmentRotation = environmentRotationMatrix(
    glass.environmentRotation
  );
  const fractalModel = modelMatrix(innerScale, [
    0,
    glass.orbOffsetY * materialMix,
    0,
  ]);
  const time = settings.time ?? 0;

  scene.background.set({
    params: {
      resolution,
      cameraPosition: position,
      cameraTarget: target,
      cameraUp: up,
      tanHalfFov: Math.tan((fov * Math.PI) / 360),
      floorGrid: settings.floorGrid ? 1 : 0,
      fractalScale: glass.fractalScale,
      orbScale: glass.orbScale,
      sphereMix: materialMix,
      ...(settings.floorAo ?? HERO_FLOOR_AO_DEFAULTS),
    },
  });
  const glassParams = {
    viewProjection: view.viewProjectionMatrix,
    model: GLASS_MODEL_MATRIX,
    cameraPosition: position,
    meshMin: assets.meshMin,
    meshMax: assets.meshMax,
    resolution,
    fractalScale: innerScale,
    ior: glass.ior,
    reflectionStrength: glass.reflectionStrength,
    backOpacity: glass.backOpacity,
    absorption: glass.absorption,
    frostRadius: glass.frostRadius,
    dispersion: glass.dispersion,
    iridescenceStrength: glass.iridescenceStrength,
    iridescenceFrequency: glass.iridescenceFrequency,
    environmentRotation,
    environmentExposure: glass.environmentExposure,
    reflectionDebug: settings.reflectionDebug ? 1 : 0,
  };
  scene.glassBack.set({
    params: glassParams,
    environmentTexture: assets.environmentView,
    environmentSampler: scene.environmentSampler,
  });
  scene.fractal.set({
    params: {
      viewProjection: view.viewProjectionMatrix,
      model: fractalModel,
      cameraPosition: position,
      meshMin: assets.fractalMeshMin,
      meshMax: assets.fractalMeshMax,
      sphereMix: glass.sphereMix * (settings.morphDirection ?? 1),
      time,
      material,
      environmentRotation,
      environmentExposure: glass.environmentExposure,
    },
    environmentTexture: assets.environmentView,
    environmentSampler: scene.environmentSampler,
  });
  scene.glassFront.set({
    params: glassParams,
    environmentTexture: assets.environmentView,
    environmentSampler: scene.environmentSampler,
    sceneTexture: scene.interior,
    sceneSampler: scene.sceneSampler,
  });
  scene.present.set({ sceneTexture: scene.interior });
  return {
    viewProjection: view.viewProjectionMatrix as Float32Array,
    environmentRotation,
    fractalModel,
    sphereMix: glass.sphereMix * (settings.morphDirection ?? 1),
    time,
  };
}

export function renderHeroFractalScene(
  gpu: Gpu,
  output: SceneOutput,
  scene: HeroFractalScene,
  finalDebugDraws: readonly Draw[] = []
): void {
  frame(gpu, (currentFrame) => {
    currentFrame.pass(
      {
        target: scene.interior,
        clear: [HERO_LIGHT_CLEAR, HERO_LIGHT_CLEAR, HERO_LIGHT_CLEAR, 1],
      },
      (pass) => {
        pass.draw(scene.background);
        pass.draw(scene.glassBack);
        pass.draw(scene.fractal);
      }
    );
    currentFrame.pass(
      {
        target: output,
        clear: [HERO_LIGHT_CLEAR, HERO_LIGHT_CLEAR, HERO_LIGHT_CLEAR, 1],
      },
      (pass) => {
        pass.draw(scene.present);
        pass.draw(scene.glassFront);
        for (const debugDraw of finalDebugDraws) pass.draw(debugDraw);
      }
    );
  });
}

export function resizeHeroFractalScene(
  scene: HeroFractalScene,
  size: readonly [number, number]
): void {
  scene.interior.resize(size);
}

export function destroyHeroFractalScene(scene: HeroFractalScene): void {
  (scene.interior as Target & { destroy?: () => void }).destroy?.();
}

function blendMaterial(
  fractal: Readonly<HeroFractalMaterial>,
  orb: Readonly<HeroFractalMaterial>,
  mix: number
): HeroFractalMaterial {
  const interpolate = (a: number, b: number) => a * (1 - mix) + b * mix;
  return {
    baseColor: [
      interpolate(fractal.baseColor[0], orb.baseColor[0]),
      interpolate(fractal.baseColor[1], orb.baseColor[1]),
      interpolate(fractal.baseColor[2], orb.baseColor[2]),
    ],
    roughness: interpolate(fractal.roughness, orb.roughness),
    diffuseStrength: interpolate(fractal.diffuseStrength, orb.diffuseStrength),
    specularStrength: interpolate(
      fractal.specularStrength,
      orb.specularStrength
    ),
    ambientStrength: interpolate(fractal.ambientStrength, orb.ambientStrength),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rotateCamera(
  vector: readonly [number, number, number],
  rotation: readonly [number, number, number]
): [number, number, number] {
  const cz = Math.cos(rotation[2]);
  const sz = Math.sin(rotation[2]);
  const rolled: [number, number, number] = [
    cz * vector[0] - sz * vector[1],
    sz * vector[0] + cz * vector[1],
    vector[2],
  ];
  const cx = Math.cos(rotation[0]);
  const sx = Math.sin(rotation[0]);
  const pitched: [number, number, number] = [
    rolled[0],
    cx * rolled[1] + sx * rolled[2],
    -sx * rolled[1] + cx * rolled[2],
  ];
  const cy = Math.cos(rotation[1]);
  const sy = Math.sin(rotation[1]);
  return [
    cy * pitched[0] + sy * pitched[2],
    pitched[1],
    -sy * pitched[0] + cy * pitched[2],
  ];
}

function add3(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function modelMatrix(
  scale: number,
  translation: readonly [number, number, number]
): Float32Array {
  return new Float32Array([
    scale,
    0,
    0,
    0,
    0,
    scale,
    0,
    0,
    0,
    0,
    scale,
    0,
    translation[0],
    translation[1],
    translation[2],
    1,
  ]);
}

function orbitCameraPosition(
  position: readonly [number, number, number],
  target: readonly [number, number, number],
  up: readonly [number, number, number],
  pointer: readonly [number, number],
  maxRotationDegrees: number
): readonly [number, number, number] {
  if (maxRotationDegrees === 0 || (pointer[0] === 0 && pointer[1] === 0)) {
    return position;
  }
  const maxRotation = (maxRotationDegrees * Math.PI) / 180;
  const upAxis = normalize3(up, [0, 1, 0]);
  const offset = subtract3(position, target);
  const yawedOffset = rotateAroundAxis(
    offset,
    upAxis,
    -pointer[0] * maxRotation
  );
  const rightAxis = normalize3(
    cross3(scale3(yawedOffset, -1), upAxis),
    [0, 0, 1]
  );
  return add3(
    target,
    rotateAroundAxis(yawedOffset, rightAxis, pointer[1] * maxRotation)
  );
}

function rotateAroundAxis(
  vector: readonly [number, number, number],
  axis: readonly [number, number, number],
  angle: number
): [number, number, number] {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const projection = dot3(axis, vector) * (1 - cosine);
  const perpendicular = cross3(axis, vector);
  return [
    vector[0] * cosine + perpendicular[0] * sine + axis[0] * projection,
    vector[1] * cosine + perpendicular[1] * sine + axis[1] * projection,
    vector[2] * cosine + perpendicular[2] * sine + axis[2] * projection,
  ];
}

function normalize3(
  vector: readonly [number, number, number],
  fallback: readonly [number, number, number]
): [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length < 0.000001
    ? [...fallback]
    : [vector[0] / length, vector[1] / length, vector[2] / length];
}

function subtract3(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale3(
  vector: readonly [number, number, number],
  scale: number
): [number, number, number] {
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function cross3(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function environmentRotationMatrix(
  rotationDegrees: readonly [number, number, number]
): Float32Array {
  const toRadians = -Math.PI / 180;
  const rotation = rotationDegrees.map((value) => value * toRadians);
  const cx = Math.cos(rotation[0]!);
  const sx = Math.sin(rotation[0]!);
  const cy = Math.cos(rotation[1]!);
  const sy = Math.sin(rotation[1]!);
  const cz = Math.cos(rotation[2]!);
  const sz = Math.sin(rotation[2]!);

  return new Float32Array([
    cz * cy,
    sz * cy,
    -sy,
    0,
    cz * sy * sx - sz * cx,
    sz * sy * sx + cz * cx,
    cy * sx,
    0,
    cz * sy * cx + sz * sx,
    sz * sy * cx - cz * sx,
    cy * cx,
    0,
    0,
    0,
    0,
    1,
  ]);
}
