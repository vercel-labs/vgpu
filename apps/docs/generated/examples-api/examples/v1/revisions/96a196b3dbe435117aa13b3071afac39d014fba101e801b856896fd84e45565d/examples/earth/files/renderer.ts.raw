// Earth scene and browser lifecycle.
import GUI from "lil-gui";
import type { Frame, Gpu, Surface, Target } from "vgpu";
import {
  clock,
  draw,
  effect,
  frame,
  frameLoop,
  geometry,
  sampler,
  surface,
  target,
} from "vgpu";
import { perspectiveCamera, sphere } from "vgpu/scene";

import {
  EARTH_TUNING,
  bloomSize,
  cameraBasis,
  normalizeSize,
  orbitPosition,
  sunDirection,
  type OrbitState,
} from "./planet";

import atmosphereWgsl from "./atmosphere.wgsl";
import bakeCloudsWgsl from "./bake-clouds.wgsl";
import bakeSurfaceWgsl from "./bake-surface.wgsl";
import blurWgsl from "./blur.wgsl";
import brightPassWgsl from "./bright-pass.wgsl";
import compositeWgsl from "./composite.wgsl";
import earthWgsl from "./earth.wgsl";
import overlayWgsl from "./overlay.wgsl";
import skyWgsl from "./sky.wgsl";

type Output = Surface | Target;
export type Maps = ReturnType<typeof createMaps>;
export type Scene = ReturnType<typeof createScene>;
export type Targets = ReturnType<typeof createTargets>;

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
}

const HDR_FORMAT: GPUTextureFormat = "rgba16float";
// The planet caps at 0.7, so an 8-bit sRGB MSAA target is sufficient.
const PLANET_FORMAT: GPUTextureFormat = "rgba8unorm-srgb";
const OPAQUE_BLACK = [0, 0, 0, 1] as const;
const TRANSPARENT = [0, 0, 0, 0] as const;

export function createRenderer({ canvas }: RendererOptions) {
  let disposed = false;
  const controls = { sunDegrees: 0, autoRotate: true };
  let sunDegrees = controls.sunDegrees;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let scene: Scene | undefined;
  let targets: Targets | undefined;
  let orbit: ReturnType<typeof installOrbitInput> | undefined;
  let gui: GUI | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: readonly [number, number] | undefined;
  let lastDpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !scene || !targets) return;
    try {
      resizeTargets(targets, size);
      setSizeBindings(scene, targets);
    } catch (error) {
      fail(error);
    }
  };
  const measure = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (disposed || width <= 0 || height <= 0) return;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    pendingSize = [
      Math.max(1, Math.round(width * dpr)),
      Math.max(1, Math.round(height * dpr)),
    ];
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };
  const onWindowResize = () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    measure();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    observer?.disconnect();
    if (typeof window !== "undefined")
      window.removeEventListener("resize", onWindowResize);
    orbit?.dispose();
    gui?.destroy();
    gpu?.dispose();
  };
  const fail = (error: unknown) => {
    dispose();
    throw error;
  };
  const initialize = async () => {
    const { init } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }
    gpu = nextGpu;
    canvasSurface = surface(gpu, canvas, { dpr: [1, 2] });
    const maps = createMaps(gpu);
    scene = createScene(gpu);
    targets = createTargets(gpu, canvasSurface.size);
    setStaticBindings(scene, maps, targets);
    await Promise.all([
      bakeMaps(gpu, maps),
      prewarm(scene, targets, canvasSurface),
    ]);
    if (disposed) return;
    orbit = installOrbitInput(canvas, {
      yaw: 0,
      pitch: EARTH_TUNING.poster.pitch,
      radius: EARTH_TUNING.camera.radius,
    });
    gui = new GUI({
      title: "Earth",
      container: canvas.parentElement ?? undefined,
      width: 180,
    });
    Object.assign(gui.domElement.style, {
      position: "absolute",
      top: "16px",
      right: "16px",
      zIndex: "10",
    });
    const autoController = gui
      .add(controls, "autoRotate")
      .name("Auto rotate")
      .onChange((enabled: boolean) => {
        if (!enabled) sunDegrees = controls.sunDegrees;
      });
    gui
      .add(controls, "sunDegrees", 0, 360, 0.5)
      .name("Sun")
      .onChange((value: number) => {
        sunDegrees = value;
        controls.autoRotate = false;
        autoController.updateDisplay();
      });
    observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(canvas);
    window.addEventListener("resize", onWindowResize);
    measure();
    const time = clock(gpu);
    frameLoop(gpu, (currentFrame) => {
      if (disposed || !canvasSurface || !scene || !targets || !orbit) return;
      try {
        const deltaTime = Math.min(0.05, time.deltaTime);
        if (controls.autoRotate) {
          sunDegrees =
            (sunDegrees + deltaTime * EARTH_TUNING.sun.degreesPerSecond) % 360;
        }
        setFrameUniforms(
          scene,
          canvasSurface,
          orbit.step(deltaTime),
          sunDegrees,
          time.time
        );
        render(currentFrame, scene, targets, canvasSurface);
      } catch (error) {
        fail(error);
      }
    });
  };
  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    fail(error);
  });

  return { ready, dispose };
}

export function createMaps(gpu: Gpu) {
  return createResourceGraph((own) => {
    const size = EARTH_TUNING.maps.size;
    return {
      // sRGB preserves precision in dark oceans while alpha stays linear.
      surface: own(target(gpu, { size, format: PLANET_FORMAT })),
      clouds: own(target(gpu, { size, format: "r8unorm" })),
    };
  });
}

export function createScene(gpu: Gpu) {
  return createResourceGraph((own) => {
    const earthGeometry = own(geometry(gpu, sphere(EARTH_TUNING.planet)));
    const atmosphereGeometry = own(
      geometry(gpu, sphere(EARTH_TUNING.atmosphere))
    );
    return {
      earthGeometry,
      atmosphereGeometry,
      earth: draw(gpu, { shader: earthWgsl, geometry: earthGeometry }),
      // Alpha blending turns the shell's fresnel into a rim glow.
      atmosphere: draw(gpu, {
        shader: atmosphereWgsl,
        geometry: atmosphereGeometry,
        blend: "alpha",
      }),
      sky: effect(gpu, skyWgsl),
      overlay: effect(gpu, overlayWgsl, { blend: "premultiplied" }),
      bright: effect(gpu, brightPassWgsl),
      // Each encoded blur needs its own uniform buffer.
      blur: [
        effect(gpu, blurWgsl),
        effect(gpu, blurWgsl),
        effect(gpu, blurWgsl),
        effect(gpu, blurWgsl),
      ] as const,
      composite: effect(gpu, compositeWgsl),
      mapSampler: sampler(gpu, {
        minFilter: "linear",
        magFilter: "linear",
        // Longitude wraps, latitude does not.
        addressModeU: "repeat",
        addressModeV: "clamp-to-edge",
      }),
      linearSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }),
    };
  });
}

export function createTargets(gpu: Gpu, size: readonly [number, number]) {
  return createResourceGraph((own) => {
    const full = normalizeSize(size);
    const bloom = bloomSize(full);
    return {
      beauty: own(target(gpu, { size: full, format: HDR_FORMAT })),
      planet: own(
        target(gpu, {
          size: full,
          format: PLANET_FORMAT,
          msaa: true,
          depth: true,
        })
      ),
      bloomA: own(target(gpu, { size: bloom, format: HDR_FORMAT })),
      bloomB: own(target(gpu, { size: bloom, format: HDR_FORMAT })),
    };
  });
}

export function setStaticBindings(
  scene: Scene,
  maps: Maps,
  targets: Targets
): void {
  const { bloom } = EARTH_TUNING;
  scene.earth.set({
    surfaceMap: maps.surface,
    cloudMap: maps.clouds,
    mapSampler: scene.mapSampler,
  });
  scene.overlay.set({
    planetTexture: targets.planet,
    samp: scene.linearSampler,
  });
  scene.bright.set({ samp: scene.linearSampler });
  const directions = [
    [1, 0],
    [0, 1],
  ] as const;
  scene.blur.forEach((pass, index) => {
    pass.set({
      samp: scene.linearSampler,
      blur: {
        direction: directions[index % 2]!,
        radius: bloom.radii[Math.floor(index / 2)],
      },
    });
  });
  scene.composite.set({
    samp: scene.linearSampler,
    bloom: targets.bloomA,
  });
  setSizeBindings(scene, targets);
}

function setSizeBindings(scene: Scene, targets: Targets): void {
  scene.bright.set({ src: targets.beauty });
  const sources = [targets.bloomA, targets.bloomB] as const;
  scene.blur.forEach((pass, index) => {
    const src = sources[index % 2]!;
    pass.set({ src, blur: { texelSize: src.texelSize } });
  });
  scene.composite.set({ beauty: targets.beauty });
}

// The procedural maps are baked once in a single submit.
export async function bakeMaps(gpu: Gpu, maps: Maps): Promise<void> {
  const surfacePass = effect(gpu, bakeSurfaceWgsl);
  const cloudPass = effect(gpu, bakeCloudsWgsl);
  await Promise.all([
    surfacePass.compile(maps.surface),
    cloudPass.compile(maps.clouds),
  ]);
  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: maps.surface, clear: TRANSPARENT }, (pass) =>
      pass.draw(surfacePass)
    );
    currentFrame.pass({ target: maps.clouds, clear: TRANSPARENT }, (pass) =>
      pass.draw(cloudPass)
    );
  });
}

export async function prewarm(
  scene: Scene,
  targets: Targets,
  output: Output
): Promise<void> {
  await Promise.all([
    scene.sky.compile(targets.beauty),
    scene.earth.compile(targets.planet),
    scene.atmosphere.compile(targets.planet),
    scene.overlay.compile(targets.beauty),
    scene.bright.compile(targets.bloomA),
    ...scene.blur.map((pass, index) =>
      pass.compile(index % 2 === 0 ? targets.bloomB : targets.bloomA)
    ),
    scene.composite.compile({ colors: [output.format] }),
  ]);
}

export function setFrameUniforms(
  scene: Scene,
  output: Output,
  orbit: OrbitState,
  sunDegrees: number,
  time: number
): void {
  const { camera, atmosphere } = EARTH_TUNING;
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
      lightDirection: light,
    },
  });
}

export function render(
  currentFrame: Frame,
  scene: Scene,
  targets: Targets,
  output: Output
): void {
  // Sky first, then the planet into its own MSAA target, then lay it over the sky.
  currentFrame.pass({ target: targets.beauty, clear: OPAQUE_BLACK }, (pass) =>
    pass.draw(scene.sky)
  );
  currentFrame.pass({ target: targets.planet, clear: TRANSPARENT }, (pass) => {
    pass.draw(scene.earth);
    pass.draw(scene.atmosphere);
  });
  currentFrame.pass({ target: targets.beauty, clear: false }, (pass) =>
    pass.draw(scene.overlay)
  );

  currentFrame.pass({ target: targets.bloomA, clear: OPAQUE_BLACK }, (pass) =>
    pass.draw(scene.bright)
  );
  const bloomTargets = [targets.bloomB, targets.bloomA] as const;
  scene.blur.forEach((blurPass, index) => {
    currentFrame.pass(
      { target: bloomTargets[index % 2]!, clear: OPAQUE_BLACK },
      (pass) => {
        pass.draw(blurPass);
      }
    );
  });

  currentFrame.pass({ target: output, clear: OPAQUE_BLACK }, (pass) =>
    pass.draw(scene.composite)
  );
}

function resizeTargets(
  targets: Targets,
  size: readonly [number, number]
): void {
  const full = normalizeSize(size);
  const bloom = bloomSize(full);
  targets.beauty.resize(full);
  targets.planet.resize(full);
  targets.bloomA.resize(bloom);
  targets.bloomB.resize(bloom);
}

export function destroyScene(scene: Scene): void {
  destroyResources([scene.earthGeometry, scene.atmosphereGeometry]);
}

export function destroyTargets(targets: Targets): void {
  destroyResources([
    targets.beauty,
    targets.planet,
    targets.bloomA,
    targets.bloomB,
  ]);
}

export function destroyMaps(maps: Maps): void {
  destroyResources([maps.surface, maps.clouds]);
}

function createResourceGraph<T>(
  build: (own: <R extends object>(resource: R) => R) => T
): T {
  const resources: object[] = [];
  try {
    return build((resource) => {
      resources.push(resource);
      return resource;
    });
  } catch (error) {
    try {
      destroyResources(resources);
    } catch {
      // Preserve the construction failure after attempting every rollback.
    }
    throw error;
  }
}

function destroyResources(resources: readonly object[]): void {
  let firstError: unknown;
  let failed = false;
  for (let i = resources.length - 1; i >= 0; i--) {
    try {
      (resources[i] as { destroy?: () => void }).destroy?.();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
}

function installOrbitInput(canvas: HTMLCanvasElement, initial: OrbitState) {
  let { yaw, pitch, radius } = initial;
  let targetYaw = yaw;
  let targetPitch = pitch;
  let targetRadius = radius;
  let activePointer: number | undefined;
  let lastX = 0;
  let lastY = 0;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || activePointer !== undefined) return;
    activePointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerId !== activePointer) return;
    const rect = canvas.getBoundingClientRect();
    targetYaw -=
      ((event.clientX - lastX) / Math.max(1, rect.width)) * Math.PI * 2;
    targetPitch +=
      ((event.clientY - lastY) / Math.max(1, rect.height)) * Math.PI;
    targetPitch = Math.max(-1.45, Math.min(1.45, targetPitch));
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== activePointer) return;
    if (canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    activePointer = undefined;
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    const { minRadius, maxRadius } = EARTH_TUNING.camera;
    targetRadius = Math.max(
      minRadius,
      Math.min(maxRadius, targetRadius * Math.exp(event.deltaY * 0.0012))
    );
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", wheel, { passive: false });

  return {
    step(deltaTime: number): OrbitState {
      const blend = 1 - Math.exp(-deltaTime * 9);
      yaw += (targetYaw - yaw) * blend;
      pitch += (targetPitch - pitch) * blend;
      radius += (targetRadius - radius) * blend;
      return { yaw, pitch, radius };
    },
    dispose() {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
      if (
        activePointer !== undefined &&
        canvas.hasPointerCapture?.(activePointer)
      ) {
        canvas.releasePointerCapture(activePointer);
      }
      canvas.style.touchAction = previousTouchAction;
    },
  };
}
