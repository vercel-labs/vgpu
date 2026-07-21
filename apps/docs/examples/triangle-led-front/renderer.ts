import type { Bundle, Frame, FramePass, Gpu, StorageBuffer, Target } from 'vgpu';

import type { CascadeFitRect, RenderSize } from './settings';
import {
  DARK_FLOOR_DEFAULTS,
  DARK_POSTPROCESS_DEFAULTS,
  HERO_CANVAS_MAX_CSS,
  LEDS_PER_EDGE,
  LIGHT_AO_DEFAULTS,
  LIGHT_GLOW_DEFAULTS,
  PROBE_DENSITY,
  PROBE_DISCARD_DEFAULTS,
  RADIANCE_DEBUG_DEFAULTS,
  TUNABLE_DEFAULTS,
  canonicalTriangleGeometry,
  cascadeCount,
  cascadeFitRect,
  clampProbeDensity,
  getHeroEdgeFadeFrac,
  ledMeshGeometry,
  resolveHeroSceneScale,
  setHeroEdgeFadeFrac,
  setHeroSceneScale,
  triangleLedRadius,
  triangleLedShapeDimensions,
  type DarkFloorSettings,
  type DarkPostprocessSettings,
  type HeroStateSettings,
  type LightAoSettings,
  type LightGlowSettings,
  type ProbeDiscardSettings,
  type RadianceDebugSettings,
} from './settings';
import {
  DIRECT_TRIANGLE_ABSORPTION,
  DIRECT_TRIANGLE_FALLOFF_POWER,
  DIRECT_TRIANGLE_HIT_THRESHOLD_PX,
  DIRECT_TRIANGLE_INTENSITY_SCALE,
  DIRECT_TRIANGLE_MIN_SOURCE_LUMA,
  DIRECT_TRIANGLE_MIN_STEP_PX,
  DIRECT_TRIANGLE_TARGET_SCALE,
  directTriangleTargetSize,
} from './direct-triangle-raycast';
import {
  buildLedGeometry,
  computeLeds,
  type LedGeometryState,
} from './led-buffer';
import {
  createHeroFrameState,
  type FrameTheme,
  type ResolveFrameOptions,
} from './hero-frame-state';
import {
  type BrushState,
  type SceneTunables,
} from './light-sources-pass';
import {
  canvasRenderSizing,
} from './sim-sizing';
import {
  createLightSourcesRaw,
  type LightSourcesRaw,
} from './light-sources-raw';
import raycastWgsl from './shaders/direct-triangle-raycast.wgsl';
import floorNoiseWgsl from './shaders/floor-noise.wgsl';
import darkFloorWgsl from './shaders/themes/dark/main-scene-floor.wgsl';
import lightFloorWgsl from './shaders/themes/light/main-scene-floor.wgsl';

export interface HeroRendererCss {
  width: number;
  height: number;
  dpr: number;
}

export interface HeroRenderFrameArgs {
  /** Monotonically increasing seconds. Kept explicit so renderThumb can be deterministic. */
  time: number;
  dt?: number;
}

export interface HeroRenderer {
  /** Encode the fixed frame graph into an existing facade frame. */
  renderFrame(frame: Frame, args: HeroRenderFrameArgs): void;
  /** Surface or offscreen Target. The same floor pass path renders into either. */
  setOutputTarget(target: Target): void;
  /** Synchronous docs-only resize rebuild (may hitch one frame versus production's async holder). */
  rebuild(css: HeroRendererCss): void;
  setBrush(b: Partial<BrushState>): void;
  setHero(state: Partial<HeroStateSettings>): void;
  setRgbDeployActive(v: boolean): void;
  readonly hero: Partial<HeroStateSettings>;
  prewarm(): Promise<void>;
  destroy(): void;
}

interface RendererParts {
  simulationSize: RenderSize;
  presentationSize: RenderSize;
  pixelRatio: number;
  probeDensity: number;
  cascadeFit: CascadeFitRect;
  leds: LedGeometryState;
  ledStorage: DestroyableStorageBuffer;
  lightSourcesRaw: LightSourcesRaw;
  raycastTarget: Target;
  raycastBundle: Bundle;
  floorGate: FloorUniformGate;
  floorUniformReady: boolean;
  lightGlowUniformReady: boolean;
  floorBundles?: FloorBundles;
}

type DestroyableStorageBuffer = StorageBuffer & {
  readonly buffer?: { destroy(): void };
  destroy?: () => void;
};

interface FloorBundles {
  readonly target: Target;
  readonly light: Bundle;
  readonly dark: Bundle;
}

export function createHeroRenderer(
  gpu: Gpu,
  opts: { theme?: FrameTheme; css: HeroRendererCss; target?: Target },
): HeroRenderer {
  const theme = opts.theme ?? 'dark';
  const heroFrameState = createHeroFrameState();
  const hero: Partial<HeroStateSettings> = {};
  const brush: Partial<BrushState> = {};
  const options: ResolveFrameOptions & { renderBlackOccluder?: boolean; showForegroundTriangle?: boolean } = {};
  let rgbDeployActive = false;
  let outputTarget = opts.target;
  let destroyed = false;

  const sampler = gpu.sampler({ minFilter: 'linear', magFilter: 'linear' });
  const noiseTarget = gpu.target({
    size: [500, 500],
    format: 'rgba16float',
    label: 'triangle-led-front-floor-noise',
  });
  const noiseDraw = gpu.draw({ shader: floorNoiseWgsl, vertices: 3 });
  const lightFloorDraw = gpu.draw({ shader: lightFloorWgsl, vertices: 3 });
  const darkFloorDraw = gpu.draw({ shader: darkFloorWgsl, vertices: 3 });
  const raycastDraw = gpu.draw({ shader: raycastWgsl, vertices: 3 });

  // Bake the time-invariant floor-noise target once. It is rebuilt only if this renderer is rebuilt.
  gpu.frame((frame: Frame) => {
    frame.pass({ target: noiseTarget }, (pass: FramePass) => pass.draw(noiseDraw));
  });

  let parts = buildParts(opts.css);
  if (outputTarget) recordFloorBundles(parts, outputTarget);

  const api: HeroRenderer = {
    hero,
    renderFrame(frame, args) {
      if (destroyed) return;
      if (!outputTarget) return;
      const currentParts = parts;
      const currentTheme = theme;
      const resolved = heroFrameState.resolveFrame({
        patch: brush,
        tunables: TUNABLE_DEFAULTS,
        options: { ...options, hero, hoverRgbDeployActive: rgbDeployActive },
        probeDiscard: undefined,
        theme: currentTheme,
        time: args.time,
        updateLedsFor: (ctx) => {
          const transition = computeLeds(
            currentParts.leds,
            ctx.time,
            ctx.tunables,
            ctx.settings,
            ctx.hoverDeploy,
            ctx.brush,
            ctx.theme,
          );
          // CPU LED upload mirrors SRC/core/renderer.ts:561-566. The facade storage buffer is owned
          // here and consumed by Stage 2's light-sources pass.
          currentParts.ledStorage.write(currentParts.leds.data.buffer as ArrayBuffer);
          return transition;
        },
      });

      // Frame graph order mirrors SRC/core/renderer.ts:595-618. Light sources,
      // raycast, and floor are recorded into this facade frame so WebGPU inserts
      // the required render_attachment -> texture_binding barriers in one submit.
      currentParts.lightSourcesRaw.encode({
        frame,
        brush: resolved.brush,
        time: args.time,
        tunables: resolved.tunables,
        renderBlackOccluder: options.renderBlackOccluder ?? true,
      });

      frame.pass(
        { target: currentParts.raycastTarget, clear: [0, 0, 0, 1] },
        (pass: FramePass) => pass.bundles(currentParts.raycastBundle),
      );

      if (currentTheme === 'light') {
        lightFloorDraw.set({
          lg: lightGlowUniformData(resolved.lightGlow, resolved.colorMix),
        });
        currentParts.lightGlowUniformReady = true;
      }

      const floorData = writeFloorUniformIfNeeded(
        currentParts,
        {
          width: currentParts.presentationSize.width,
          height: currentParts.presentationSize.height,
          tunables: resolved.tunables,
          probeDiscard: resolved.probeDiscard,
          theme: currentTheme,
          lightAo: resolved.lightAo,
          radianceDebug: resolved.radianceDebug,
          darkFloor: resolved.darkFloor,
          darkPostprocess: resolved.darkPostprocess,
          showForegroundTriangle: options.showForegroundTriangle ?? true,
        },
      );
      if (floorData) {
        lightFloorDraw.set({ cfg: floorData });
        darkFloorDraw.set({ cfg: floorData });
        currentParts.floorUniformReady = true;
      }

      const floorBundles = currentParts.floorBundles ?? recordFloorBundles(currentParts, outputTarget);
      frame.pass(
        { target: outputTarget, clear: [0, 0, 0, 1] },
        (pass: FramePass) => pass.bundles(
          currentTheme === 'light' ? floorBundles.light : floorBundles.dark,
        ),
      );
    },
    setOutputTarget(target) {
      outputTarget = target;
      recordFloorBundles(parts, target);
    },
    rebuild(css) {
      if (destroyed) return;
      // setHeroSceneScale/setHeroEdgeFadeFrac are module globals shared by run() and renderThumb().
      // Re-set them before every synchronous docs rebuild so geometry and floor packing agree.
      const next = buildParts(css, parts.leds);
      destroyParts(parts);
      parts = next;
      if (outputTarget) recordFloorBundles(parts, outputTarget);
    },
    setBrush(b) {
      Object.assign(brush, b);
    },
    setHero(state) {
      Object.assign(hero, state);
    },
    setRgbDeployActive(v) {
      rgbDeployActive = v;
    },
    async prewarm() {
      const target = outputTarget;
      if (!target) return;
      const ready = parts.lightSourcesRaw.ready;
      await Promise.all([
        lightFloorDraw.compile(target),
        darkFloorDraw.compile(target),
        raycastDraw.compile(parts.raycastTarget),
        noiseDraw.compile(noiseTarget),
        ready ?? Promise.resolve(),
      ]);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      destroyParts(parts);
    },
  };

  return api;


  function recordFloorBundles(currentParts: RendererParts, target: Target): FloorBundles {
    const lightSet: Record<string, unknown> = {
      radiance_tex: currentParts.raycastTarget,
      light_sources_tex: currentParts.lightSourcesRaw.texture,
      linear_samp: sampler,
    };
    const darkSet: Record<string, unknown> = {
      radiance_tex: currentParts.raycastTarget,
      light_sources_tex: currentParts.lightSourcesRaw.texture,
      linear_samp: sampler,
      floor_noise_tex: noiseTarget,
    };
    if (!currentParts.floorUniformReady) {
      const initialFloor = initialFloorUniformData();
      lightSet.cfg = initialFloor;
      darkSet.cfg = initialFloor;
      currentParts.floorUniformReady = true;
    }
    if (!currentParts.lightGlowUniformReady) {
      lightSet.lg = initialLightGlowUniformData();
      currentParts.lightGlowUniformReady = true;
    }
    lightFloorDraw.set(lightSet);
    darkFloorDraw.set(darkSet);
    const floorBundles: FloorBundles = {
      target,
      light: gpu.bundle(
        { target, label: 'triangle-led-front-light-floor' },
        (bundle) => bundle.draw(lightFloorDraw),
      ),
      dark: gpu.bundle(
        { target, label: 'triangle-led-front-dark-floor' },
        (bundle) => bundle.draw(darkFloorDraw),
      ),
    };
    currentParts.floorBundles = floorBundles;
    return floorBundles;
  }

  function buildParts(css: HeroRendererCss, previousLeds?: LedGeometryState): RendererParts {
    // Deliberate simplification for docs: resize rebuilds synchronously and may hitch one frame;
    // production held the previous frame while rebuilding asynchronously. Steady-state bytes match.
    setHeroSceneScale(resolveHeroSceneScale(1, css.height, false));
    setHeroEdgeFadeFrac(0.2);

    const sizing = canvasRenderSizing(
      css.width,
      css.height,
      css.dpr,
      PROBE_DENSITY,
      undefined,
    );
    const simulationSize = normalizedSize(
      sizing.simulationWidth,
      sizing.simulationHeight,
    );
    const presentationSize = normalizedSize(css.width * css.dpr, css.height * css.dpr);
    const pixelRatio = normalizedPixelRatio(sizing.pixelRatio);
    const probeDensity = clampProbeDensity(sizing.probeDensity);
    const count = cascadeCount(simulationSize);
    void count; // Kept for parity with the source size derivation; direct raycast uses full fit.
    const fit = cascadeFitRect(simulationSize, probeDensity);
    const leds = buildLedGeometry(simulationSize, previousLeds);
    const ledStorage = gpu.storage(72 * 8 * 4) as DestroyableStorageBuffer;
    ledStorage.write(leds.data.buffer as ArrayBuffer);

    const raycastSize = directTriangleTargetSize(simulationSize);
    const raycastTarget = gpu.target({
      size: [raycastSize.width, raycastSize.height],
      format: 'rgba16float',
      label: 'triangle-led-front-direct-triangle-raycast',
    });
    const triangle = canonicalTriangleGeometry(simulationSize);
    const lightSourcesRaw = createLightSourcesRaw(gpu, {
      size: [simulationSize.width, simulationSize.height] as const,
      ledStorage,
      triangle,
      ledRadius: triangleLedRadius(simulationSize),
      ledShape: triangleLedShapeDimensions(simulationSize, LEDS_PER_EDGE),
    });
    raycastDraw.set({
      cfg: directTriangleRaycastUniformData(simulationSize),
      light_sources_tex: lightSourcesRaw.texture,
    });
    const raycastBundle = gpu.bundle(
      { target: raycastTarget, label: 'triangle-led-front-raycast' },
      (bundle) => bundle.draw(raycastDraw),
    );
    return {
      simulationSize,
      presentationSize,
      pixelRatio,
      probeDensity,
      cascadeFit: fit,
      leds,
      ledStorage,
      lightSourcesRaw,
      raycastTarget,
      raycastBundle,
      floorGate: createFloorUniformGate(),
      floorUniformReady: false,
      lightGlowUniformReady: false,
    };
  }

  function destroyParts(p: RendererParts): void {
    p.lightSourcesRaw.destroy();
    p.ledStorage.destroy?.();
    p.ledStorage.buffer?.destroy();
    const raycastTexture = p.raycastTarget?.color?.gpu ?? p.raycastTarget?.gpu;
    raycastTexture?.destroy?.();
  }
}


function directTriangleRaycastUniformData(simulationSize: RenderSize) {
  const size = directTriangleTargetSize(simulationSize);
  // Cast rays at the inset LED-mesh triangle (where the emitters actually are), NOT the
  // canonical edge — otherwise ray hits land in the gap between the inset LEDs and the
  // full-size occluder, sampling LED/background inconsistently and serrating the glow.
  const triangle = ledMeshGeometry(simulationSize);
  // 20 floats (5 vec4f), all static — written once below.
  const tri_a_b = [triangle.top.x, triangle.top.y, triangle.left.x, triangle.left.y];
  const tri_c_target = [triangle.right.x, triangle.right.y, size.width, size.height];
  // size_steps.z/w (min ray step + edge hit threshold) are absolute sim px. On a short sim a
  // fixed px is a LARGER fraction of the scene, so near-edge pixels skip the nearest LED hit
  // (min-step cutoff) and instead pick up a more distant, different-hued LED — over-mixing hues
  // → desaturation. Scale both by the sim height as a fraction of the desktop cap so they are a
  // CONSTANT fraction of the scene. >= cap → factor 1 (desktop byte-identical), like the
  // geometric falloff (target_info.y) and the per-px absorption (params.x) already do.
  const pxStepScale =
    Math.min(simulationSize.height, HERO_CANVAS_MAX_CSS) / HERO_CANVAS_MAX_CSS;
  const size_steps = [
    simulationSize.width,
    simulationSize.height,
    DIRECT_TRIANGLE_MIN_STEP_PX * pxStepScale,
    DIRECT_TRIANGLE_HIT_THRESHOLD_PX * pxStepScale,
  ];
  const params = [
    // params.x: Beer-Lambert absorption per sim px (extinction-over-sim-height / height).
    DIRECT_TRIANGLE_ABSORPTION / simulationSize.height,
    DIRECT_TRIANGLE_FALLOFF_POWER,
    DIRECT_TRIANGLE_INTENSITY_SCALE,
    DIRECT_TRIANGLE_MIN_SOURCE_LUMA,
  ];
  // target_info.y: geometric-falloff distance scale = reference height / sim height, so the
  // pow(distance) falloff depends on distance as a FRACTION of the scene size (resolution-
  // independent radiance) instead of raw sim px. Anchored to HERO_CANVAS_MAX_CSS so the
  // desktop look is unchanged; shorter render targets no longer read brighter/whiter.
  const target_info = [
    DIRECT_TRIANGLE_TARGET_SCALE,
    HERO_CANVAS_MAX_CSS / Math.max(simulationSize.height, 1),
    0,
    0,
  ];
  return { tri_a_b, tri_c_target, size_steps, params, target_info };
}

interface FloorUniformInputs {
  width: number;
  height: number;
  tunables: SceneTunables;
  probeDiscard: ProbeDiscardSettings;
  theme: 'dark' | 'light';
  lightAo: LightAoSettings;
  radianceDebug: RadianceDebugSettings;
  darkFloor: DarkFloorSettings;
  darkPostprocess: DarkPostprocessSettings;
  showForegroundTriangle: boolean;
}

interface FloorUniformGate {
  currentFloorWidth: number;
  currentFloorHeight: number;
  currentFloorTheme: 'dark' | 'light' | undefined;
  currentDarkFloorAlbedo: number;
  currentLightFloorAlbedo: number;
  currentLedIntensity: number;
  currentFloorLightAabbPadding: number;
  currentLightAoRadiance: number;
  currentLightAoContactOpacity: number;
  currentLightAoContactSize: number;
  currentLightAoContactFalloffPower: number;
  currentLightAoHighlightPower: number;
  currentLightAoHighlightStrength: number;
  currentFloorRadianceDebugEnabled: boolean | undefined;
  currentFloorRadianceDebugRed: number;
  currentFloorRadianceDebugGreen: number;
  currentFloorRadianceDebugBlue: number;
  currentDarkFloorSdfFadeDistanceScale: number;
  currentDarkFloorSdfFadeEdgePx: number;
  currentDarkFloorNearFalloffPower: number;
  currentDarkFloorNearFalloffDistanceScale: number;
  currentDarkFloorNearFalloffIntensity: number;
  currentDarkFloorNearFalloffMapMin: number;
  currentDarkFloorNearFalloffMapMax: number;
  currentDarkFloorTailIntensity: number;
  currentDarkFloorTailMapMin: number;
  currentDarkFloorTailMapMax: number;
  currentDarkFloorTailPower: number;
  currentDarkFloorMiddleFalloffPower: number;
  currentDarkFloorMiddleFalloffIntensity: number;
  currentDarkFloorNearFalloffEnabled: boolean | undefined;
  currentDarkFloorMiddleFalloffEnabled: boolean | undefined;
  currentDarkFloorFarFalloffEnabled: boolean | undefined;
  currentDarkFloorNoiseEnabled: boolean | undefined;
  currentDarkFloorRadianceJitterPx: number;
  currentDarkFloorVibrancy: number;
  currentDarkPostprocessContrast: number;
  currentDarkPostprocessExposure: number;
  currentShowForegroundTriangle: boolean | undefined;
}

function createFloorUniformGate(): FloorUniformGate {
  return {
    currentFloorWidth: Number.NaN,
    currentFloorHeight: Number.NaN,
    currentFloorTheme: undefined,
    currentDarkFloorAlbedo: Number.NaN,
    currentLightFloorAlbedo: Number.NaN,
    currentLedIntensity: Number.NaN,
    currentFloorLightAabbPadding: Number.NaN,
    currentLightAoRadiance: Number.NaN,
    currentLightAoContactOpacity: Number.NaN,
    currentLightAoContactSize: Number.NaN,
    currentLightAoContactFalloffPower: Number.NaN,
    currentLightAoHighlightPower: Number.NaN,
    currentLightAoHighlightStrength: Number.NaN,
    currentFloorRadianceDebugEnabled: undefined,
    currentFloorRadianceDebugRed: Number.NaN,
    currentFloorRadianceDebugGreen: Number.NaN,
    currentFloorRadianceDebugBlue: Number.NaN,
    currentDarkFloorSdfFadeDistanceScale: Number.NaN,
    currentDarkFloorSdfFadeEdgePx: Number.NaN,
    currentDarkFloorNearFalloffPower: Number.NaN,
    currentDarkFloorNearFalloffDistanceScale: Number.NaN,
    currentDarkFloorNearFalloffIntensity: Number.NaN,
    currentDarkFloorNearFalloffMapMin: Number.NaN,
    currentDarkFloorNearFalloffMapMax: Number.NaN,
    currentDarkFloorTailIntensity: Number.NaN,
    currentDarkFloorTailMapMin: Number.NaN,
    currentDarkFloorTailMapMax: Number.NaN,
    currentDarkFloorTailPower: Number.NaN,
    currentDarkFloorMiddleFalloffPower: Number.NaN,
    currentDarkFloorMiddleFalloffIntensity: Number.NaN,
    currentDarkFloorNearFalloffEnabled: undefined,
    currentDarkFloorMiddleFalloffEnabled: undefined,
    currentDarkFloorFarFalloffEnabled: undefined,
    currentDarkFloorNoiseEnabled: undefined,
    currentDarkFloorRadianceJitterPx: Number.NaN,
    currentDarkFloorVibrancy: Number.NaN,
    currentDarkPostprocessContrast: Number.NaN,
    currentDarkPostprocessExposure: Number.NaN,
    currentShowForegroundTriangle: undefined,
  };
}

function writeFloorUniformIfNeeded(
  parts: RendererParts,
  inputs: FloorUniformInputs,
): ReturnType<typeof floorUniformData> | undefined {
  const gate = parts.floorGate;
  const {
    width,
    height,
    tunables,
    probeDiscard = PROBE_DISCARD_DEFAULTS,
    theme = 'dark',
    lightAo = LIGHT_AO_DEFAULTS,
    radianceDebug = RADIANCE_DEBUG_DEFAULTS,
    darkFloor = DARK_FLOOR_DEFAULTS,
    darkPostprocess = DARK_POSTPROCESS_DEFAULTS,
    showForegroundTriangle = true,
  } = inputs;
  const floorUniformChanged =
    width !== gate.currentFloorWidth ||
    height !== gate.currentFloorHeight ||
    theme !== gate.currentFloorTheme ||
    tunables.darkFloorAlbedo !== gate.currentDarkFloorAlbedo ||
    tunables.lightFloorAlbedo !== gate.currentLightFloorAlbedo ||
    tunables.ledIntensity !== gate.currentLedIntensity ||
    probeDiscard.lightAabbPadding !== gate.currentFloorLightAabbPadding ||
    lightAo.radiance !== gate.currentLightAoRadiance ||
    lightAo.contactOpacity !== gate.currentLightAoContactOpacity ||
    lightAo.contactSize !== gate.currentLightAoContactSize ||
    lightAo.contactFalloffPower !== gate.currentLightAoContactFalloffPower ||
    lightAo.highlightPower !== gate.currentLightAoHighlightPower ||
    lightAo.highlightStrength !== gate.currentLightAoHighlightStrength ||
    radianceDebug.enabled !== gate.currentFloorRadianceDebugEnabled ||
    radianceDebug.redMultiplier !== gate.currentFloorRadianceDebugRed ||
    radianceDebug.greenMultiplier !== gate.currentFloorRadianceDebugGreen ||
    radianceDebug.blueMultiplier !== gate.currentFloorRadianceDebugBlue ||
    darkFloor.sdfFadeDistanceScale !==
      gate.currentDarkFloorSdfFadeDistanceScale ||
    darkFloor.sdfFadeEdgePx !== gate.currentDarkFloorSdfFadeEdgePx ||
    darkFloor.nearFalloffPower !== gate.currentDarkFloorNearFalloffPower ||
    darkFloor.nearFalloffDistanceScale !==
      gate.currentDarkFloorNearFalloffDistanceScale ||
    darkFloor.nearFalloffIntensity !==
      gate.currentDarkFloorNearFalloffIntensity ||
    darkFloor.nearFalloffMapMin !== gate.currentDarkFloorNearFalloffMapMin ||
    darkFloor.nearFalloffMapMax !== gate.currentDarkFloorNearFalloffMapMax ||
    darkFloor.tailIntensity !== gate.currentDarkFloorTailIntensity ||
    darkFloor.tailMapMin !== gate.currentDarkFloorTailMapMin ||
    darkFloor.tailMapMax !== gate.currentDarkFloorTailMapMax ||
    darkFloor.tailPower !== gate.currentDarkFloorTailPower ||
    darkFloor.middleFalloffPower !== gate.currentDarkFloorMiddleFalloffPower ||
    darkFloor.middleFalloffIntensity !==
      gate.currentDarkFloorMiddleFalloffIntensity ||
    darkFloor.nearFalloffEnabled !== gate.currentDarkFloorNearFalloffEnabled ||
    darkFloor.middleFalloffEnabled !==
      gate.currentDarkFloorMiddleFalloffEnabled ||
    darkFloor.farFalloffEnabled !== gate.currentDarkFloorFarFalloffEnabled ||
    darkFloor.noiseEnabled !== gate.currentDarkFloorNoiseEnabled ||
    darkFloor.radianceJitterPx !== gate.currentDarkFloorRadianceJitterPx ||
    darkFloor.vibrancy !== gate.currentDarkFloorVibrancy ||
    darkPostprocess.contrast !== gate.currentDarkPostprocessContrast ||
    darkPostprocess.exposure !== gate.currentDarkPostprocessExposure ||
    showForegroundTriangle !== gate.currentShowForegroundTriangle;
  if (!floorUniformChanged) return undefined;

  const data = floorUniformData(
    width,
    height,
    parts.simulationSize,
    parts.presentationSize,
    parts.pixelRatio,
    parts.cascadeFit,
    tunables,
    probeDiscard,
    theme,
    lightAo,
    radianceDebug,
    darkFloor,
    darkPostprocess,
    showForegroundTriangle,
  );

  gate.currentFloorWidth = width;
  gate.currentFloorHeight = height;
  gate.currentFloorTheme = theme;
  gate.currentDarkFloorAlbedo = tunables.darkFloorAlbedo;
  gate.currentLightFloorAlbedo = tunables.lightFloorAlbedo;
  gate.currentLedIntensity = tunables.ledIntensity;
  gate.currentFloorLightAabbPadding = probeDiscard.lightAabbPadding;
  gate.currentLightAoRadiance = lightAo.radiance;
  gate.currentLightAoContactOpacity = lightAo.contactOpacity;
  gate.currentLightAoContactSize = lightAo.contactSize;
  gate.currentLightAoContactFalloffPower = lightAo.contactFalloffPower;
  gate.currentLightAoHighlightPower = lightAo.highlightPower;
  gate.currentLightAoHighlightStrength = lightAo.highlightStrength;
  gate.currentFloorRadianceDebugEnabled = radianceDebug.enabled;
  gate.currentFloorRadianceDebugRed = radianceDebug.redMultiplier;
  gate.currentFloorRadianceDebugGreen = radianceDebug.greenMultiplier;
  gate.currentFloorRadianceDebugBlue = radianceDebug.blueMultiplier;
  gate.currentDarkFloorSdfFadeDistanceScale = darkFloor.sdfFadeDistanceScale;
  gate.currentDarkFloorSdfFadeEdgePx = darkFloor.sdfFadeEdgePx;
  gate.currentDarkFloorNearFalloffPower = darkFloor.nearFalloffPower;
  gate.currentDarkFloorNearFalloffDistanceScale =
    darkFloor.nearFalloffDistanceScale;
  gate.currentDarkFloorNearFalloffIntensity = darkFloor.nearFalloffIntensity;
  gate.currentDarkFloorNearFalloffMapMin = darkFloor.nearFalloffMapMin;
  gate.currentDarkFloorNearFalloffMapMax = darkFloor.nearFalloffMapMax;
  gate.currentDarkFloorTailIntensity = darkFloor.tailIntensity;
  gate.currentDarkFloorTailMapMin = darkFloor.tailMapMin;
  gate.currentDarkFloorTailMapMax = darkFloor.tailMapMax;
  gate.currentDarkFloorTailPower = darkFloor.tailPower;
  gate.currentDarkFloorMiddleFalloffPower = darkFloor.middleFalloffPower;
  gate.currentDarkFloorMiddleFalloffIntensity =
    darkFloor.middleFalloffIntensity;
  gate.currentDarkFloorNearFalloffEnabled = darkFloor.nearFalloffEnabled;
  gate.currentDarkFloorMiddleFalloffEnabled = darkFloor.middleFalloffEnabled;
  gate.currentDarkFloorFarFalloffEnabled = darkFloor.farFalloffEnabled;
  gate.currentDarkFloorNoiseEnabled = darkFloor.noiseEnabled;
  gate.currentDarkFloorRadianceJitterPx = darkFloor.radianceJitterPx;
  gate.currentDarkFloorVibrancy = darkFloor.vibrancy;
  gate.currentDarkPostprocessContrast = darkPostprocess.contrast;
  gate.currentDarkPostprocessExposure = darkPostprocess.exposure;
  gate.currentShowForegroundTriangle = showForegroundTriangle;
  return data;
}

function initialFloorUniformData() {
  const zero = [0, 0, 0, 0];
  return {
    screen: zero,
    light_sources: zero,
    tunables: zero,
    triangle: zero,
    culling: zero,
    radiance_fit: zero,
    light_ao: zero,
    radiance_debug: zero,
    sim_transform: zero,
    dark_floor: zero,
    dark_glow: zero,
    dark_near: zero,
    dark_middle: zero,
    dark_toggles: zero,
    dark_circle: zero,
    dark_noise: zero,
  };
}

function initialLightGlowUniformData() {
  const zero = [0, 0, 0, 0];
  return {
    near: zero,
    middle: zero,
    glow: zero,
    params: zero,
    toggles: zero,
    ao: zero,
    ao2: zero,
    ao3: zero,
    edgeRed: zero,
    edgeGreen: zero,
    edgeBlue: zero,
    nearColor: zero,
    middleColor: zero,
    glowColor: zero,
    paramsColor: zero,
    togglesColor: zero,
  };
}

// Packs the light-glow settings into the binding-4 uniform read by the light floor.
// Layout (16 × vec4f = 256 bytes) — keep in LOCKSTEP with the WGSL LightGlow struct + buffer size:
function rgbToOklab(c: { r: number; g: number; b: number }): {
  r: number;
  g: number;
  b: number;
} {
  const x = 0.412165612 * c.r + 0.536275208 * c.g + 0.0514575653 * c.b;
  const y = 0.21185911 * c.r + 0.6807189584 * c.g + 0.107406579 * c.b;
  const z = 0.0883097947 * c.r + 0.2818474174 * c.g + 0.6302613616 * c.b;
  return { r: Math.cbrt(x), g: Math.cbrt(y), b: Math.cbrt(z) };
}

function lightGlowUniformData(g: LightGlowSettings, colorMix: number) {
  const invOverlap = 1 / Math.max(g.edgeOverlap, 0.01);
  const labR = rgbToOklab(g.edgeRedRgb);
  const labG = rgbToOklab(g.edgeGreenRgb);
  const labB = rgbToOklab(g.edgeBlueRgb);
  return {
    near: [g.nearDistanceScale, g.nearIntensity, g.nearMapMin, g.nearMapMax],
    middle: [g.middlePower, g.middleIntensity, g.highlightNoise, 0],
    glow: [g.farIntensity, colorMix, g.farMapMin, g.farMapMax],
    params: [g.nearPower, g.middleOuterScale, g.farPower, g.fadeInner],
    toggles: [
      g.nearEnabled ? 1 : 0,
      g.middleEnabled ? 1 : 0,
      g.farEnabled ? 1 : 0,
      g.contrast,
    ],
    ao: [g.aoStrength, g.aoRadiusScale, g.aoPower, g.aoEnabled ? 1 : 0],
    ao2: [g.ao2Strength, g.ao2RadiusScale, g.ao2Power, g.ao2Enabled ? 1 : 0],
    ao3: [g.ao3Strength, g.ao3RadiusScale, g.ao3Power, g.ao3Enabled ? 1 : 0],
    edgeRed: [labR.r, labR.g, labR.b, invOverlap],
    edgeGreen: [labG.r, labG.g, labG.b, 0],
    edgeBlue: [labB.r, labB.g, labB.b, 0],
    nearColor: [
      g.nearDistanceScaleColor,
      g.nearIntensityColor,
      g.nearMapMinColor,
      g.nearMapMaxColor,
    ],
    middleColor: [g.middlePowerColor, g.middleIntensityColor, 0, 0],
    glowColor: [
      g.farIntensityColor,
      g.highlightDebug ? 1 : 0,
      g.farMapMinColor,
      g.farMapMaxColor,
    ],
    paramsColor: [
      g.nearPowerColor,
      g.middleOuterScaleColor,
      g.farPowerColor,
      g.fadeInnerColor,
    ],
    togglesColor: [
      g.nearEnabledColor ? 1 : 0,
      g.middleEnabledColor ? 1 : 0,
      g.farEnabledColor ? 1 : 0,
      g.contrastColor,
    ],
  };
}

function floorUniformData(
  width: number,
  height: number,
  simulationSize: RenderSize,
  presentationSize: RenderSize,
  pixelRatio: number,
  cascadeFit: CascadeFitRect,
  tunables: SceneTunables,
  probeDiscard: ProbeDiscardSettings,
  theme: 'dark' | 'light',
  lightAo: LightAoSettings,
  radianceDebug: RadianceDebugSettings,
  darkFloor: DarkFloorSettings,
  darkPostprocess: DarkPostprocessSettings,
  showForegroundTriangle: boolean,
) {
  const transform = presentationSimulationTransform(
    simulationSize,
    presentationSize,
  );
  const triangle = presentationTriangleParams(simulationSize, transform);
  const isLightTheme = theme === 'light' ? 1 : 0;
  const contactAoStrength = theme === 'light' ? lightAo.contactOpacity : 0;
  const contactAoSize = theme === 'light' ? lightAo.contactSize : 0;
  const floorAlbedo =
    theme === 'light' ? tunables.lightFloorAlbedo : tunables.darkFloorAlbedo;
  const referencePresentationHeight =
    HERO_CANVAS_MAX_CSS * Math.max(pixelRatio, 1e-4);
  const radianceJitterNorm =
    Math.min(presentationSize.height, referencePresentationHeight) /
    referencePresentationHeight;
  return {
    screen: [width, height, isLightTheme, pixelRatio],
    light_sources: [
      simulationSize.width,
      simulationSize.height,
      0,
      contactAoStrength,
    ],
    tunables: [tunables.ledIntensity, floorAlbedo, lightAo.radiance, contactAoSize],
    triangle: [
      triangle.centerX,
      triangle.centerY,
      triangle.circumradiusY,
      triangle.halfSideX,
    ],
    culling: [
      probeDiscard.lightAabbPadding * triangle.scaleX,
      probeDiscard.lightAabbPadding * triangle.scaleY,
      showForegroundTriangle ? 1 : 0,
      0,
    ],
    radiance_fit: [
      transform.originX + cascadeFit.originSceneX * transform.scale,
      transform.originY + cascadeFit.originSceneY * transform.scale,
      cascadeFit.widthScene * transform.scale,
      cascadeFit.heightScene * transform.scale,
    ],
    light_ao: [
      lightAo.contactFalloffPower,
      lightAo.highlightPower,
      lightAo.highlightStrength,
      0,
    ],
    radiance_debug: [
      radianceDebug.enabled ? 1 : 0,
      radianceDebug.redMultiplier,
      radianceDebug.greenMultiplier,
      radianceDebug.blueMultiplier,
    ],
    sim_transform: [
      transform.originX,
      transform.originY,
      transform.scale,
      getHeroEdgeFadeFrac(),
    ],
    dark_floor: [
      darkFloor.sdfFadeDistanceScale,
      darkFloor.sdfFadeEdgePx,
      darkFloor.nearFalloffPower,
      darkFloor.tailPower,
    ],
    dark_glow: [
      darkFloor.tailIntensity,
      darkFloor.vibrancy,
      darkFloor.tailMapMin,
      darkFloor.tailMapMax,
    ],
    dark_near: [
      darkFloor.nearFalloffDistanceScale,
      darkFloor.nearFalloffIntensity,
      darkFloor.nearFalloffMapMin,
      darkFloor.nearFalloffMapMax,
    ],
    dark_middle: [
      darkFloor.middleFalloffPower,
      darkFloor.middleFalloffIntensity,
      darkFloor.radianceJitterPx,
      radianceJitterNorm,
    ],
    dark_toggles: [
      darkFloor.nearFalloffEnabled ? 1 : 0,
      darkFloor.middleFalloffEnabled ? 1 : 0,
      darkFloor.farFalloffEnabled ? 1 : 0,
      darkPostprocess.contrast,
    ],
    dark_circle: [getHeroEdgeFadeFrac(), darkPostprocess.exposure, 0, 0],
    dark_noise: [darkFloor.noiseEnabled ? 1 : 0, 0, 0, 0],
  };
}

interface PresentationSimulationTransform {
  originX: number;
  originY: number;
  scale: number;
}

function presentationSimulationTransform(
  simulationSize: RenderSize,
  presentationSize: RenderSize,
): PresentationSimulationTransform {
  // FIT scale = presentationHeight / simHeight. The sim shares the canvas aspect (both
  // dims floored by the same factor in canvasRenderSizing), so fitting by height is
  // uniform and the origin stays ~0 (the scene still fills the canvas). When the sim is
  // NOT floored (sim height == CSS height), presentationHeight/simHeight = (cssH·dpr)/cssH
  // = dpr, identical to the old scale=pixelRatio — so unfloored/desktop is byte-identical.
  const scale = Math.max(
    0.001,
    presentationSize.height / Math.max(1, simulationSize.height),
  );
  return {
    originX: (presentationSize.width - simulationSize.width * scale) * 0.5,
    originY: (presentationSize.height - simulationSize.height * scale) * 0.5,
    scale,
  };
}

function presentationTriangleParams(
  simulationSize: RenderSize,
  transform: PresentationSimulationTransform,
) {
  const geometry = canonicalTriangleGeometry(simulationSize);
  return {
    centerX: transform.originX + geometry.center.x * transform.scale,
    centerY: transform.originY + geometry.center.y * transform.scale,
    circumradiusY: geometry.circumradius * transform.scale,
    halfSideX: geometry.sideLength * 0.5 * transform.scale,
    scaleX: transform.scale,
    scaleY: transform.scale,
  };
}

function normalizedSize(width: number, height: number): RenderSize {
  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  };
}

function normalizedPixelRatio(value: number | undefined): number {
  return Math.max(
    0.001,
    typeof value === 'number' && Number.isFinite(value) ? value : 1,
  );
}
