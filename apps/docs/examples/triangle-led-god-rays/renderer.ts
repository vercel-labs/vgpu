import { type Device, type Texture } from 'vgpu';
import {
  BLOOM_FORMAT,
  createBloomPass,
  type BloomPass,
  type BloomShared,
} from './passes/bloom-pass';
import {
  CASCADE_FORMAT,
  createCascadeBuildPass,
  type CascadeBuildPass,
  type CascadeBuildShared,
} from './passes/cascade-build-pass';
import {
  createCascadeMergePass,
  type CascadeMergePass,
  type CascadeMergeShared,
} from './passes/cascade-merge-pass';
import {
  createCompositePass,
  type CompositePass,
  type CompositeShared,
} from './passes/composite-pass';
import {
  createLedBuffer,
  type LedBufferState,
  type LedTransitionFrame,
  updateLeds,
} from './led-buffer';
import {
  LIGHT_SOURCES_FORMAT,
  createLightSourcesPass,
  type BrushState,
  type LightSourcesPass,
  type LightSourcesShared,
  type SceneTunables,
} from './passes/light-sources-pass';
import {
  MAIN_SCENE_FORMAT,
  createMainScenePass,
  type MainScenePass,
  type MainSceneShared,
} from './passes/main-scene-pass';
import {
  createRenderPipelineAsync,
  renderPipelineDescriptor,
  shaderModule,
} from './pipeline-utils';
import {
  createRadianceFieldPass,
  type RadianceFieldPass,
  type RadianceFieldShared,
} from './passes/radiance-field-pass';
import {
  cascadeCount,
  cascadeFitRect,
  DEFAULT_BRUSH,
  PROBE_DENSITY,
  PROBE_DENSITY_MAX,
  PROBE_DENSITY_MIN,
  HERO_STATE_DEFAULTS,
  HERO_STATE_MODES,
  mergeBloomSettings,
  mergeGodRaySettings,
  mergeHeroStateSettings,
  mergeLightAoSettings,
  mergeProbeDiscardSettings,
  TUNABLE_DEFAULTS,
  type BloomSettings,
  type GodRaySettings,
  type HeroStateMode,
  type HeroStateSettings,
  type CascadeFitRect,
  type LightAoSettings,
  type ProbeDiscardSettings,
  type RenderSize,
} from './settings';
import bloomWgsl from './shaders/bloom.wgsl';
import cascadeBuildWgsl from './shaders/cascade-build.wgsl';
import cascadeMergeWgsl from './shaders/cascade-merge.wgsl';
import compositeWgsl from './shaders/composite.wgsl';
import floorNoiseWgsl from './shaders/floor-noise.wgsl';
import lightSourcesWgsl from './shaders/light-sources.wgsl';
import mainSceneFloorWgsl from './shaders/main-scene-floor.wgsl';
import mainSceneGodRaysWgsl from './shaders/main-scene-god-rays.wgsl';
import mainSceneTriangleWgsl from './shaders/main-scene-triangle.wgsl';
import radianceFieldWgsl from './shaders/radiance-field.wgsl';

export interface RadianceRenderer {
  readonly stats: {
    cascadeCount: number;
    cascadeWidth: number;
    cascadeHeight: number;
    probeDensity: number;
    cascadeFit: CascadeFitStats;
    vramBytes: number;
  };
  warmup(width: number, height: number, sizing?: RenderSizing): Promise<void>;
  render(
    target: GPUTextureView,
    width: number,
    height: number,
    brush?: Partial<BrushState>,
    time?: number,
    tunables?: SceneTunables,
    bloom?: Partial<BloomSettings>,
    sizing?: RenderSizing,
    options?: RenderOptions,
    probeDiscard?: Partial<ProbeDiscardSettings>,
  ): void;
  debugTextures(): DebugTextures | undefined;
  destroy(): void;
}

export interface CascadeFitStats {
  enabled: boolean;
  originX: number;
  originY: number;
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
  originSceneX: number;
  originSceneY: number;
  widthScene: number;
  heightScene: number;
  areaRatio: number;
  alignment: number;
}

export interface RenderSizing {
  /** CSS/logical DPR=1 size used by light sources/cascade/radiance/bloom. Defaults to target size. */
  simulationWidth?: number;
  simulationHeight?: number;
  /** Multiplies cascade texture dimensions/probe density. Defaults to PROBE_DENSITY. */
  probeDensity?: number;
}

export interface RenderOptions {
  renderBlackOccluder?: boolean;
  hero?: Partial<HeroStateSettings>;
  theme?: 'dark' | 'light';
  lightAo?: Partial<LightAoSettings>;
  godRays?: Partial<GodRaySettings>;
}

export interface RenderTextureFrame {
  /** Monotonically increasing seconds for deterministic multi-frame captures. */
  time: number;
  hero?: Partial<HeroStateSettings>;
}

export interface DebugTextures {
  lightSources: Texture;
  radiance: Texture;
  mainScene: Texture;
  bloom: Texture;
  bloomPing: Texture;
  simulationSize: RenderSize;
  presentationSize: RenderSize;
}

export type TriangleLedStripRenderer = RadianceRenderer;

interface StaticResources {
  lightSources: LightSourcesShared;
  cascadeBuild: CascadeBuildShared;
  cascadeMerge: CascadeMergeShared;
  radiance: RadianceFieldShared;
  mainScene: MainSceneShared;
  bloom: BloomShared;
  composite: CompositeShared;
}

interface RequestedParts {
  simulationSize: RenderSize;
  presentationSize: RenderSize;
  probeDensity: number;
  sequence: number;
}

interface Parts {
  simulationSize: RenderSize;
  presentationSize: RenderSize;
  probeDensity: number;
  cascadeFit: CascadeFitRect;
  cascade: RenderSize;
  leds: LedBufferState;
  lightSources: LightSourcesPass;
  builds: CascadeBuildPass[];
  merges: CascadeMergePass[];
  black: Texture;
  blackView: GPUTextureView;
  radiance: RadianceFieldPass;
  mainScene: MainScenePass;
  bloom: BloomPass;
  composite: CompositePass;
  count: number;
}

export function createRadianceRenderer(
  device: Device,
  format: GPUTextureFormat,
): RadianceRenderer {
  let staticPending: Promise<StaticResources> | undefined;
  let parts: Parts | undefined;
  let requestedParts: RequestedParts | undefined;
  let buildingParts: RequestedParts | undefined;
  let partsPending: Promise<void> | undefined;
  let requestSequence = 0;
  let currentSequence = 0;
  let destroyed = false;
  const waiters: Array<{
    sequence: number;
    resolve(): void;
    reject(reason: unknown): void;
  }> = [];

  const ensureStatic = () => {
    staticPending ??= createStaticResources(device, format);
    return staticPending;
  };

  const requestParts = (
    simulationSize: RenderSize,
    presentationSize: RenderSize,
    probeDensity: number,
    waitForReady = true,
  ): Promise<void> | undefined => {
    const currentMatches =
      parts &&
      sameSize(parts.simulationSize, simulationSize) &&
      sameSize(parts.presentationSize, presentationSize) &&
      sameProbeDensity(parts.probeDensity, probeDensity);
    if (currentMatches) {
      if (
        buildingParts &&
        !sameRequestedParts(
          buildingParts,
          simulationSize,
          presentationSize,
          probeDensity,
        )
      ) {
        requestedParts = {
          simulationSize,
          presentationSize,
          probeDensity,
          sequence: ++requestSequence,
        };
        void maybeStartPartsBuild();
      }
      return waitForReady ? Promise.resolve() : undefined;
    }

    let sequence: number;
    if (
      requestedParts &&
      sameRequestedParts(
        requestedParts,
        simulationSize,
        presentationSize,
        probeDensity,
      )
    ) {
      sequence = requestedParts.sequence;
    } else if (
      buildingParts &&
      sameRequestedParts(
        buildingParts,
        simulationSize,
        presentationSize,
        probeDensity,
      )
    ) {
      sequence = buildingParts.sequence;
    } else {
      sequence = ++requestSequence;
      requestedParts = { simulationSize, presentationSize, probeDensity, sequence };
    }

    const waiter = waitForReady
      ? new Promise<void>((resolve, reject) =>
          waiters.push({ sequence, resolve, reject }),
        )
      : undefined;
    void maybeStartPartsBuild();
    return waiter;
  };

  const maybeStartPartsBuild = () => {
    if (partsPending || destroyed) return;
    if (
      requestedParts &&
      parts &&
      sameRequestedParts(
        requestedParts,
        parts.simulationSize,
        parts.presentationSize,
        parts.probeDensity,
      )
    ) {
      resolveWaitersThrough(requestedParts.sequence);
      requestedParts = undefined;
    }
    const next = requestedParts;
    if (!next) return;
    requestedParts = undefined;
    buildingParts = next;
    partsPending = ensureStatic()
      .then(async (resources) => {
        const ready = createParts(
          device,
          resources,
          next.simulationSize,
          next.presentationSize,
          next.probeDensity,
        );
        return ready;
      })
      .then((ready) => {
        if (destroyed) {
          destroyParts(ready);
          rejectWaitersThrough(
            next.sequence,
            new Error(
              'triangle-led-4 renderer was destroyed before resize resources became ready',
            ),
          );
          return;
        }

        const newerRequestPending =
          requestedParts !== undefined &&
          !sameRequestedParts(
            requestedParts,
            next.simulationSize,
            next.presentationSize,
            next.probeDensity,
          );
        if (parts && newerRequestPending) {
          destroyParts(ready);
          return;
        }

        const old = parts;
        parts = ready;
        currentSequence = next.sequence;
        resolveWaitersThrough(currentSequence);
        if (old) destroyParts(old);
      })
      .catch((reason: unknown) => {
        rejectWaitersThrough(next.sequence, reason);
      })
      .finally(() => {
        partsPending = undefined;
        buildingParts = undefined;
        maybeStartPartsBuild();
      });
  };

  const resolveWaitersThrough = (sequence: number) => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter && waiter.sequence <= sequence) {
        waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  };

  const rejectWaitersThrough = (sequence: number, reason: unknown) => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter && waiter.sequence <= sequence) {
        waiters.splice(i, 1);
        waiter.reject(reason);
      }
    }
  };

  let heroLightParamsInitialized = false;
  let heroLightParamsTransitionActive = false;
  let heroLightParamsFromBrightnessMax = 0;
  let heroLightParamsTargetBrightnessMax = 0;
  let heroLightParamsVisibleBrightnessMax = 0;
  let heroLightParamsFromLedIntensity = 0;
  let heroLightParamsTargetLedIntensity = 0;
  let heroLightParamsVisibleLedIntensity = 0;

  const updateHeroLightParams = (
    ledTransition: LedTransitionFrame,
    targetLedIntensity: number,
    targetBrightnessMax: number,
  ) => {
    if (!heroLightParamsInitialized) {
      heroLightParamsInitialized = true;
      heroLightParamsTransitionActive = false;
      heroLightParamsFromLedIntensity = targetLedIntensity;
      heroLightParamsTargetLedIntensity = targetLedIntensity;
      heroLightParamsVisibleLedIntensity = targetLedIntensity;
      heroLightParamsFromBrightnessMax = targetBrightnessMax;
      heroLightParamsTargetBrightnessMax = targetBrightnessMax;
      heroLightParamsVisibleBrightnessMax = targetBrightnessMax;
      return;
    }

    if (ledTransition.modeChanged) {
      heroLightParamsFromLedIntensity = heroLightParamsVisibleLedIntensity;
      heroLightParamsTargetLedIntensity = targetLedIntensity;
      heroLightParamsFromBrightnessMax = heroLightParamsVisibleBrightnessMax;
      heroLightParamsTargetBrightnessMax = targetBrightnessMax;
      heroLightParamsTransitionActive = ledTransition.progress < 1;
    } else if (!heroLightParamsTransitionActive) {
      heroLightParamsTargetLedIntensity = targetLedIntensity;
      heroLightParamsVisibleLedIntensity = targetLedIntensity;
      heroLightParamsTargetBrightnessMax = targetBrightnessMax;
      heroLightParamsVisibleBrightnessMax = targetBrightnessMax;
      return;
    }

    if (heroLightParamsTransitionActive) {
      heroLightParamsVisibleLedIntensity = mix(
        heroLightParamsFromLedIntensity,
        heroLightParamsTargetLedIntensity,
        ledTransition.easedProgress,
      );
      heroLightParamsVisibleBrightnessMax = mix(
        heroLightParamsFromBrightnessMax,
        heroLightParamsTargetBrightnessMax,
        ledTransition.easedProgress,
      );
      if (ledTransition.progress >= 1) heroLightParamsTransitionActive = false;
    } else {
      heroLightParamsVisibleLedIntensity = heroLightParamsTargetLedIntensity;
      heroLightParamsVisibleBrightnessMax = heroLightParamsTargetBrightnessMax;
    }
  };

  return {
    get stats() {
      if (!parts)
        return {
          cascadeCount: 0,
          cascadeWidth: 0,
          cascadeHeight: 0,
          probeDensity: PROBE_DENSITY,
          cascadeFit: emptyCascadeFitStats(),
          vramBytes: 0,
        };
      const texels =
        parts.cascade.width *
        parts.cascade.height *
        (parts.builds.length + parts.merges.length + 1);
      return {
        cascadeCount: parts.count,
        cascadeWidth: parts.cascade.width,
        cascadeHeight: parts.cascade.height,
        probeDensity: parts.probeDensity,
        cascadeFit: cascadeFitStats(parts.cascadeFit),
        vramBytes: texels * 8,
      };
    },
    async warmup(width, height, sizing = {}) {
      const presentationSize = normalizedSize(width, height);
      const simulationSize = normalizedSize(
        sizing.simulationWidth ?? width,
        sizing.simulationHeight ?? height,
      );
      const probeDensity = normalizedProbeDensity(sizing.probeDensity);
      await requestParts(simulationSize, presentationSize, probeDensity);
    },
    render(
      target,
      width,
      height,
      patch,
      time,
      tunables,
      bloom,
      sizing,
      options,
      probeDiscard,
    ) {
      const bench = (
        globalThis as {
          __triangleLed4Bench?: {
            samples: number[];
            ignoreSubmitWarningForFrame?: boolean;
          };
        }
      ).__triangleLed4Bench;
      const benchStart = bench ? performance.now() : 0;
      const currentTime = time ?? performance.now() / 1000;
      const presentationSize = normalizedSize(width, height);
      const simulationSize = normalizedSize(
        sizing?.simulationWidth ?? width,
        sizing?.simulationHeight ?? height,
      );
      const probeDensity = normalizedProbeDensity(sizing?.probeDensity);
      const needsParts =
        !parts ||
        !sameSize(parts.presentationSize, presentationSize) ||
        !sameSize(parts.simulationSize, simulationSize) ||
        !sameProbeDensity(parts.probeDensity, probeDensity);
      if (needsParts) {
        if (bench) bench.ignoreSubmitWarningForFrame = true;
        void requestParts(simulationSize, presentationSize, probeDensity, false);
        if (!parts) return;
      }
      const currentParts = parts;
      if (!currentParts) return;
      const brush = {
        ...DEFAULT_BRUSH,
        x: -1000,
        y: -1000,
        active: false,
        ...patch,
      };
      const currentTunables = { ...TUNABLE_DEFAULTS, ...tunables };
      const currentBloom = mergeBloomSettings(bloom);
      const currentHero = mergeHeroStateSettings(options?.hero);
      const currentProbeDiscard = mergeProbeDiscardSettings(probeDiscard);
      const currentLightAo = mergeLightAoSettings(options?.lightAo);
      const currentGodRays = mergeGodRaySettings(options?.godRays);
      const ledTransition = updateLeds(
        device,
        currentParts.leds,
        currentTime,
        currentTunables,
        currentHero,
      );
      updateHeroLightParams(
        ledTransition,
        currentTunables.ledIntensity,
        heroBrightnessMaxForMode(currentHero.mode, currentTunables.brightnessMax),
      );
      currentTunables.ledIntensity = heroLightParamsVisibleLedIntensity;
      currentTunables.brightnessMax = heroLightParamsVisibleBrightnessMax;
      const encoder = device.gpu.createCommandEncoder({
        label: 'triangle-led-4-frame',
      });
      currentParts.lightSources.encode(
        encoder,
        brush,
        currentTime,
        currentTunables,
        options?.renderBlackOccluder ?? true,
      );
      for (const build of currentParts.builds) {
        build.encode(encoder, currentProbeDiscard, currentTunables.ledHitThreshold);
      }
      for (let i = currentParts.count - 1; i >= 0; i--) {
        const merge = currentParts.merges[i];
        if (!merge) throw new Error(`Missing cascade merge pass ${i}`);
        merge.encode(encoder, currentProbeDiscard);
      }
      currentParts.radiance.encode(encoder);
      currentParts.mainScene.encode(encoder, {
        width: currentParts.presentationSize.width,
        height: currentParts.presentationSize.height,
        tunables: currentTunables,
        probeDiscard: currentProbeDiscard,
        theme: options?.theme ?? 'dark',
        lightAo: currentLightAo,
        godRays: currentGodRays,
      });
      currentParts.bloom.encode(encoder, {
        settings: currentBloom,
        probeDiscard: currentProbeDiscard,
        theme: options?.theme ?? 'dark',
        godRays: currentGodRays,
      });
      currentParts.composite.encode(encoder, {
        bloomIntensity: currentBloom.intensity,
        probeDiscard: currentProbeDiscard,
        target,
        width: presentationSize.width,
        height: presentationSize.height,
        theme: options?.theme ?? 'dark',
        godRays: currentGodRays,
      });
      device.queue.gpu.submit([encoder.finish()]);
      if (bench) bench.samples.push(performance.now() - benchStart);
    },
    debugTextures() {
      if (!parts) return undefined;
      return {
        lightSources: parts.lightSources.texture,
        radiance: parts.radiance.texture,
        mainScene: parts.mainScene.texture,
        bloom: parts.bloom.texture,
        bloomPing: parts.bloom.ping,
        simulationSize: parts.simulationSize,
        presentationSize: parts.presentationSize,
      };
    },
    destroy() {
      destroyed = true;
      if (parts) destroyParts(parts);
      parts = undefined;
      requestedParts = undefined;
      rejectWaitersThrough(
        Number.POSITIVE_INFINITY,
        new Error('triangle-led-4 renderer was destroyed'),
      );
    },
  };
}

export const createTriangleLedStripRenderer = createRadianceRenderer;

async function createStaticResources(
  device: Device,
  format: GPUTextureFormat,
): Promise<StaticResources> {
  const linearSampler = device.gpu.createSampler({
    minFilter: 'linear',
    magFilter: 'linear',
  });
  const lightSourcesModule = shaderModule(device, lightSourcesWgsl);
  const cascadeBuildModule = shaderModule(device, cascadeBuildWgsl);
  const cascadeMergeModule = shaderModule(device, cascadeMergeWgsl);
  const radianceModule = shaderModule(device, radianceFieldWgsl);
  const mainSceneFloorModule = shaderModule(device, mainSceneFloorWgsl);
  const mainSceneGodRaysModule = shaderModule(device, mainSceneGodRaysWgsl);
  const mainSceneTriangleModule = shaderModule(device, mainSceneTriangleWgsl);
  const floorNoiseModule = shaderModule(device, floorNoiseWgsl);
  const bloomModule = shaderModule(device, bloomWgsl);
  const compositeModule = shaderModule(device, compositeWgsl);

  const triangleDescriptor: GPURenderPipelineDescriptor = {
    label: 'triangle-led-4-main-scene-triangle',
    layout: 'auto',
    vertex: {
      module: mainSceneTriangleModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        },
      ],
    },
    fragment: {
      module: mainSceneTriangleModule,
      entryPoint: 'fs_main',
      targets: [{ format: MAIN_SCENE_FORMAT }],
    },
    primitive: { topology: 'triangle-list' },
  };

  const godRayDescriptor: GPURenderPipelineDescriptor = {
    label: 'triangle-led-god-rays-main-scene-god-rays',
    layout: 'auto',
    vertex: {
      module: mainSceneGodRaysModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x2' },
            { shaderLocation: 2, offset: 20, format: 'float32x2' },
            { shaderLocation: 3, offset: 28, format: 'float32' },
          ],
        },
      ],
    },
    fragment: {
      module: mainSceneGodRaysModule,
      entryPoint: 'fs_main',
      targets: [
        {
          format: MAIN_SCENE_FORMAT,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  };

  const [
    lightSourcesPipeline,
    cascadeBuildPipeline,
    cascadeMergePipeline,
    radiancePipeline,
    floorPipeline,
    trianglePipeline,
    godRayPipeline,
    floorNoisePipeline,
    bloomPipeline,
    compositePipeline,
  ] = await Promise.all([
    createRenderPipelineAsync(
      device,
      renderPipelineDescriptor(
        'triangle-led-4-light-sources-pass',
        lightSourcesModule,
        LIGHT_SOURCES_FORMAT,
      ),
    ),
    createRenderPipelineAsync(
      device,
      renderPipelineDescriptor(
        'triangle-led-4-cascade-build-shared',
        cascadeBuildModule,
        CASCADE_FORMAT,
      ),
    ),
    createRenderPipelineAsync(
      device,
      renderPipelineDescriptor(
        'triangle-led-4-cascade-merge-shared',
        cascadeMergeModule,
        CASCADE_FORMAT,
      ),
    ),
    createRenderPipelineAsync(
      device,
      renderPipelineDescriptor(
        'triangle-led-4-radiance-field',
        radianceModule,
        CASCADE_FORMAT,
      ),
    ),
    createRenderPipelineAsync(
      device,
      renderPipelineDescriptor(
        'triangle-led-4-main-scene-floor',
        mainSceneFloorModule,
        MAIN_SCENE_FORMAT,
      ),
    ),
    createRenderPipelineAsync(device, triangleDescriptor),
    createRenderPipelineAsync(device, godRayDescriptor),
    createRenderPipelineAsync(
      device,
      renderPipelineDescriptor(
        'triangle-led-4-floor-noise',
        floorNoiseModule,
        'rgba8unorm',
      ),
    ),
    createRenderPipelineAsync(
      device,
      renderPipelineDescriptor(
        'triangle-led-4-bloom',
        bloomModule,
        BLOOM_FORMAT,
      ),
    ),
    createRenderPipelineAsync(
      device,
      renderPipelineDescriptor(
        'triangle-led-4-final-compose',
        compositeModule,
        format,
      ),
    ),
  ]);

  return {
    lightSources: {
      pipeline: lightSourcesPipeline,
      bindGroupLayout: lightSourcesPipeline.getBindGroupLayout(0),
    },
    cascadeBuild: {
      pipeline: cascadeBuildPipeline,
      bindGroupLayout: cascadeBuildPipeline.getBindGroupLayout(0),
    },
    cascadeMerge: {
      pipeline: cascadeMergePipeline,
      bindGroupLayout: cascadeMergePipeline.getBindGroupLayout(0),
    },
    radiance: {
      pipeline: radiancePipeline,
      bindGroupLayout: radiancePipeline.getBindGroupLayout(0),
    },
    mainScene: {
      floorPipeline,
      floorBindGroupLayout: floorPipeline.getBindGroupLayout(0),
      trianglePipeline,
      triangleBindGroupLayout: trianglePipeline.getBindGroupLayout(0),
      godRayPipeline,
      godRayBindGroupLayout: godRayPipeline.getBindGroupLayout(0),
      floorNoisePipeline,
      linearSampler,
    },
    bloom: {
      pipeline: bloomPipeline,
      bindGroupLayout: bloomPipeline.getBindGroupLayout(0),
      linearSampler,
    },
    composite: {
      pipeline: compositePipeline,
      bindGroupLayout: compositePipeline.getBindGroupLayout(0),
      linearSampler,
      format,
    },
  };
}

function createParts(
  device: Device,
  staticResources: StaticResources,
  simulationSize: RenderSize,
  presentationSize: RenderSize,
  probeDensity: number,
): Parts {
  const cascadeFit = cascadeFitRect(simulationSize, probeDensity);
  const cascade: RenderSize = {
    width: cascadeFit.width,
    height: cascadeFit.height,
  };
  const count = cascadeCount(simulationSize);
  const leds = createLedBuffer(device, simulationSize);
  const lightSources = createLightSourcesPass(
    device,
    staticResources.lightSources,
    simulationSize,
    leds.buffer,
  );
  const builds = Array.from({ length: count }, (_, i) =>
    createCascadeBuildPass(
      device,
      staticResources.cascadeBuild,
      i,
      count,
      simulationSize,
      cascade,
      cascadeFit,
      lightSources.view,
    ),
  );
  const merges = Array.from({ length: count }, (_, i) => {
    const build = builds[i];
    if (!build) throw new Error(`Missing cascade build pass ${i}`);
    return createCascadeMergePass(
      device,
      staticResources.cascadeMerge,
      i,
      count,
      simulationSize,
      cascade,
      cascadeFit,
      build.view,
    );
  });
  const black = device.createTexture({
    size: [cascade.width, cascade.height],
    format: CASCADE_FORMAT,
    usage: ['render_attachment', 'texture_binding'],
    label: 'triangle-led-4-black-next-cascade',
  });
  const blackView = black.createView();
  for (let i = 0; i < count; i++) {
    const merge = merges[i];
    const nextMerge = merges[i + 1];
    if (!merge) throw new Error(`Missing cascade merge pass ${i}`);
    merge.bindNext(
      i === count - 1 ? blackView : (nextMerge?.view ?? blackView),
    );
  }
  const firstMerge = merges[0];
  if (!firstMerge) throw new Error('Missing first cascade merge pass');
  const radiance = createRadianceFieldPass(
    device,
    staticResources.radiance,
    cascade,
    firstMerge.view,
  );
  const mainScene = createMainScenePass(
    device,
    staticResources.mainScene,
    simulationSize,
    presentationSize,
    cascadeFit,
    radiance.view,
    lightSources.view,
  );
  const bloom = createBloomPass(
    device,
    staticResources.bloom,
    simulationSize,
    mainScene.view,
  );
  const composite = createCompositePass(
    device,
    staticResources.composite,
    mainScene.view,
    bloom.view,
  );
  return {
    simulationSize,
    presentationSize,
    probeDensity,
    cascadeFit,
    cascade,
    leds,
    lightSources,
    builds,
    merges,
    black,
    blackView,
    radiance,
    mainScene,
    bloom,
    composite,
    count,
  };
}

function destroyParts(parts: Parts) {
  parts.lightSources.destroy();
  for (const build of parts.builds) build.destroy();
  for (const merge of parts.merges) merge.destroy();
  parts.radiance.destroy();
  parts.mainScene.destroy();
  parts.bloom.destroy();
  parts.composite.destroy();
  parts.leds.buffer.gpu.destroy();
  parts.black.gpu.destroy();
}

function emptyCascadeFitStats(): CascadeFitStats {
  return {
    enabled: true,
    originX: 0,
    originY: 0,
    width: 0,
    height: 0,
    fullWidth: 0,
    fullHeight: 0,
    originSceneX: 0,
    originSceneY: 0,
    widthScene: 0,
    heightScene: 0,
    areaRatio: 0,
    alignment: 0,
  };
}

function cascadeFitStats(fit: CascadeFitRect): CascadeFitStats {
  return {
    enabled: true,
    originX: fit.originX,
    originY: fit.originY,
    width: fit.width,
    height: fit.height,
    fullWidth: fit.fullWidth,
    fullHeight: fit.fullHeight,
    originSceneX: fit.originSceneX,
    originSceneY: fit.originSceneY,
    widthScene: fit.widthScene,
    heightScene: fit.heightScene,
    areaRatio: fit.areaRatio,
    alignment: fit.alignment,
  };
}

function heroBrightnessMaxForMode(
  mode: HeroStateMode,
  baseBrightnessMax: number,
) {
  if (mode === HERO_STATE_MODES.scan) return 1;
  if (mode === HERO_STATE_MODES.pulse) return 0.5;
  return baseBrightnessMax;
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function normalizedSize(width: number, height: number): RenderSize {
  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  };
}

function normalizedProbeDensity(probeDensity = PROBE_DENSITY) {
  if (!Number.isFinite(probeDensity)) return PROBE_DENSITY;
  return Math.min(
    PROBE_DENSITY_MAX,
    Math.max(PROBE_DENSITY_MIN, probeDensity),
  );
}

function sameSize(a: RenderSize, b: RenderSize) {
  return a.width === b.width && a.height === b.height;
}

function sameProbeDensity(a: number, b: number) {
  return Object.is(a, b);
}

function sameRequestedParts(
  requested: RequestedParts,
  simulationSize: RenderSize,
  presentationSize: RenderSize,
  probeDensity: number,
) {
  return (
    sameSize(requested.simulationSize, simulationSize) &&
    sameSize(requested.presentationSize, presentationSize) &&
    sameProbeDensity(requested.probeDensity, probeDensity)
  );
}
