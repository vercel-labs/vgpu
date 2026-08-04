import type { Draw, Effect, Frame, Gpu, Geometry, Surface, Target } from 'vgpu';
import type { Texture } from 'vgpu/core';
import { box, plane } from 'vgpu/scene';

import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import { cameraView, DEFAULT_PITCH, DEFAULT_YAW, modelMatrix, translationMatrix, type CameraView } from './camera';
import { installOrbitInput } from './pointer-input';
import { DEFAULT_TRANSMISSION_CONTROLS, type TransmissionControls } from './types';
import skyWgsl from './sky.wgsl';
import blurWgsl from './blur.wgsl';
import backgroundWgsl from './scene-background.wgsl';
import floorWgsl from './floor.wgsl';
import backfaceWgsl from './backface-normal.wgsl';
import glassWgsl from './glass.wgsl';
import presentWgsl from './present.wgsl';
import { draw, effect, frame, geometry, sampler, surface, target } from "vgpu";

type Output = Surface | Target;

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
/** 2:1 is the equirectangular aspect: 360° of yaw by 180° of pitch. */
const ENV_SIZE: readonly [number, number] = [2048, 1024];
/** Levels of the prefiltered environment pyramid: 2048×1024 down to 16×8. */
const ENV_LEVELS = 8;
/** Levels of the screen-space scene pyramid, rebuilt every frame; roughness reads them. */
const SCENE_LEVELS = 8;
/** Gaussian radius in destination texels; ~1 keeps each level one octave blurrier. */
const BLUR_RADIUS = 1.15;
const CUBE_SIZE = 1.3;
const FLOOR_SIZE = 90;
const FLOOR_HEIGHT = -1.05;
const EXPOSURE = 0.95;
/** Angle covered by one texel of level 0, the unit every environment LOD is measured against. */
const TEXEL_ANGLE = (2 * Math.PI) / ENV_SIZE[0];

const SKY = {
  sun_direction: [-0.724, 0.09, -0.684],
  sun_angular_size: 0.018,
  sun_color: [1.0, 0.88, 0.72],
  sun_intensity: 26,
  zenith_color: [0.05, 0.15, 0.44],
  cloud_coverage: 0.56,
  horizon_color: [0.36, 0.48, 0.74],
  cloud_scale: 0.75,
  ground_color: [0.05, 0.05, 0.056],
  ground_scale: 4.6,
} as const;

const FLOOR = {
  checker_scale: 0.85,
  /** Half-angle of the floor's reflection cone, in radians: a wide, satin sky reflection. */
  reflection_roughness: 0.045,
  horizon_color: SKY.horizon_color,
  texel_angle: TEXEL_ANGLE,
  base_color: [0.052, 0.055, 0.062],
  fade_distance: 26,
  env_size: ENV_SIZE,
  sun_direction: SKY.sun_direction,
} as const;

const GLASS = {
  /** Ray length inside the solid in `simple` mode; `double` measures the real one. */
  thickness: 0.85,
  /** Beer-Lambert absorption per world unit: a faint bottle-glass tint. */
  absorption: [0.3, 0.1, 0.16],
  env_size: ENV_SIZE,
  texel_angle: TEXEL_ANGLE,
  /**
   * IOR distance between the red and the blue end of the spectral sweep.
   *
   * Wider than a real soda-lime glass (whose whole visible spread is ~0.01) because the
   * cube is small and the rainbow has to survive a 1280px thumbnail; the samples in
   * between keep it continuous instead of turning the extra width into hard bands.
   */
  dispersion_spread: 0.09,
} as const;

interface LevelTargets {
  readonly size: readonly [number, number];
  readonly horizontal: Target;
  readonly vertical: Target;
}

interface Targets {
  readonly size: readonly [number, number];
  /** Scene colour + depth: sky, floor, and later the glass composited on top. */
  readonly hdr: Target;
  /** Back-face normal (rgb) and camera distance (a) of the cube. */
  readonly backface: Target;
  /** Mip pyramid of the scene, the source every refraction reads. */
  readonly pyramid: Texture;
  readonly levels: number;
  readonly chain: readonly LevelTargets[];
}

interface BlurPair {
  readonly horizontal: Effect;
  readonly vertical: Effect;
}

interface Scene {
  readonly env: Texture;
  readonly envSampler: GPUSampler;
  /** Trilinear: roughness lands on a fractional LOD of the scene pyramid. */
  readonly pyramidSampler: GPUSampler;
  readonly screenSampler: GPUSampler;
  readonly cubeGeometry: Geometry;
  readonly floorGeometry: Geometry;
  readonly background: Draw;
  readonly floor: Draw;
  readonly backface: Draw;
  readonly glass: Draw;
  readonly present: Effect;
  /** One instance per pass: two effects sharing a frame would alias their uniforms. */
  readonly blurs: readonly BlurPair[];
  targets: Targets;
}

export function createRenderer(options: BrowserRendererOptions<TransmissionControls>): ExampleRenderer<TransmissionControls> {
  let disposed = false;
  let reportedError = false;
  let controls: TransmissionControls = normalizeControls(options.initialControls ?? DEFAULT_TRANSMISSION_CONTROLS);
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let scene: Scene | undefined;
  let input: ReturnType<typeof installOrbitInput> | undefined;
  let animationFrame = 0;
  let previous = 0;
  let observer: ResizeObserver | undefined;
  let unsubscribeResize: (() => void) | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  let sawInitialResize = false;

  const onSurfaceResize = () => {
    // The surface replays its current size on subscribe; the targets were just built at
    // that size, so only later reports are real resizes.
    if (!sawInitialResize) { sawInitialResize = true; return; }
    if (disposed || !gpu || !scene || !canvasSurface) return;
    try {
      const next = createTargets(gpu, canvasSurface.size, 'transmission-live');
      destroyTargets(scene.targets);
      scene.targets = next;
      bindTargets(scene);
    } catch (error) {
      handleFailure(error);
    }
  };

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !canvasSurface) return;
    try {
      canvasSurface.resize([
        Math.max(1, Math.round(size.width * size.dpr)),
        Math.max(1, Math.round(size.height * size.dpr)),
      ]);
    } catch (error) {
      handleFailure(error);
    }
  };
  const resize = (size: RenderSize) => {
    if (disposed || size.width <= 0 || size.height <= 0) return;
    pendingSize = size;
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };
  const measure = () => {
    const rect = options.canvas.getBoundingClientRect();
    resize({
      width: rect.width,
      height: rect.height,
      dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
    });
  };
  const onWindowResize = () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    measure();
  };

  const setControls = (next: Readonly<TransmissionControls>) => {
    if (disposed) return;
    controls = normalizeControls(next);
  };

  // One rendered frame is three submits — scene + blur chain, the mip copies, then glass
  // and present — so the loop is a plain rAF instead of `frameLoop`, which owns the
  // whole frame and rejects the nested `frame(gpu)` calls the copies sit between.
  const tick = (now: number) => {
    animationFrame = 0;
    if (disposed) return;
    if (!document.hidden && gpu && canvasSurface && scene && input) {
      try {
        input.advance((now - previous) / 1000);
        const view = cameraView(input.yaw, input.pitch, aspectOf(canvasSurface), input.radius);
        renderScene(gpu, scene, canvasSurface, view, controls);
      } catch (error) {
        handleFailure(error);
        return;
      }
    }
    // Always reset the clock while hidden so visibility changes never catch up at once.
    previous = now;
    animationFrame = requestAnimationFrame(tick);
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    pendingSize = undefined;
    observer?.disconnect();
    observer = undefined;
    if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
    unsubscribeResize?.();
    unsubscribeResize = undefined;
    input?.dispose();
    input = undefined;
    if (scene) destroyScene(scene);
    scene = undefined;
    canvasSurface?.dispose();
    canvasSurface = undefined;
    gpu?.dispose();
    gpu = undefined;
  }

  function handleFailure(error: unknown): void {
    if (disposed) return;
    if (!reportedError) {
      reportedError = true;
      try { options.onError?.(error); } catch { /* error reporting must not block teardown */ }
    }
    dispose();
  }

  const initialize = async () => {
    const { init } = await import('vgpu');
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) { nextGpu.dispose(); return; }
    gpu = nextGpu;
    canvasSurface = surface(gpu, options.canvas, { dpr: [1, 2] });
    scene = await createScene(gpu, canvasSurface, 'transmission-live');
    if (disposed) return;
    input = installOrbitInput(options.canvas);
    unsubscribeResize = canvasSurface.onResize(onSurfaceResize);
    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    window.addEventListener('resize', onWindowResize);
    measure();
    previous = performance.now();
    animationFrame = requestAnimationFrame(tick);
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    handleFailure(error);
    throw error;
  });

  return { ready, setControls, invalidate() {}, resize, dispose };
}

export async function renderThumbnail(gpu: Gpu, output: Target, opts: ThumbnailOptions = {}): Promise<void> {
  const scene = await createScene(gpu, output, 'transmission-thumb');
  try {
    // Fixed camera and controls: nothing here reads the clock, so every run of the
    // headless renderer produces the same pixels.
    const view = cameraView(DEFAULT_YAW, DEFAULT_PITCH, aspectOf(output));
    for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 3); i++) {
      renderScene(gpu, scene, output, view, DEFAULT_TRANSMISSION_CONTROLS);
    }
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    destroyScene(scene);
  }
}

async function createScene(gpu: Gpu, output: Output, label: string): Promise<Scene> {
  const envSampler = sampler(gpu, {
    minFilter: 'linear',
    magFilter: 'linear',
    // Trilinear: roughness lands on a fractional LOD, so neighbouring levels must blend.
    mipmapFilter: 'linear',
    // u wraps the horizon; v must clamp so the poles never bleed across.
    addressModeU: 'repeat',
    addressModeV: 'clamp-to-edge',
  });
  const pyramidSampler = sampler(gpu, {
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'linear',
    // Screen space: a refracted ray that grazes the border must not wrap around.
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const screenSampler = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });

  const env = await bakeEnvironment(gpu, envSampler, label);
  const targets = createTargets(gpu, output.size, label);

  const cubeGeometry = geometry(gpu, box({ size: CUBE_SIZE }));
  const floorGeometry = geometry(gpu, plane({ width: FLOOR_SIZE, height: FLOOR_SIZE, widthSegments: 1, heightSegments: 1 }));

  // The sky covers the frame from the far plane without touching depth, so the floor and
  // the cube behind it still resolve against each other normally.
  const background = draw(gpu, {
    shader: backgroundWgsl,
    vertices: 3,
    depth: { write: false, compare: 'always' },
    label: `${label}-background`,
  });
  background.set({ env_tex: env, env_samp: envSampler });

  const floor = draw(gpu, { shader: floorWgsl, geometry: floorGeometry, cull: 'none', label: `${label}-floor` });
  floor.set({ env_tex: env, env_samp: envSampler });

  const backface = draw(gpu, { shader: backfaceWgsl, geometry: cubeGeometry, cull: 'front', label: `${label}-backface` });
  const glass = draw(gpu, { shader: glassWgsl, geometry: cubeGeometry, cull: 'back', label: `${label}-glass` });
  glass.set({ env_tex: env, env_samp: envSampler });

  const present = effect(gpu, presentWgsl, { label: `${label}-present` });
  present.set({ present: { exposure: EXPOSURE } });

  const blurs: BlurPair[] = [];
  for (let level = 1; level < SCENE_LEVELS; level++) {
    blurs.push({
      horizontal: effect(gpu, blurWgsl, { label: `${label}-scene-blur-h${level}` }),
      vertical: effect(gpu, blurWgsl, { label: `${label}-scene-blur-v${level}` }),
    });
  }

  const scene: Scene = {
    env, envSampler, pyramidSampler, screenSampler,
    cubeGeometry, floorGeometry,
    background, floor, backface, glass, present, blurs,
    targets,
  };
  bindTargets(scene);

  await Promise.all([
    background.compile(targets.hdr),
    floor.compile(targets.hdr),
    glass.compile(targets.hdr),
    backface.compile(targets.backface),
    present.compile({ colors: [output.format] }),
    ...blurs.flatMap((pair) => [pair.horizontal.compile({ colors: [HDR_FORMAT] }), pair.vertical.compile({ colors: [HDR_FORMAT] })]),
  ]);
  return scene;
}

/**
 * Fills the equirectangular environment map and its prefiltered pyramid, once, at startup.
 *
 * Level 0 is the sky itself; every level below is the previous one run through a
 * separable Gaussian while the resolution halves, so level L carries roughly 2^L texels
 * of angular blur. The glass reads its reflections out of it with a single
 * `textureSampleLevel` instead of tracing a cone of taps per pixel.
 */
async function bakeEnvironment(gpu: Gpu, samplerState: GPUSampler, label: string): Promise<Texture> {
  const env = gpu.device.createTexture({
    size: [...ENV_SIZE],
    format: HDR_FORMAT,
    mipLevelCount: ENV_LEVELS,
    usage: ['texture_binding', 'copy_dst'],
    label: `${label}-env`,
  });

  const sky = effect(gpu, skyWgsl, { label: `${label}-sky` });
  sky.set({ sky: SKY });
  const blur = effect(gpu, blurWgsl, { label: `${label}-env-blur` });

  let source = target(gpu, { size: [...ENV_SIZE], format: HDR_FORMAT, label: `${label}-env-level0` });
  await Promise.all([sky.compile(source), blur.compile(source)]);
  frame(gpu, (currentFrame) => currentFrame.pass({ target: source }, (pass) => pass.draw(sky)));
  copyIntoLevel(gpu, source, env, 0, `${label}-env`);

  for (let level = 1; level < ENV_LEVELS; level++) {
    const size: [number, number] = [
      Math.max(1, ENV_SIZE[0] >> level),
      Math.max(1, ENV_SIZE[1] >> level),
    ];
    const horizontal = target(gpu, { size, format: HDR_FORMAT, label: `${label}-env-blur-h${level}` });
    const vertical = target(gpu, { size, format: HDR_FORMAT, label: `${label}-env-level${level}` });
    const texel: [number, number] = [1 / size[0], 1 / size[1]];

    // One frame per pass so each draw picks up its own bindings. This runs once, at
    // startup — the per-frame scene pyramid below never touches it.
    blur.set({ src: source, src_samp: samplerState, blur: { texel, direction: [1, 0], radius: BLUR_RADIUS, equirect_compensation: 1 } });
    frame(gpu, (currentFrame) => currentFrame.pass({ target: horizontal }, (pass) => pass.draw(blur)));
    blur.set({ src: horizontal, src_samp: samplerState, blur: { texel, direction: [0, 1], radius: BLUR_RADIUS, equirect_compensation: 0 } });
    frame(gpu, (currentFrame) => currentFrame.pass({ target: vertical }, (pass) => pass.draw(blur)));

    copyIntoLevel(gpu, vertical, env, level, `${label}-env`);
    destroyTarget(horizontal);
    destroyTarget(source);
    source = vertical;
  }
  destroyTarget(source);

  return env;
}

function createTargets(gpu: Gpu, size: readonly [number, number], label: string): Targets {
  const full: readonly [number, number] = [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
  // A texture cannot hold more mips than its largest side has halvings.
  const levels = Math.max(1, Math.min(SCENE_LEVELS, Math.floor(Math.log2(Math.max(full[0], full[1]))) + 1));
  const created: Target[] = [];
  try {
    const hdr = target(gpu, { size: full, format: HDR_FORMAT, depth: true, label: `${label}-scene` });
    created.push(hdr);
    const backface = target(gpu, { size: full, format: HDR_FORMAT, label: `${label}-backface` });
    created.push(backface);
    const pyramid = gpu.device.createTexture({
      size: [...full],
      format: HDR_FORMAT,
      mipLevelCount: levels,
      usage: ['texture_binding', 'copy_dst'],
      label: `${label}-scene-pyramid`,
    });
    const chain: LevelTargets[] = [];
    for (let level = 1; level < levels; level++) {
      const levelSize: [number, number] = [Math.max(1, full[0] >> level), Math.max(1, full[1] >> level)];
      const horizontal = target(gpu, { size: levelSize, format: HDR_FORMAT, label: `${label}-scene-blur-h${level}` });
      created.push(horizontal);
      const vertical = target(gpu, { size: levelSize, format: HDR_FORMAT, label: `${label}-scene-level${level}` });
      created.push(vertical);
      chain.push({ size: levelSize, horizontal, vertical });
    }
    return { size: full, hdr, backface, pyramid, levels, chain };
  } catch (error) {
    for (const colorTarget of created) destroyTarget(colorTarget);
    throw error;
  }
}

/** Points every consumer at the current targets; re-run after each resize. */
function bindTargets(scene: Scene): void {
  const { targets } = scene;
  scene.glass.set({
    scene_tex: targets.pyramid,
    scene_samp: scene.pyramidSampler,
    backface_tex: targets.backface,
    backface_samp: scene.screenSampler,
  });
  scene.present.set({ color_tex: targets.hdr, color_samp: scene.screenSampler });

  for (let index = 0; index < scene.blurs.length; index++) {
    const level = targets.chain[index];
    if (!level) break;
    const source = index === 0 ? targets.hdr : targets.chain[index - 1].vertical;
    const texel: [number, number] = [1 / level.size[0], 1 / level.size[1]];
    // Screen space has no poles to stretch, so the equirect compensation stays off.
    scene.blurs[index].horizontal.set({ src: source, src_samp: scene.screenSampler, blur: { texel, direction: [1, 0], radius: BLUR_RADIUS, equirect_compensation: 0 } });
    scene.blurs[index].vertical.set({ src: level.horizontal, src_samp: scene.screenSampler, blur: { texel, direction: [0, 1], radius: BLUR_RADIUS, equirect_compensation: 0 } });
  }
}

/**
 * One rendered frame.
 *
 * The order is the whole technique: the scene has to exist and be blurred before the
 * glass can look through it, and nothing may sample the texture it is writing. Pass A
 * fills colour and depth, the pyramid is built from that colour into a separate texture,
 * and only then is the cube drawn back into the scene target — depth-tested against the
 * floor, sampling the pyramid, never the target under its own pen.
 */
function renderScene(gpu: Gpu, scene: Scene, output: Output, view: CameraView, controls: TransmissionControls): void {
  const { targets } = scene;
  const model = modelMatrix();
  const doubleRefraction = controls.refraction === 'double';

  scene.background.set({
    scene_camera: {
      position: view.position,
      tan_half_fov: view.tanHalfFov,
      forward: view.forward,
      aspect: view.aspect,
      right: view.right,
      texel_angle: TEXEL_ANGLE,
      up: view.up,
      intensity: 1,
      env_size: ENV_SIZE,
    },
  });
  scene.floor.set({
    floor_uniforms: {
      ...FLOOR,
      view_projection: view.camera.viewProjection,
      model: translationMatrix(0, FLOOR_HEIGHT, 0),
      camera_position: view.position,
    },
  });
  scene.backface.set({
    backface: {
      view_projection: view.camera.viewProjection,
      model,
      camera_position: view.position,
    },
  });
  scene.glass.set({
    glass: {
      ...GLASS,
      view_projection: view.camera.viewProjection,
      model,
      camera_position: view.position,
      ior: controls.ior,
      roughness: controls.roughness,
      dispersion: controls.dispersion ? 1 : 0,
      refraction_mode: doubleRefraction ? 1 : 0,
      scene_levels: targets.levels,
    },
  });

  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: targets.hdr, clear: [0, 0, 0, 1] }, (pass) => {
      pass.draw(scene.background);
      pass.draw(scene.floor);
    });
    // Every level halves the resolution and doubles the blur, so a roughness of 1 reads a
    // scene that is 128 pixels wide: frosted glass for the price of one fetch.
    for (let index = 0; index < targets.chain.length; index++) {
      const level = targets.chain[index];
      currentFrame.pass({ target: level.horizontal }, (pass) => pass.draw(scene.blurs[index].horizontal));
      currentFrame.pass({ target: level.vertical }, (pass) => pass.draw(scene.blurs[index].vertical));
    }
  });

  copyPyramid(gpu, targets);

  frame(gpu, (currentFrame) => {
    // The mini-pass only runs where it is read: `simple` never touches the back face.
    if (doubleRefraction) {
      currentFrame.pass({ target: targets.backface, clear: [0, 0, 0, 0] }, (pass) => pass.draw(scene.backface));
    }
    // `clear: false` keeps the sky, the floor and their depth: the cube is composited
    // into the scene it just refracted, and the floor can occlude it.
    currentFrame.pass({ target: targets.hdr, clear: false }, (pass) => pass.draw(scene.glass));
    currentFrame.pass({ target: output }, (pass) => pass.draw(scene.present));
  });
}

/**
 * Moves the blurred levels into the pyramid texture, in one submit between the two frames.
 *
 * A render pass cannot write into a mip level of another texture, and the copies must
 * land after every blur pass and before the glass pass reads them, which is exactly what
 * a separate command buffer submitted in between guarantees.
 */
function copyPyramid(gpu: Gpu, targets: Targets): void {
  const encoder = gpu.gpu.createCommandEncoder({ label: 'transmission-scene-pyramid' });
  encoder.copyTextureToTexture(
    { texture: targets.hdr.color.gpu },
    { texture: targets.pyramid.gpu, mipLevel: 0 },
    [targets.size[0], targets.size[1], 1],
  );
  for (let index = 0; index < targets.chain.length; index++) {
    const level = targets.chain[index];
    encoder.copyTextureToTexture(
      { texture: level.vertical.color.gpu },
      { texture: targets.pyramid.gpu, mipLevel: index + 1 },
      [level.size[0], level.size[1], 1],
    );
  }
  gpu.gpu.queue.submit([encoder.finish()]);
}

/** A render pass cannot write into a mip level of another texture, so levels are copied in. */
function copyIntoLevel(gpu: Gpu, source: Target, texture: Texture, level: number, label: string): void {
  const encoder = gpu.gpu.createCommandEncoder({ label: `${label}-copy-level${level}` });
  encoder.copyTextureToTexture(
    { texture: source.color.gpu },
    { texture: texture.gpu, mipLevel: level },
    [source.size[0], source.size[1], 1],
  );
  gpu.gpu.queue.submit([encoder.finish()]);
}

function normalizeControls(controls: Readonly<TransmissionControls>): TransmissionControls {
  return {
    ior: Math.max(1, Math.min(2.4, Number.isFinite(controls.ior) ? controls.ior : DEFAULT_TRANSMISSION_CONTROLS.ior)),
    roughness: Math.max(0, Math.min(1, Number.isFinite(controls.roughness) ? controls.roughness : DEFAULT_TRANSMISSION_CONTROLS.roughness)),
    dispersion: Boolean(controls.dispersion),
    refraction: controls.refraction === 'double' ? 'double' : 'simple',
  };
}

function aspectOf(output: Output): number {
  return output.size[0] / Math.max(1, output.size[1]);
}

function destroyScene(scene: Scene): void {
  destroyTargets(scene.targets);
  scene.cubeGeometry.destroy();
  scene.floorGeometry.destroy();
  scene.env.destroy();
}

function destroyTargets(targets: Targets): void {
  destroyTarget(targets.hdr);
  destroyTarget(targets.backface);
  targets.pyramid.destroy();
  for (const level of targets.chain) {
    destroyTarget(level.horizontal);
    destroyTarget(level.vertical);
  }
}

function destroyTarget(colorTarget: Target): void {
  (colorTarget as Target & { destroy?: () => void }).destroy?.();
}
