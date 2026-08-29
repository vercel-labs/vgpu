import type GUI from "lil-gui";
import type { Draw, Geometry, Gpu, Surface } from "vgpu";
import { draw, frame, geometry, surface } from "vgpu";
import { perspectiveCamera, sphere } from "vgpu/scene";
import { loadHeroGlassAssets, type HeroGlassAssets } from "./hero-glass-assets";
import {
  createCameraControls,
  createHeroFractalScene,
  HERO_FLOOR_AO_DEFAULTS,
  modelMatrix,
  renderHeroFractalScene,
  resizeHeroFractalScene,
  setHeroFractalSceneSettings,
  type HeroFloorAo,
  type HeroFractalScene,
} from "./scene";
import heroDebugAxesWgsl from "./hero-debug-axes.wgsl";
import heroGlassEnvironmentDebugWgsl from "./hero-glass-environment-debug.wgsl";
import heroGlassWireframeWgsl from "./hero-glass-wireframe.wgsl";
import heroFractalWireframeWgsl from "./hero-fractal-wireframe.wgsl";
import {
  HERO_FRACTAL_CAMERA,
  HERO_FRACTAL_GLASS,
  HERO_FRACTAL_MATERIAL,
  HERO_ORB_MATERIAL,
  type HeroFractalGlass,
  type HeroFractalMaterial,
} from "./settings";

const HERO_LIGHT_CLEAR = 250 / 255;
const ENVIRONMENT_SPHERE_MODEL = modelMatrix(1, [0, 0, 0]);
const GLASS_MODEL_MATRIX = modelMatrix(1, [0, 0, 0]);
const ENVIRONMENT_DEBUG_CAMERA_POSITION = [0, 0, 3] as const;
const WORLD_AXES_MODEL_MATRIX = modelMatrix(1.45, [0, 0, 0]);
const CAMERA_TARGET_AXES_SCALE = 0.22;
const SPHERE_MORPH_DURATION_MS = 1040;

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
}

interface Renderer {
  readonly ready: Promise<void>;
  setSphereMix(value: number): void;
  dispose(): void;
}

type DebugView = "final" | "environment" | "reflection";

interface HeroFractalDraws {
  readonly glassWireframe: Draw;
  readonly fractalWireframe: Draw;
  readonly environmentSphere: Draw;
  readonly worldAxes: Draw;
  readonly cameraTargetAxes: Draw;
}

interface MutableHeroFractalMaterial {
  baseColor: [number, number, number];
  roughness: number;
  diffuseStrength: number;
  specularStrength: number;
  ambientStrength: number;
}

function createMaterialDebugGui(
  GuiConstructor: typeof GUI,
  container: HTMLElement | undefined,
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fov: number;
    maxMouseRotation: number;
    mouseLerp: number;
  },
  fractalMaterial: MutableHeroFractalMaterial,
  orbMaterial: MutableHeroFractalMaterial,
  glass: {
    fractalScale: number;
    orbScale: number;
    orbOffsetY: number;
    sphereMix: number;
    ior: number;
    reflectionStrength: number;
    backOpacity: number;
    absorption: [number, number, number];
    frostRadius: number;
    dispersion: number;
    iridescenceStrength: number;
    iridescenceFrequency: number;
    environmentRotation: [number, number, number];
    environmentExposure: number;
  },
  floorAo: HeroFloorAo,
  debug: {
    view: DebugView;
    wireframe: boolean;
    floorGrid: boolean;
    coloredAxes: boolean;
    cameraTarget: boolean;
  },
  requestDraw: () => void
): GUI {
  const gui = new GuiConstructor({
    title: "Glass fractal material",
    container,
    width: 290,
  });
  gui.domElement.dataset.heroFractalMaterialGui = "";
  Object.assign(gui.domElement.style, {
    position: "absolute",
    top: "16px",
    left: "16px",
    right: "auto",
    zIndex: "10",
  });

  const debugFolder = gui.addFolder("Debug");
  debugFolder
    .add(debug, "view", ["final", "environment", "reflection"])
    .name("view");
  for (const [property, label] of [
    ["wireframe", "Wireframe"],
    ["floorGrid", "Floor grid"],
    ["coloredAxes", "Colored axes"],
    ["cameraTarget", "Camera target"],
  ] as const) {
    debugFolder.add(debug, property).name(label);
  }

  const cameraFolder = gui.addFolder("Camera");
  addVector3Controllers(cameraFolder, camera.position, "position", -10, 10);
  addVector3Controllers(cameraFolder, camera.target, "target", -3, 3);
  addNumberControllers(cameraFolder, camera, [
    ["fov", "FOV", 10, 100, 0.1],
    ["maxMouseRotation", "max rotation", 0, 15, 0.1],
    ["mouseLerp", "lerp", 0.01, 1, 0.01],
  ]);

  const fractalFolder = gui.addFolder("Fractal material");
  addMaterialControllers(fractalFolder, fractalMaterial);
  fractalFolder.add(glass, "fractalScale", 0.35, 0.99, 0.005).name("scale");

  const orbFolder = gui.addFolder("Orb material");
  addMaterialControllers(orbFolder, orbMaterial);
  orbFolder.add(glass, "orbScale", 0.35, 0.99, 0.005).name("scale");
  orbFolder.add(glass, "orbOffsetY", -0.5, 0.5, 0.005).name("offset y");

  const glassFolder = gui.addFolder("Glass");
  glassFolder.addColor(glass, "absorption", 1).name("absorption");
  addNumberControllers(glassFolder, glass, [
    ["ior", "IOR", 1.001, 2.2, 0.001],
    ["reflectionStrength", "reflection", 0, 4, 0.01],
    ["backOpacity", "back opacity", 0, 1, 0.01],
    ["frostRadius", "frost radius px", 0, 3, 0.05],
    ["dispersion", "RGB shift", 0, 0.1, 0.0005],
    ["iridescenceStrength", "iridescence", 0, 0.25, 0.005],
    ["iridescenceFrequency", "iridescence frequency", 0.25, 6, 0.05],
  ]);

  const floorAoFolder = gui.addFolder("Floor AO");
  addNumberControllers(floorAoFolder, floorAo, [
    ["glassAoScale", "glass scale", 0.25, 2, 0.01],
    ["glassAoAmplitude", "glass amplitude", 0, 2, 0.01],
    ["glassAoOpacity", "glass opacity", 0, 1, 0.01],
    ["fractalAoScale", "fractal scale", 0.25, 2, 0.01],
    ["fractalAoAmplitude", "fractal amplitude", 0, 2, 0.01],
    ["fractalAoOpacity", "fractal opacity", 0, 1, 0.01],
    ["orbAoScale", "orb scale", 0.25, 2, 0.01],
    ["orbAoAmplitude", "orb amplitude", 0, 2, 0.01],
    ["orbAoOpacity", "orb opacity", 0, 1, 0.01],
  ]);

  const environmentFolder = gui.addFolder("Environment");
  addVector3Controllers(
    environmentFolder,
    glass.environmentRotation,
    "rotation",
    -180,
    180,
    0.1
  );
  environmentFolder
    .add(glass, "environmentExposure", 0.1, 8, 0.01)
    .name("exposure");

  gui.onChange(requestDraw);
  gui.close();
  return gui;
}

function addVector3Controllers(
  folder: GUI,
  vector: [number, number, number],
  label: string,
  min: number,
  max: number,
  step = 0.01
): void {
  folder.add(vector, "0", min, max, step).name(`${label} x`);
  folder.add(vector, "1", min, max, step).name(`${label} y`);
  folder.add(vector, "2", min, max, step).name(`${label} z`);
}

function addNumberControllers(
  folder: GUI,
  target: object,
  controls: readonly (readonly [string, string, number, number, number])[]
): void {
  for (const [property, label, min, max, step] of controls) {
    folder
      .add(target as Record<string, number>, property, min, max, step)
      .name(label);
  }
}

function addMaterialControllers(
  folder: GUI,
  material: MutableHeroFractalMaterial
): void {
  folder.addColor(material, "baseColor", 1).name("base color");
  addNumberControllers(folder, material, [
    ["roughness", "roughness", 0, 1, 0.01],
    ["diffuseStrength", "diffuse strength", 0, 2, 0.01],
    ["specularStrength", "specular strength", 0, 2, 0.01],
    ["ambientStrength", "ambient fill", 0, 1, 0.01],
  ]);
}

function copyMaterial(
  material: Readonly<HeroFractalMaterial>
): MutableHeroFractalMaterial {
  return {
    baseColor: [...material.baseColor],
    roughness: material.roughness,
    diffuseStrength: material.diffuseStrength,
    specularStrength: material.specularStrength,
    ambientStrength: material.ambientStrength,
  };
}

/** Static, event-driven renderer owned exclusively by the Glass Fractal example. */
export function createRenderer(options: RendererOptions): Renderer {
  let disposed = false;
  let failureStarted = false;
  const abort = new AbortController();
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let draws: HeroFractalDraws | undefined;
  let coreScene: HeroFractalScene | undefined;
  let assets: HeroGlassAssets | undefined;
  let debugGui: GUI | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let materialFrame = 0;
  let cameraFrame = 0;
  let morphFrame = 0;
  let orbFrame = 0;
  let morphStartTime = 0;
  let morphStartMix = HERO_FRACTAL_GLASS.sphereMix;
  let morphTargetMix = HERO_FRACTAL_GLASS.sphereMix;
  let morphDirection = 1;
  const orbEpoch = performance.now();
  let orbTime = 0;
  let isCanvasVisible = true;
  let visibilityObserver: IntersectionObserver | undefined;
  let pointerTargetX = 0;
  let pointerTargetY = 0;
  let pointerCurrentX = 0;
  let pointerCurrentY = 0;
  let lastDpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  const fractalMaterial = copyMaterial(HERO_FRACTAL_MATERIAL);
  const orbMaterial = copyMaterial(HERO_ORB_MATERIAL);
  const floorAo = { ...HERO_FLOOR_AO_DEFAULTS };
  const glass = {
    ...HERO_FRACTAL_GLASS,
    absorption: [...HERO_FRACTAL_GLASS.absorption] as [number, number, number],
    environmentRotation: [...HERO_FRACTAL_GLASS.environmentRotation] as [
      number,
      number,
      number
    ],
  };
  const cameraControls = createCameraControls(HERO_FRACTAL_CAMERA);
  const debugQuery = new URLSearchParams(window.location.search);
  const debug = {
    view: (debugQuery.get("debug") === "reflection"
      ? "reflection"
      : "final") as DebugView,
    wireframe: false,
    floorGrid: false,
    coloredAxes: false,
    cameraTarget: false,
  };
  const drawHero = () => {
    if (disposed || !gpu || !canvasSurface || !draws || !coreScene || !assets)
      return;

    const state = setHeroFractalSceneSettings(
      coreScene,
      assets,
      canvasSurface.size,
      {
        camera: HERO_FRACTAL_CAMERA,
        fractalMaterial,
        orbMaterial,
        glass,
        time: orbTime,
        view: {
          ...cameraControls,
          pointer: [pointerCurrentX, pointerCurrentY],
        },
        floorAo,
        floorGrid: debug.floorGrid,
        morphDirection,
        reflectionDebug: debug.view === "reflection",
      }
    );
    const environmentCamera = perspectiveCamera({
      fov: 45,
      aspect: canvasSurface.size[0] / Math.max(canvasSurface.size[1], 1),
      near: 0.05,
      far: 10,
      position: ENVIRONMENT_DEBUG_CAMERA_POSITION,
      target: [0, 0, 0],
    });
    draws.glassWireframe.set({
      params: {
        viewProjection: state.viewProjection,
        model: GLASS_MODEL_MATRIX,
        meshMin: assets.meshMin,
        meshMax: assets.meshMax,
      },
    });
    draws.fractalWireframe.set({
      params: {
        viewProjection: state.viewProjection,
        model: state.fractalModel,
        meshMin: assets.fractalMeshMin,
        meshMax: assets.fractalMeshMax,
        sphereMix: state.sphereMix,
        time: state.time,
      },
    });
    draws.environmentSphere.set({
      params: {
        viewProjection: environmentCamera.viewProjectionMatrix,
        model: ENVIRONMENT_SPHERE_MODEL,
        cameraPosition: ENVIRONMENT_DEBUG_CAMERA_POSITION,
        environmentRotation: state.environmentRotation,
        environmentExposure: glass.environmentExposure,
      },
      environmentTexture: assets.environmentView,
      environmentSampler: coreScene.environmentSampler,
    });
    const debugAxesParams = {
      viewProjection: state.viewProjection,
      resolution: canvasSurface.size,
      lineWidth: 2.5,
      opacity: 0.94,
    };
    draws.worldAxes.set({
      params: {
        ...debugAxesParams,
        model: WORLD_AXES_MODEL_MATRIX,
      },
    });
    draws.cameraTargetAxes.set({
      params: {
        ...debugAxesParams,
        model: modelMatrix(CAMERA_TARGET_AXES_SCALE, cameraControls.target),
        lineWidth: 3.5,
      },
    });

    const currentGpu = gpu;
    const currentSurface = canvasSurface;
    const currentDraws = draws;
    if (debug.view === "environment") {
      frame(currentGpu, (currentFrame) => {
        currentFrame.pass(
          {
            target: currentSurface,
            clear: [HERO_LIGHT_CLEAR, HERO_LIGHT_CLEAR, HERO_LIGHT_CLEAR, 1],
          },
          (pass) => pass.draw(currentDraws.environmentSphere)
        );
      });
      return;
    }
    const finalDebugDraws: Draw[] = [];
    if (debug.wireframe) {
      finalDebugDraws.push(
        currentDraws.glassWireframe,
        currentDraws.fractalWireframe
      );
    }
    if (debug.coloredAxes) finalDebugDraws.push(currentDraws.worldAxes);
    if (debug.cameraTarget) finalDebugDraws.push(currentDraws.cameraTargetAxes);
    renderHeroFractalScene(
      currentGpu,
      currentSurface,
      coreScene,
      finalDebugDraws
    );
  };

  const renderHero = () => {
    try {
      drawHero();
    } catch (error) {
      fail(error);
    }
  };

  const requestMaterialDraw = () => {
    if (materialFrame) return;
    materialFrame = requestAnimationFrame(() => {
      materialFrame = 0;
      renderHero();
    });
  };

  const stopOrbAnimation = () => {
    if (orbFrame) cancelAnimationFrame(orbFrame);
    orbFrame = 0;
  };

  const animateOrb = (time: number) => {
    orbFrame = 0;
    if (
      disposed ||
      morphFrame ||
      morphTargetMix <= 0 ||
      !isCanvasVisible ||
      document.hidden
    )
      return;
    orbTime = (time - orbEpoch) * 0.001;
    renderHero();
    orbFrame = requestAnimationFrame(animateOrb);
  };

  const requestOrbAnimation = () => {
    if (
      !orbFrame &&
      !morphFrame &&
      morphTargetMix > 0 &&
      isCanvasVisible &&
      !document.hidden
    ) {
      orbFrame = requestAnimationFrame(animateOrb);
    }
  };

  const animateSphereMorph = (time: number) => {
    morphFrame = 0;
    if (disposed) return;
    const progress = Math.min(
      1,
      Math.max(0, (time - morphStartTime) / SPHERE_MORPH_DURATION_MS)
    );
    const easedProgress = 1 - (1 - progress) ** 4;
    glass.sphereMix =
      morphStartMix + (morphTargetMix - morphStartMix) * easedProgress;
    if (glass.sphereMix > 0) orbTime = (time - orbEpoch) * 0.001;
    renderHero();
    if (progress < 1) {
      morphFrame = requestAnimationFrame(animateSphereMorph);
    } else {
      requestOrbAnimation();
    }
  };

  const setSphereMix = (value: number) => {
    const nextMix = Math.min(1, Math.max(0, value));
    if (nextMix === morphTargetMix && !morphFrame) return;
    if (morphFrame) cancelAnimationFrame(morphFrame);
    morphFrame = 0;
    stopOrbAnimation();
    morphDirection = nextMix >= glass.sphereMix ? 1 : -1;
    morphStartMix = glass.sphereMix;
    morphTargetMix = nextMix;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      glass.sphereMix = nextMix;
      requestMaterialDraw();
      requestOrbAnimation();
      return;
    }

    morphStartTime = performance.now();
    morphFrame = requestAnimationFrame(animateSphereMorph);
  };

  const animateCamera = () => {
    cameraFrame = 0;
    if (disposed) return;
    const lerp = Math.min(1, Math.max(0.001, cameraControls.mouseLerp));
    pointerCurrentX += (pointerTargetX - pointerCurrentX) * lerp;
    pointerCurrentY += (pointerTargetY - pointerCurrentY) * lerp;
    const remainingX = Math.abs(pointerTargetX - pointerCurrentX);
    const remainingY = Math.abs(pointerTargetY - pointerCurrentY);
    if (remainingX < 0.0001) pointerCurrentX = pointerTargetX;
    if (remainingY < 0.0001) pointerCurrentY = pointerTargetY;
    if (!morphFrame && !orbFrame) renderHero();
    if (remainingX >= 0.0001 || remainingY >= 0.0001) {
      cameraFrame = requestAnimationFrame(animateCamera);
    }
  };

  const requestCameraDraw = () => {
    if (!cameraFrame) cameraFrame = requestAnimationFrame(animateCamera);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType && event.pointerType !== "mouse") return;
    pointerTargetX = Math.min(
      1,
      Math.max(-1, (event.clientX / Math.max(window.innerWidth, 1)) * 2 - 1)
    );
    pointerTargetY = Math.min(
      1,
      Math.max(-1, (event.clientY / Math.max(window.innerHeight, 1)) * 2 - 1)
    );
    requestCameraDraw();
  };

  const resetPointer = () => {
    pointerTargetX = 0;
    pointerTargetY = 0;
    requestCameraDraw();
  };

  const onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget === null) resetPointer();
  };

  const onDocumentVisibilityChange = () => {
    if (document.hidden) stopOrbAnimation();
    else requestOrbAnimation();
  };

  const resizeAndDraw = () => {
    resizeFrame = 0;
    if (disposed || !canvasSurface) return;
    try {
      const rect = options.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      canvasSurface.resize([
        Math.max(1, Math.round(rect.width * dpr)),
        Math.max(1, Math.round(rect.height * dpr)),
      ]);
      if (coreScene) resizeHeroFractalScene(coreScene, canvasSurface.size);
      drawHero();
    } catch (error) {
      fail(error);
    }
  };

  const requestResize = () => {
    if (!resizeFrame) resizeFrame = requestAnimationFrame(resizeAndDraw);
  };

  const onWindowResize = () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    requestResize();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    if (materialFrame) cancelAnimationFrame(materialFrame);
    if (cameraFrame) cancelAnimationFrame(cameraFrame);
    if (morphFrame) cancelAnimationFrame(morphFrame);
    if (orbFrame) cancelAnimationFrame(orbFrame);
    abort.abort();
    observer?.disconnect();
    visibilityObserver?.disconnect();
    window.removeEventListener("resize", onWindowResize);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerout", onPointerOut);
    window.removeEventListener("blur", resetPointer);
    document.removeEventListener(
      "visibilitychange",
      onDocumentVisibilityChange
    );
    debugGui?.destroy();
    gpu?.dispose();
  };

  const fail = (error: unknown): never => {
    failureStarted = true;
    try {
      dispose();
    } catch {
      // A cleanup failure must not hide the rendering failure.
    }
    throw error;
  };

  const initialize = async () => {
    // Load the optional tuning UI in parallel with WebGPU initialization. It is
    // collapsed by default so the example remains unobstructed.
    const guiModulePromise = import("lil-gui");
    const { init } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }
    gpu = nextGpu;
    canvasSurface = surface(gpu, options.canvas, { dpr: [1, 2] });
    const loadedAssets = await loadHeroGlassAssets(gpu, abort.signal);
    if (disposed) return;
    assets = loadedAssets;
    const environmentSphereGeometry = geometry(
      gpu,
      sphere({
        radius: 0.82,
        widthSegments: 48,
        heightSegments: 24,
      })
    );
    const debugAxesGeometry = createDebugAxesGeometry(gpu);
    const loadedScene = await createHeroFractalScene(
      gpu,
      canvasSurface,
      assets,
      "homepage-light"
    );
    if (disposed) return;
    coreScene = loadedScene;
    draws = {
      glassWireframe: draw(gpu, {
        shader: heroGlassWireframeWgsl,
        geometry: assets.wireframeGeometry,
        cull: "none",
        depth: false,
        blend: "premultiplied",
        label: "homepage-light-glass-wireframe",
      }),
      fractalWireframe: draw(gpu, {
        shader: heroFractalWireframeWgsl,
        geometry: assets.fractalWireframeGeometry,
        instances: 4,
        cull: "none",
        depth: false,
        blend: "premultiplied",
        label: "homepage-light-fractal-mesh-wireframe",
      }),
      environmentSphere: draw(gpu, {
        shader: heroGlassEnvironmentDebugWgsl,
        geometry: environmentSphereGeometry,
        cull: "back",
        depth: false,
        label: "homepage-light-glass-environment-debug",
      }),
      worldAxes: draw(gpu, {
        shader: heroDebugAxesWgsl,
        geometry: debugAxesGeometry,
        cull: "none",
        depth: false,
        blend: "premultiplied",
        label: "homepage-light-world-axes-debug",
      }),
      cameraTargetAxes: draw(gpu, {
        shader: heroDebugAxesWgsl,
        geometry: debugAxesGeometry,
        cull: "none",
        depth: false,
        blend: "premultiplied",
        label: "homepage-light-camera-target-axes-debug",
      }),
    };
    await Promise.all([
      draws.glassWireframe.compile({ colors: [canvasSurface.format] }),
      draws.fractalWireframe.compile({ colors: [canvasSurface.format] }),
      draws.environmentSphere.compile({ colors: [canvasSurface.format] }),
      draws.worldAxes.compile({ colors: [canvasSurface.format] }),
      draws.cameraTargetAxes.compile({ colors: [canvasSurface.format] }),
    ]);
    if (disposed) return;
    observer = new ResizeObserver(requestResize);
    observer.observe(options.canvas);
    visibilityObserver = new IntersectionObserver(([entry]) => {
      isCanvasVisible = entry?.isIntersecting ?? false;
      if (isCanvasVisible) requestOrbAnimation();
      else stopOrbAnimation();
    });
    visibilityObserver.observe(options.canvas);
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerout", onPointerOut);
    window.addEventListener("blur", resetPointer);
    document.addEventListener("visibilitychange", onDocumentVisibilityChange);
    resizeAndDraw();
    requestOrbAnimation();
    const { default: GuiConstructor } = await guiModulePromise;
    if (disposed) return;
    debugGui = createMaterialDebugGui(
      GuiConstructor,
      options.canvas.parentElement ?? undefined,
      cameraControls,
      fractalMaterial,
      orbMaterial,
      glass,
      floorAo,
      debug,
      requestMaterialDraw
    );
  };

  const ready = initialize().catch((error: unknown) => {
    if (failureStarted) throw error;
    if (disposed) return;
    fail(error);
  });

  return { ready, setSphereMix, dispose };
}

function createDebugAxesGeometry(gpu: Gpu): Geometry {
  const vertices: number[] = [];
  const corners = [
    [0, -1],
    [0, 1],
    [1, 1],
    [0, -1],
    [1, 1],
    [1, -1],
  ] as const;
  const axes = [
    { end: [1, 0, 0], color: [1, 0.08, 0.05] },
    { end: [0, 1, 0], color: [0.1, 0.78, 0.18] },
    { end: [0, 0, 1], color: [0.05, 0.36, 1] },
  ] as const;

  for (const axis of axes) {
    for (const corner of corners) {
      vertices.push(0, 0, 0, ...axis.end, ...axis.color, ...corner);
    }
  }

  return geometry(gpu, {
    label: "homepage-light-debug-axes",
    buffers: [
      {
        data: new Float32Array(vertices),
        stride: 44,
        attributes: {
          line_start: "float32x3",
          line_end: "float32x3",
          axis_color: "float32x3",
          corner: "float32x2",
        },
      },
    ],
  });
}
