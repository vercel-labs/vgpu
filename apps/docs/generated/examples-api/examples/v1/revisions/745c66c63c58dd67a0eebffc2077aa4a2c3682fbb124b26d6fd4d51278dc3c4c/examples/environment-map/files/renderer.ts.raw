import type { Draw, Effect, Frame, Gpu, Geometry, Surface, Target } from 'vgpu';
import type { Texture } from 'vgpu/core';
import { box } from 'vgpu/scene';

import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import { cameraView, spinMatrix, type CameraView } from './camera';
import { installOrbitInput } from './pointer-input';
import skyWgsl from './sky.wgsl';
import blurWgsl from './blur.wgsl';
import metalWgsl from './metal.wgsl';
import presentWgsl from './present.wgsl';
import { clock, draw, effect, frame, frameLoop, geometry, sampler, surface, target } from "vgpu";

type Output = Surface | Target;

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
/** 2:1 is the equirectangular aspect: 360° of yaw by 180° of pitch. */
const ENV_SIZE: readonly [number, number] = [2048, 1024];
/** Levels of the prefiltered pyramid: 2048×1024 down to 16×8. */
const ENV_LEVELS = 8;
/** Gaussian radius in destination texels; ~1 keeps each level one octave blurrier. */
const BLUR_RADIUS = 1.15;
const CUBE_SIZE = 1.25;
const EXPOSURE = 0.9;
/** Angle covered by one texel of level 0, the unit every LOD is measured against. */
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

const METAL = {
  /** Normal-incidence reflectance of polished chrome; Fresnel takes the rest to white. */
  base_color: [0.56, 0.57, 0.58],
  /**
   * Half-angle of the reflection cone, in radians. 0 is a perfect mirror; raising it
   * walks up the prefiltered pyramid, so satin metal costs exactly the same one fetch.
   */
  roughness: 0.0,
  texel_angle: TEXEL_ANGLE,
  env_size: ENV_SIZE,
} as const;

interface Scene {
  readonly env: Texture;
  readonly hdr: Target;
  readonly geometry: Geometry;
  readonly cube: Draw;
  readonly present: Effect;
}

export function createRenderer(options: BrowserRendererOptions): ExampleRenderer {
  let disposed = false;
  let reportedError = false;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let scene: Scene | undefined;
  let input: ReturnType<typeof installOrbitInput> | undefined;
  let loop: { stop(): void } | undefined;
  let observer: ResizeObserver | undefined;
  let unsubscribeResize: (() => void) | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  let sawInitialResize = false;

  const onSurfaceResize = () => {
    // The surface replays its current size on subscribe; the scene target was just
    // built at that size, so only later reports are real resizes.
    if (!sawInitialResize) { sawInitialResize = true; return; }
    if (disposed || !scene || !canvasSurface) return;
    try {
      scene.hdr.resize(canvasSurface.size);
      // Resizing recreates the texture, so the composite binding has to be re-pointed.
      scene.present.set({ scene_tex: scene.hdr });
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

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    loop?.stop();
    loop = undefined;
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
    scene = await createScene(gpu, canvasSurface);
    if (disposed) return;
    input = installOrbitInput(options.canvas);
    unsubscribeResize = canvasSurface.onResize(onSurfaceResize);
    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    window.addEventListener('resize', onWindowResize);
    measure();
    const time = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) => {
      if (disposed || !gpu || !canvasSurface || !scene || !input) return;
      input.advance(time.deltaTime);
      render(currentFrame, scene, canvasSurface, cameraView(input.yaw, input.pitch, aspectOf(canvasSurface)), time.time);
    });
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    handleFailure(error);
    throw error;
  });

  return { ready, invalidate() {}, resize, dispose };
}

export async function renderThumbnail(gpu: Gpu, output: Target, opts: ThumbnailOptions = {}): Promise<void> {
  const scene = await createScene(gpu, output);
  const dt = opts.dt ?? 1 / 60;
  let time = opts.time ?? 2.1;

  for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 3); i++) {
    time += dt;
    const view = cameraView(0.62 + time * 0.09, 0.16, aspectOf(output));
    frame(gpu, (currentFrame) => render(currentFrame, scene, output, view, time));
  }

  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
  destroyScene(scene);
}

async function createScene(gpu: Gpu, output: Output): Promise<Scene> {
  const hdr = target(gpu, { size: output.size, format: HDR_FORMAT, depth: true, label: 'environment-map-scene' });
  const envSampler = sampler(gpu, {
    minFilter: 'linear',
    magFilter: 'linear',
    // Trilinear: roughness lands on a fractional LOD, so neighbouring levels must blend.
    mipmapFilter: 'linear',
    // u wraps the horizon; v must clamp so the poles never bleed across.
    addressModeU: 'repeat',
    addressModeV: 'clamp-to-edge',
  });
  const sceneSampler = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });

  const env = await bakeEnvironment(gpu, envSampler);

  const geo = geometry(gpu, box({ size: CUBE_SIZE }));
  const cube = draw(gpu, { shader: metalWgsl, geometry: geo, label: 'environment-map-metal' });
  cube.set({ ...METAL, env_tex: env, env_samp: envSampler });

  const present = effect(gpu, presentWgsl, { label: 'environment-map-present' });
  present.set({ env_tex: env, env_samp: envSampler, scene_tex: hdr, scene_samp: sceneSampler });

  await Promise.all([cube.compile(hdr), present.compile({ colors: [output.format] })]);
  return { env, hdr, geometry: geo, cube, present };
}

/**
 * Fills the equirectangular map and its prefiltered pyramid, once, at startup.
 *
 * Level 0 is the sky itself; every level below is the previous one run through a
 * separable Gaussian while the resolution halves, so level L carries roughly 2^L texels
 * of angular blur. Shading reads roughness back out with a single `textureSampleLevel`
 * instead of tracing a cone of taps per pixel.
 *
 * The map is baked procedurally so the example stays self-contained and renders the same
 * frame headlessly. To use a real 360° photo instead, upload it into level 0 and keep the
 * downsample loop for the rest:
 *
 * ```ts
 * const bitmap = await createImageBitmap(await (await fetch('/hdri.png')).blob());
 * gpu.gpu.queue.copyExternalImageToTexture({ source: bitmap }, { texture: env.gpu }, [bitmap.width, bitmap.height]);
 * ```
 */
async function bakeEnvironment(gpu: Gpu, samplerState: GPUSampler): Promise<Texture> {
  const env = gpu.device.createTexture({
    size: [...ENV_SIZE],
    format: HDR_FORMAT,
    mipLevelCount: ENV_LEVELS,
    usage: ['texture_binding', 'copy_dst'],
    label: 'environment-map-env',
  });

  const sky = effect(gpu, skyWgsl, { label: 'environment-map-sky' });
  sky.set({ sky: SKY });
  const blur = effect(gpu, blurWgsl, { label: 'environment-map-blur' });

  let source = target(gpu, { size: [...ENV_SIZE], format: HDR_FORMAT, label: 'environment-map-level0' });
  await Promise.all([sky.compile(source), blur.compile(source)]);
  frame(gpu, (currentFrame) => currentFrame.pass({ target: source }, (pass) => pass.draw(sky)));
  copyIntoLevel(gpu, source, env, 0);

  for (let level = 1; level < ENV_LEVELS; level++) {
    const size: [number, number] = [
      Math.max(1, ENV_SIZE[0] >> level),
      Math.max(1, ENV_SIZE[1] >> level),
    ];
    const horizontal = target(gpu, { size, format: HDR_FORMAT, label: `environment-map-blur-h${level}` });
    const vertical = target(gpu, { size, format: HDR_FORMAT, label: `environment-map-level${level}` });
    const texel: [number, number] = [1 / size[0], 1 / size[1]];

    // One frame per pass so each draw picks up its own bindings. This runs once, at
    // startup — the per-frame path below never touches it.
    blur.set({ src: source, src_samp: samplerState, blur: { texel, direction: [1, 0], radius: BLUR_RADIUS, equirect_compensation: 1 } });
    frame(gpu, (currentFrame) => currentFrame.pass({ target: horizontal }, (pass) => pass.draw(blur)));
    blur.set({ src: horizontal, src_samp: samplerState, blur: { texel, direction: [0, 1], radius: BLUR_RADIUS, equirect_compensation: 0 } });
    frame(gpu, (currentFrame) => currentFrame.pass({ target: vertical }, (pass) => pass.draw(blur)));

    copyIntoLevel(gpu, vertical, env, level);
    destroyTarget(horizontal);
    destroyTarget(source);
    source = vertical;
  }
  destroyTarget(source);

  return env;
}

/** A render pass cannot write into a mip level of another texture, so levels are copied in. */
function copyIntoLevel(gpu: Gpu, source: Target, env: Texture, level: number): void {
  const encoder = gpu.gpu.createCommandEncoder({ label: `environment-map-copy-level${level}` });
  encoder.copyTextureToTexture(
    { texture: source.color.gpu },
    { texture: env.gpu, mipLevel: level },
    [source.size[0], source.size[1], 1],
  );
  gpu.gpu.queue.submit([encoder.finish()]);
}

function render(currentFrame: Frame, scene: Scene, output: Output, view: CameraView, time: number): void {
  scene.cube.set({
    view_projection: view.camera.viewProjection,
    model: spinMatrix(time),
    camera_position: view.position,
  });
  scene.present.set({
    camera: {
      position: view.position,
      tan_half_fov: view.tanHalfFov,
      forward: view.forward,
      aspect: view.aspect,
      right: view.right,
      exposure: EXPOSURE,
      up: view.up,
      background_intensity: 1,
      texel_angle: TEXEL_ANGLE,
      env_size: ENV_SIZE,
    },
  });

  // Alpha 0 clear turns the cube pass into a coverage mask the composite reads back.
  currentFrame.pass({ target: scene.hdr, clear: [0, 0, 0, 0] }, (pass) => pass.draw(scene.cube));
  currentFrame.pass({ target: output }, (pass) => pass.draw(scene.present));
}

function aspectOf(output: Output): number {
  return output.size[0] / Math.max(1, output.size[1]);
}

function destroyScene(scene: Scene): void {
  destroyTarget(scene.hdr);
  scene.env.destroy();
}

function destroyTarget(colorTarget: Target): void {
  (colorTarget as Target & { destroy?: () => void }).destroy?.();
}
