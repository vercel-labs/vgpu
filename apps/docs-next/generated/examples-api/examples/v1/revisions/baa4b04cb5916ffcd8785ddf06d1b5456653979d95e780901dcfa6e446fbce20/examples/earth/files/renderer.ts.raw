import type { Draw, Effect, Frame, Gpu, GeometryLike, Surface, Target } from 'vgpu';
import { perspectiveCamera, sphere } from 'vgpu/scene';

import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import { EARTH_TUNING, bloomSize, cameraBasis, normalizeSize, orbitPosition, sunDegreesAt, sunDirection, type OrbitState } from './planet';
import { DEFAULT_EARTH_CONTROLS, type EarthControls } from './types';

import atmosphereWgsl from './atmosphere.wgsl';
import bakeCloudsWgsl from './bake-clouds.wgsl';
import bakeSurfaceWgsl from './bake-surface.wgsl';
import blurWgsl from './blur.wgsl';
import brightPassWgsl from './bright-pass.wgsl';
import compositeWgsl from './composite.wgsl';
import earthWgsl from './earth.wgsl';
import overlayWgsl from './overlay.wgsl';
import skyWgsl from './sky.wgsl';
import { clock, draw, effect, frame, frameLoop, geometry, sampler, surface, target } from "vgpu";

type Output = Surface | Target;

type ThumbOptions = ThumbnailOptions;

interface Maps {
  /** Equirectangular day albedo in rgb, night-light mask in alpha. */
  readonly surface: Target;
  /** Single-channel cloud coverage. */
  readonly clouds: Target;
}

interface Scene {
  readonly earthGeometry: GeometryLike;
  readonly atmosphereGeometry: GeometryLike;
  readonly earth: Draw;
  readonly atmosphere: Draw;
  readonly sky: Effect;
  readonly overlay: Effect;
  readonly bright: Effect;
  readonly blur: readonly [Effect, Effect, Effect, Effect];
  readonly composite: Effect;
  readonly mapSampler: GPUSampler;
  readonly linearSampler: GPUSampler;
}

interface Targets {
  readonly beauty: Target;
  readonly planet: Target;
  readonly bloomA: Target;
  readonly bloomB: Target;
}

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
/** The planet is clamped to 0.7 by its own shader, so 8-bit sRGB is plenty and keeps MSAA available. */
const PLANET_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';
const OPAQUE_BLACK = [0, 0, 0, 1] as const;
const TRANSPARENT = [0, 0, 0, 0] as const;

export function createRenderer(options: BrowserRendererOptions<EarthControls>): ExampleRenderer<EarthControls> {
  let disposed = false;
  let reportedError = false;
  let controls = { ...(options.initialControls ?? DEFAULT_EARTH_CONTROLS) };
  let sunDegrees = controls.sunDegrees;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let maps: Maps | undefined;
  let scene: Scene | undefined;
  let targets: Targets | undefined;
  let orbit: ReturnType<typeof installOrbitInput> | undefined;
  let loop: { stop(): void } | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !scene || !targets) return;
    try {
      resizeTargets(targets, [
        Math.max(1, Math.round(size.width * size.dpr)),
        Math.max(1, Math.round(size.height * size.dpr)),
      ]);
      setSizeBindings(scene, targets);
    } catch (error) {
      fail(error);
    }
  };
  const resize = (size: RenderSize) => {
    if (disposed || size.width <= 0 || size.height <= 0) return;
    pendingSize = size;
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };
  const measure = () => {
    const rect = options.canvas.getBoundingClientRect();
    resize({ width: rect.width, height: rect.height, dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)) });
  };
  const onWindowResize = () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    measure();
  };
  const setControls = (next: Readonly<EarthControls>) => {
    const valid = {
      sunDegrees: Math.max(0, Math.min(360, Number(next.sunDegrees) || 0)),
      autoRotate: Boolean(next.autoRotate),
    };
    if (!valid.autoRotate || !controls.autoRotate) sunDegrees = valid.sunDegrees;
    controls = valid;
  };
  const dispose = () => {
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
    orbit?.dispose();
    orbit = undefined;
    if (scene) destroyScene(scene);
    scene = undefined;
    if (targets) destroyTargets(targets);
    targets = undefined;
    if (maps) destroyMaps(maps);
    maps = undefined;
    canvasSurface?.dispose();
    canvasSurface = undefined;
    gpu?.dispose();
    gpu = undefined;
  };
  const fail = (error: unknown) => {
    if (disposed) return;
    if (!reportedError) {
      reportedError = true;
      try { options.onError?.(error); } catch { /* error reporting must not block teardown */ }
    }
    dispose();
  };
  const initialize = async () => {
    const { init } = await import('vgpu');
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) { nextGpu.dispose(); return; }
    gpu = nextGpu;
    canvasSurface = surface(gpu, options.canvas, { dpr: [1, 2] });
    maps = createMaps(gpu, 'earth-live');
    scene = createScene(gpu, maps, 'earth-live');
    targets = createTargets(gpu, canvasSurface.size, 'earth-live');
    setStaticBindings(scene, maps, targets);
    await Promise.all([bakeMaps(gpu, maps), prewarm(scene, targets, canvasSurface)]);
    if (disposed) return;
    orbit = installOrbitInput(options.canvas, {
      yaw: 0,
      pitch: EARTH_TUNING.poster.pitch,
      radius: EARTH_TUNING.camera.radius,
    });
    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    window.addEventListener('resize', onWindowResize);
    measure();
    const time = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) => {
      if (disposed || !gpu || !canvasSurface || !scene || !targets || !orbit) return;
      const deltaTime = Math.min(0.05, time.deltaTime);
      if (controls.autoRotate) sunDegrees = (sunDegrees + deltaTime * EARTH_TUNING.sun.degreesPerSecond) % 360;
      setFrameUniforms(scene, canvasSurface, orbit.step(deltaTime), sunDegrees, time.time);
      render(currentFrame, scene, targets, canvasSurface);
    });
  };
  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    fail(error);
    throw error;
  });

  return { ready, setControls, invalidate() {}, resize, dispose };
}

export async function renderThumbnail(gpu: Gpu, output: Target, opts: ThumbOptions = {}): Promise<void> {
  const maps = createMaps(gpu, 'earth-thumb');
  const scene = createScene(gpu, maps, 'earth-thumb');
  const targets = createTargets(gpu, output.size, 'earth-thumb');
  setStaticBindings(scene, maps, targets);
  await Promise.all([bakeMaps(gpu, maps), prewarm(scene, targets, output)]);

  // The poster framing is fixed; only `time` moves, and the sun angle is derived
  // from it so a given `thumb.time` always produces the same terminator.
  const { yaw, pitch, radius, sunDegrees } = EARTH_TUNING.poster;
  const dt = opts.dt ?? 1 / 60;
  let time = opts.time ?? 0;
  for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 1); i++) {
    setFrameUniforms(scene, output, { yaw, pitch, radius }, sunDegrees + sunDegreesAt(time), time);
    frame(gpu, (currentFrame) => render(currentFrame, scene, targets, output));
    time += dt;
  }

  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
  destroyScene(scene);
  destroyTargets(targets);
  destroyMaps(maps);
}

function createMaps(gpu: Gpu, label: string): Maps {
  const size = EARTH_TUNING.maps.size;
  return {
    // `-srgb` stores the albedo with a transfer curve (precision where the oceans
    // are dark) and hands linear values back to `textureSample`; alpha stays linear.
    surface: target(gpu, { size, format: PLANET_FORMAT, label: `${label}-surface-map` }),
    clouds: target(gpu, { size, format: 'r8unorm', label: `${label}-cloud-map` }),
  };
}

function createScene(gpu: Gpu, maps: Maps, label: string): Scene {
  const earthGeometry = geometry(gpu, sphere(EARTH_TUNING.planet));
  const atmosphereGeometry = geometry(gpu, sphere(EARTH_TUNING.atmosphere));
  return {
    earthGeometry,
    atmosphereGeometry,
    earth: draw(gpu, { shader: earthWgsl, geometry: earthGeometry, label: `${label}-earth` }),
    // `alpha` blending over the transparent clear is what turns the shell's
    // fresnel alpha into the rim glow, and leaves coverage in the target's alpha.
    atmosphere: draw(gpu, { shader: atmosphereWgsl, geometry: atmosphereGeometry, blend: 'alpha', label: `${label}-atmosphere` }),
    sky: effect(gpu, skyWgsl, { label: `${label}-sky` }),
    overlay: effect(gpu, overlayWgsl, { blend: 'premultiplied', label: `${label}-overlay` }),
    bright: effect(gpu, brightPassWgsl, { label: `${label}-bright` }),
    // One effect per blur pass: sharing a single effect would make every encoded
    // pass observe the last direction and radius written to its uniform buffer.
    blur: [
      effect(gpu, blurWgsl, { label: `${label}-blur-h1` }),
      effect(gpu, blurWgsl, { label: `${label}-blur-v1` }),
      effect(gpu, blurWgsl, { label: `${label}-blur-h2` }),
      effect(gpu, blurWgsl, { label: `${label}-blur-v2` }),
    ],
    composite: effect(gpu, compositeWgsl, { label: `${label}-composite` }),
    mapSampler: sampler(gpu, {
      minFilter: 'linear',
      magFilter: 'linear',
      // Longitude wraps, latitude does not.
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
    }),
    linearSampler: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
  };
}

function createTargets(gpu: Gpu, size: readonly [number, number], label: string): Targets {
  const full = normalizeSize(size);
  const bloom = bloomSize(full);
  return {
    beauty: target(gpu, { size: full, format: HDR_FORMAT, label: `${label}-beauty` }),
    planet: target(gpu, { size: full, format: PLANET_FORMAT, msaa: true, depth: true, label: `${label}-planet` }),
    bloomA: target(gpu, { size: bloom, format: HDR_FORMAT, label: `${label}-bloom-a` }),
    bloomB: target(gpu, { size: bloom, format: HDR_FORMAT, label: `${label}-bloom-b` }),
  };
}

function setStaticBindings(scene: Scene, maps: Maps, targets: Targets): void {
  const { bloom, grade } = EARTH_TUNING;
  scene.earth.set({ surfaceMap: maps.surface, cloudMap: maps.clouds, mapSampler: scene.mapSampler });
  scene.overlay.set({ planetTexture: targets.planet, samp: scene.linearSampler });
  scene.bright.set({ samp: scene.linearSampler, bright: { threshold: bloom.threshold, knee: bloom.knee } });
  const directions = [
    [1, 0],
    [0, 1],
    [1, 0],
    [0, 1],
  ] as const;
  scene.blur.forEach((pass, index) => {
    pass.set({
      samp: scene.linearSampler,
      blur: { direction: directions[index]!, radius: bloom.radii[index < 2 ? 0 : 1] },
    });
  });
  scene.composite.set({
    samp: scene.linearSampler,
    bloom: targets.bloomA,
    composite: {
      bloomStrength: bloom.strength,
      exposure: grade.exposure,
      vignetteStart: grade.vignetteStart,
      vignetteDarkness: grade.vignetteDarkness,
      grain: grade.grain,
    },
  });
  setSizeBindings(scene, targets);
}

function setSizeBindings(scene: Scene, targets: Targets): void {
  scene.bright.set({ src: targets.beauty });
  scene.blur[0].set({ src: targets.bloomA, blur: { texelSize: targets.bloomA.texelSize } });
  scene.blur[1].set({ src: targets.bloomB, blur: { texelSize: targets.bloomB.texelSize } });
  scene.blur[2].set({ src: targets.bloomA, blur: { texelSize: targets.bloomA.texelSize } });
  scene.blur[3].set({ src: targets.bloomB, blur: { texelSize: targets.bloomB.texelSize } });
  scene.composite.set({ beauty: targets.beauty });
}

/**
 * One-shot: the maps never change, so this runs once before the first frame and is
 * never repeated. Both bakes go in a single submit.
 */
async function bakeMaps(gpu: Gpu, maps: Maps): Promise<void> {
  const canvasSurface = effect(gpu, bakeSurfaceWgsl, { label: 'earth-bake-surface' });
  const clouds = effect(gpu, bakeCloudsWgsl, { label: 'earth-bake-clouds' });
  await Promise.all([canvasSurface.compile(maps.surface), clouds.compile(maps.clouds)]);
  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: maps.surface, clear: TRANSPARENT }, (pass) => pass.draw(canvasSurface));
    currentFrame.pass({ target: maps.clouds, clear: TRANSPARENT }, (pass) => pass.draw(clouds));
  });
}

async function prewarm(scene: Scene, targets: Targets, output: Output): Promise<void> {
  await Promise.all([
    scene.sky.compile(targets.beauty),
    scene.earth.compile(targets.planet),
    scene.atmosphere.compile(targets.planet),
    scene.overlay.compile(targets.beauty),
    scene.bright.compile(targets.bloomA),
    scene.blur[0].compile(targets.bloomB),
    scene.blur[1].compile(targets.bloomA),
    scene.blur[2].compile(targets.bloomB),
    scene.blur[3].compile(targets.bloomA),
    scene.composite.compile({ colors: [output.format] }),
  ]);
}

function setFrameUniforms(
  scene: Scene,
  output: Output,
  orbit: OrbitState,
  sunDegrees: number,
  time: number,
): void {
  const { camera, atmosphere, sun, grade } = EARTH_TUNING;
  const size = output.size;
  const aspect = size[0] / Math.max(1, size[1]);
  const position = orbitPosition(orbit);
  const light = sunDirection(sunDegrees);
  const view = perspectiveCamera({
    fov: camera.fov,
    aspect,
    near: camera.near,
    far: camera.far,
    position,
    target: [0, 0, 0],
  });
  const basis = cameraBasis(position, [0, 0, 0], camera.fov);

  scene.earth.set({
    earth: {
      viewProjection: view.viewProjection,
      cameraPosition: position,
      time,
      lightDirection: light,
      nightLights: 1,
    },
  });
  scene.atmosphere.set({
    atmosphere: {
      viewProjection: view.viewProjection,
      cameraPosition: position,
      strength: atmosphere.strength,
      lightDirection: light,
      _pad: 0,
    },
  });
  scene.sky.set({
    sky: {
      right: basis.right,
      tanHalfFov: basis.tanHalfFov,
      up: basis.up,
      aspect,
      forward: basis.forward,
      starBrightness: grade.starBrightness,
      lightDirection: light,
      sunIntensity: sun.intensity,
    },
  });
}

function render(currentFrame: Frame, scene: Scene, targets: Targets, output: Output): void {
  // Sky first, then the planet into its own MSAA target, then lay it over the sky.
  currentFrame.pass({ target: targets.beauty, clear: OPAQUE_BLACK }, (pass) => pass.draw(scene.sky));
  currentFrame.pass({ target: targets.planet, clear: TRANSPARENT }, (pass) => {
    pass.draw(scene.earth);
    pass.draw(scene.atmosphere);
  });
  currentFrame.pass({ target: targets.beauty, clear: false }, (pass) => pass.draw(scene.overlay));

  currentFrame.pass({ target: targets.bloomA, clear: OPAQUE_BLACK }, (pass) => pass.draw(scene.bright));
  currentFrame.pass({ target: targets.bloomB, clear: OPAQUE_BLACK }, (pass) => pass.draw(scene.blur[0]));
  currentFrame.pass({ target: targets.bloomA, clear: OPAQUE_BLACK }, (pass) => pass.draw(scene.blur[1]));
  currentFrame.pass({ target: targets.bloomB, clear: OPAQUE_BLACK }, (pass) => pass.draw(scene.blur[2]));
  currentFrame.pass({ target: targets.bloomA, clear: OPAQUE_BLACK }, (pass) => pass.draw(scene.blur[3]));

  currentFrame.pass({ target: output, clear: OPAQUE_BLACK }, (pass) => pass.draw(scene.composite));
}

function resizeTargets(targets: Targets, size: readonly [number, number]): void {
  const full = normalizeSize(size);
  const bloom = bloomSize(full);
  targets.beauty.resize(full);
  targets.planet.resize(full);
  targets.bloomA.resize(bloom);
  targets.bloomB.resize(bloom);
}

function destroyScene(scene: Scene): void {
  (scene.earthGeometry as { destroy?: () => void }).destroy?.();
  (scene.atmosphereGeometry as { destroy?: () => void }).destroy?.();
}

function destroyTargets(targets: Targets): void {
  for (const colorTarget of [targets.beauty, targets.planet, targets.bloomA, targets.bloomB]) {
    (colorTarget as { destroy?: () => void }).destroy?.();
  }
}

function destroyMaps(maps: Maps): void {
  for (const colorTarget of [maps.surface, maps.clouds]) {
    (colorTarget as { destroy?: () => void }).destroy?.();
  }
}


function installOrbitInput(canvas: HTMLCanvasElement, initial: OrbitState) {
  let { yaw, pitch, radius } = initial;
  let targetYaw = yaw;
  let targetPitch = pitch;
  let targetRadius = radius;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const down = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (!dragging || !event.isPrimary) return;
    const rect = canvas.getBoundingClientRect();
    targetYaw -= ((event.clientX - lastX) / Math.max(1, rect.width)) * Math.PI * 2;
    targetPitch += ((event.clientY - lastY) / Math.max(1, rect.height)) * Math.PI;
    targetPitch = Math.max(-1.45, Math.min(1.45, targetPitch));
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const up = (event: PointerEvent) => { if (event.isPrimary) dragging = false; };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    const { minRadius, maxRadius } = EARTH_TUNING.camera;
    targetRadius = Math.max(minRadius, Math.min(maxRadius, targetRadius * Math.exp(event.deltaY * 0.0012)));
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, { passive: false });

  return {
    step(deltaTime: number): OrbitState {
      const blend = 1 - Math.exp(-deltaTime * 9);
      yaw += (targetYaw - yaw) * blend;
      pitch += (targetPitch - pitch) * blend;
      radius += (targetRadius - radius) * blend;
      return { yaw, pitch, radius };
    },
    dispose() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
    },
  };
}
