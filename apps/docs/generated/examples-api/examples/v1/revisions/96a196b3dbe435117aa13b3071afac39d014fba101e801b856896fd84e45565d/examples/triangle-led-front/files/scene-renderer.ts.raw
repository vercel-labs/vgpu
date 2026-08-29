import type { Bundle, Frame, FramePass, Gpu, StorageBuffer, Target } from 'vgpu';
import { bundle, draw, frame, storage, target } from 'vgpu';

import {
  HERO_CANVAS_MAX_CSS,
  canonicalTriangleGeometry,
  ledMeshGeometry,
  resolveHeroSceneScale,
  setHeroSceneScale,
  type BrushState,
  type HeroStateSettings,
  type RenderSize,
} from './settings';
import { buildLedGeometry, computeLeds, type LedGeometryState } from './led-buffer';
import { createHeroFrameState } from './hero-frame-state';
import { createLightSourcesRaw, type LightSourcesRaw } from './light-sources-raw';
import { canvasRenderSizing } from './sim-sizing';
import raycastWgsl from './shaders/direct-triangle-raycast.wgsl';
import floorNoiseWgsl from './shaders/floor-noise.wgsl';
import darkFloorWgsl from './shaders/themes/dark/main-scene-floor.wgsl';

const DIRECT_TRIANGLE_TARGET_SCALE = 0.5;
const DIRECT_TRIANGLE_MIN_STEP_PX = 1.5;
const DIRECT_TRIANGLE_HIT_THRESHOLD_PX = 0.75;
const DIRECT_TRIANGLE_ABSORPTION = 2;
const DIRECT_TRIANGLE_FALLOFF_POWER = 1;
const DIRECT_TRIANGLE_INTENSITY_SCALE = 50;
const DIRECT_TRIANGLE_MIN_SOURCE_LUMA = 0.001;

export interface HeroRendererCss {
  width: number;
  height: number;
  dpr: number;
}

export interface HeroRenderFrameArgs {
  time: number;
  dt?: number;
}

export interface HeroRenderer {
  renderFrame(currentFrame: Frame, args: HeroRenderFrameArgs): void;
  setOutputTarget(colorTarget: Target): void;
  rebuild(css: HeroRendererCss): void;
  setBrush(b: Partial<BrushState>): void;
  setHero(state: Partial<HeroStateSettings>): void;
  setRgbDeployActive(v: boolean): void;
  readonly hero: Partial<HeroStateSettings>;
  prewarm(): Promise<void>;
  destroy(): void;
}

type DestroyableStorage = StorageBuffer & {
  readonly buffer?: { destroy(): void };
  destroy?: () => void;
};

interface RendererParts {
  simulationSize: RenderSize;
  presentationSize: RenderSize;
  pixelRatio: number;
  leds: LedGeometryState;
  ledStorage: DestroyableStorage;
  lightSources: LightSourcesRaw;
  raycastTarget: Target;
  raycastBundle: Bundle;
  floorBundle?: Bundle;
}

export function createHeroRenderer(
  gpu: Gpu,
  opts: { theme?: 'dark'; css: HeroRendererCss; target?: Target },
): HeroRenderer {
  const frameState = createHeroFrameState();
  const hero: Partial<HeroStateSettings> = {};
  const brush: Partial<BrushState> = {};
  let rgbDeployActive = false;
  let outputTarget = opts.target;
  let destroyed = false;

  const noiseTarget = target(gpu, {
    size: [500, 500],
    format: 'rgba16float',
    label: 'triangle-led-front-floor-noise',
  });
  const noiseDraw = draw(gpu, { shader: floorNoiseWgsl, vertices: 3 });
  const floorDraw = draw(gpu, { shader: darkFloorWgsl, vertices: 3 });
  const raycastDraw = draw(gpu, { shader: raycastWgsl, vertices: 3 });
  frame(gpu, (currentFrame: Frame) => {
    currentFrame.pass({ target: noiseTarget }, (pass: FramePass) => pass.draw(noiseDraw));
  });

  let parts = buildParts(opts.css);
  if (outputTarget) recordFloorBundle(parts, outputTarget);

  return {
    hero,
    renderFrame(currentFrame, { time }) {
      if (destroyed || !outputTarget) return;
      const current = parts;
      const { tunables } = frameState.resolveFrame({
        patch: brush,
        hero,
        hoverRgbDeployActive: rgbDeployActive,
        time,
        updateLedsFor(ctx) {
          computeLeds(
            current.leds,
            ctx.time,
            ctx.tunables,
            ctx.settings,
            ctx.hoverDeploy,
            ctx.brush,
          );
          current.ledStorage.write(current.leds.data.buffer as ArrayBuffer);
        },
      });
      current.lightSources.encode({ frame: currentFrame, tunables });
      currentFrame.pass(
        { target: current.raycastTarget, clear: [0, 0, 0, 1] },
        (pass: FramePass) => pass.bundles(current.raycastBundle),
      );
      const floorBundle = current.floorBundle ?? recordFloorBundle(current, outputTarget);
      currentFrame.pass(
        { target: outputTarget, clear: [0, 0, 0, 1] },
        (pass: FramePass) => pass.bundles(floorBundle),
      );
    },
    setOutputTarget(colorTarget) {
      outputTarget = colorTarget;
      recordFloorBundle(parts, colorTarget);
    },
    rebuild(css) {
      if (destroyed) return;
      const next = buildParts(css, parts.leds);
      destroyParts(parts);
      parts = next;
      if (outputTarget) recordFloorBundle(parts, outputTarget);
    },
    setBrush(next) {
      Object.assign(brush, next);
    },
    setHero(next) {
      Object.assign(hero, next);
    },
    setRgbDeployActive(active) {
      rgbDeployActive = active;
    },
    async prewarm() {
      if (!outputTarget) return;
      await Promise.all([
        floorDraw.compile({ colors: [outputTarget.format] }),
        raycastDraw.compile(parts.raycastTarget),
        noiseDraw.compile(noiseTarget),
        parts.lightSources.ready,
      ]);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      destroyParts(parts);
    },
  };

  function recordFloorBundle(current: RendererParts, colorTarget: Target) {
    floorDraw.set({
      cfg: floorUniformData(current),
      radiance_tex: current.raycastTarget,
      light_sources_tex: current.lightSources.texture,
      floor_noise_tex: noiseTarget,
    });
    const result = bundle(
      gpu,
      { target: { colors: [colorTarget.format] }, label: 'triangle-led-front-dark-floor' },
      (recorded) => recorded.draw(floorDraw),
    );
    current.floorBundle = result;
    return result;
  }

  function buildParts(css: HeroRendererCss, previous?: LedGeometryState): RendererParts {
    setHeroSceneScale(resolveHeroSceneScale(1, css.height, false));
    const sizing = canvasRenderSizing(css.width, css.height, css.dpr);
    const simulationSize = normalizedSize(sizing.simulationWidth, sizing.simulationHeight);
    const presentationSize = normalizedSize(css.width * css.dpr, css.height * css.dpr);
    const pixelRatio = normalizedPixelRatio(sizing.pixelRatio);
    const leds = buildLedGeometry(simulationSize, previous);
    const ledStorage = storage(gpu, 72 * 8 * 4) as DestroyableStorage;
    ledStorage.write(leds.data.buffer as ArrayBuffer);
    const raycastSize = directTriangleTargetSize(simulationSize);
    const raycastTarget = target(gpu, {
      size: [raycastSize.width, raycastSize.height],
      format: 'rgba16float',
      label: 'triangle-led-front-direct-triangle-raycast',
    });
    const lightSources = createLightSourcesRaw(gpu, {
      size: [simulationSize.width, simulationSize.height],
      ledStorage,
      triangle: canonicalTriangleGeometry(simulationSize),
    });
    raycastDraw.set({
      cfg: directTriangleRaycastUniformData(simulationSize),
      light_sources_tex: lightSources.texture,
    });
    const raycastBundle = bundle(
      gpu,
      { target: raycastTarget, label: 'triangle-led-front-raycast' },
      (recorded) => recorded.draw(raycastDraw),
    );
    return {
      simulationSize,
      presentationSize,
      pixelRatio,
      leds,
      ledStorage,
      lightSources,
      raycastTarget,
      raycastBundle,
    };
  }

  function destroyParts(current: RendererParts) {
    current.lightSources.destroy();
    current.ledStorage.destroy?.();
    current.ledStorage.buffer?.destroy();
    const texture = current.raycastTarget.color?.gpu ?? current.raycastTarget.gpu;
    texture?.destroy?.();
  }
}

function directTriangleRaycastUniformData(simulationSize: RenderSize) {
  const size = directTriangleTargetSize(simulationSize);
  const triangle = ledMeshGeometry(simulationSize);
  const pxStepScale =
    Math.min(simulationSize.height, HERO_CANVAS_MAX_CSS) / HERO_CANVAS_MAX_CSS;
  return {
    tri_a_b: [triangle.top.x, triangle.top.y, triangle.left.x, triangle.left.y],
    tri_c_target: [triangle.right.x, triangle.right.y, size.width, size.height],
    size_steps: [
      simulationSize.width,
      simulationSize.height,
      DIRECT_TRIANGLE_MIN_STEP_PX * pxStepScale,
      DIRECT_TRIANGLE_HIT_THRESHOLD_PX * pxStepScale,
    ],
    params: [
      DIRECT_TRIANGLE_ABSORPTION / simulationSize.height,
      DIRECT_TRIANGLE_FALLOFF_POWER,
      DIRECT_TRIANGLE_INTENSITY_SCALE,
      DIRECT_TRIANGLE_MIN_SOURCE_LUMA,
    ],
    target_info: [
      DIRECT_TRIANGLE_TARGET_SCALE,
      HERO_CANVAS_MAX_CSS / Math.max(simulationSize.height, 1),
      0,
      0,
    ],
  };
}

function directTriangleTargetSize(size: RenderSize) {
  return {
    width: Math.max(1, Math.ceil(size.width * DIRECT_TRIANGLE_TARGET_SCALE)),
    height: Math.max(1, Math.ceil(size.height * DIRECT_TRIANGLE_TARGET_SCALE)),
  };
}

function floorUniformData(parts: RendererParts) {
  const { simulationSize, presentationSize, pixelRatio } = parts;
  const transform = presentationSimulationTransform(simulationSize, presentationSize);
  const triangle = presentationTriangleParams(simulationSize, transform);
  const referencePresentationHeight =
    HERO_CANVAS_MAX_CSS * Math.max(pixelRatio, 1e-4);
  const radianceJitterNorm =
    Math.min(presentationSize.height, referencePresentationHeight) /
    referencePresentationHeight;
  return {
    screen: [presentationSize.width, presentationSize.height, 0, pixelRatio],
    light_sources: [simulationSize.width, simulationSize.height, 0, 0],
    triangle: [
      triangle.centerX,
      triangle.centerY,
      triangle.circumradiusY,
      triangle.halfSideX,
    ],
    radiance_fit: [
      transform.originX,
      transform.originY,
      simulationSize.width * transform.scale,
      simulationSize.height * transform.scale,
    ],
    sim_transform: [
      transform.originX,
      transform.originY,
      transform.scale,
      radianceJitterNorm,
    ],
  };
}

function presentationSimulationTransform(
  simulationSize: RenderSize,
  presentationSize: RenderSize,
) {
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
  transform: ReturnType<typeof presentationSimulationTransform>,
) {
  const geometry = canonicalTriangleGeometry(simulationSize);
  return {
    centerX: transform.originX + geometry.center.x * transform.scale,
    centerY: transform.originY + geometry.center.y * transform.scale,
    circumradiusY: geometry.circumradius * transform.scale,
    halfSideX: geometry.sideLength * 0.5 * transform.scale,
  };
}

function normalizedSize(width: number, height: number): RenderSize {
  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  };
}

function normalizedPixelRatio(value: number | undefined) {
  return Math.max(
    0.001,
    typeof value === 'number' && Number.isFinite(value) ? value : 1,
  );
}
