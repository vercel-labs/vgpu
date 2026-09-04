import {
  clock as createClock,
  compute as createCompute,
  draw as createDraw,
  effect as createEffect,
  frame as createFrame,
  frameLoop,
  pingPong,
  sampler as createSampler,
  storage as createStorage,
  surface as createSurface,
  target as createTarget,
  texture as createTexture,
  uniforms as createUniforms,
  type Compute,
  type Draw,
  type Effect,
  type Frame,
  type Gpu,
  type PingPongTargets,
  type SharedUniforms,
  type StorageBuffer,
  type Surface,
  type Target,
  type Texture,
} from 'vgpu';
import { cameraUniforms, sunDirection, terrainSector, type CameraUniformValues } from './camera';
import { ATMOSPHERE_PHYSICS, CLOUD_TUNING, DEFAULT_PRESET, LUT_SIZES, PRESETS, TONEMAPS, type AtmosphereState } from './tuning';
import transmittanceLutWgsl from './transmittance-lut.wgsl';
import multiScatterLutWgsl from './multiscatter-lut.wgsl';
import skyViewLutWgsl from './sky-view-lut.wgsl';
import aerialLutWgsl from './aerial-lut.wgsl';
import sceneWgsl from './scene.wgsl';
import terrainDepthWgsl from './terrain-depth.wgsl';
import presentWgsl from './present.wgsl';
import lutPreviewWgsl from './lut-preview.wgsl';
import cloudShapeNoiseWgsl from './cloud-shape-noise.wgsl';
import cloudDetailNoiseWgsl from './cloud-detail-noise.wgsl';
import weatherMapWgsl from './weather-map.wgsl';
import cloudsMarchWgsl from './clouds-march.wgsl';
import cloudsResolveWgsl from './clouds-resolve.wgsl';
import terrainHeightmapWgsl from './terrain-heightmap.wgsl';
import curlNoiseWgsl from './curl-noise.wgsl';
import frameConstantsWgsl from './frame-constants.wgsl';
import terrainSunDepthWgsl from './terrain-sun-depth.wgsl';
import cloudShadowWgsl from './cloud-shadow.wgsl';

type Output = Surface | Target;
type Vec3 = readonly [number, number, number];
export type DebugView = 'transmittance' | 'multiscatter' | 'sky-view' | 'weather' | 'terrain';

type AtmosphereUniformValues = {
  rayleighScattering: Vec3; rayleighScaleHeight: number;
  mieScattering: Vec3; mieScaleHeight: number;
  mieAbsorption: Vec3; mieG: number;
  ozoneAbsorption: Vec3; ozoneCenter: number;
  groundAlbedo: Vec3; ozoneWidth: number;
  sunIlluminance: Vec3; groundRadius: number;
  sunDirection: Vec3; atmosphereRadius: number;
}

type CloudUpdateUniformValues = {
  frame: number; valid: number; blend: number; refreshPeriod: number;
  jitter: readonly [number, number]; size: readonly [number, number];
  detail: number; pad0: number; pad1: number; pad2: number;
};

type TerrainMeshUniformValues = { columnOffset: number; columns: number };

/** Column-major 4x4 matrices mapping a position relative to the ground point under the camera axis to each cascade's clip space. */
type SunShadowUniformValues = { toShadow0: readonly number[]; toShadow1: readonly number[]; toShadow2: readonly number[]; fromShadow2: readonly number[]; radii: readonly [number, number, number, number]; bias: readonly [number, number, number, number] };
type CascadeUniformValues = { index: number; pad0: number; pad1: number; pad2: number };

type CloudUniformValues = {
  bottom: number; top: number; coverage: number; density: number;
  shapeScale: number; detailScale: number; weatherScale: number; wind: number;
  detailStrength: number; groundRadius: number; curlStrength: number; detailLodDistance: number;
  typeBias: number; seed: number; shadows: number; pad1: number;
};

export interface AtmosphereGraph {
  readonly atmosphere: SharedUniforms<AtmosphereUniformValues>;
  readonly camera: SharedUniforms<CameraUniformValues>;
  readonly clouds: SharedUniforms<CloudUniformValues>;
  /** Which columns of the terrain ring grid this frame draws. */
  readonly terrainMesh: SharedUniforms<TerrainMeshUniformValues>;
  readonly shapeNoise: Texture;
  readonly detailNoise: Texture;
  readonly weatherMap: Texture;
  readonly curlNoise: Texture;
  readonly terrainMap: Texture;
  readonly terrainAlbedoMap: Texture;
  /** The sun's shadow maps of the terrain: three orthographic depth renders of the whole ring grid (SUN_SHADOW_RADII), rebuilt when the sun moves. */
  readonly sunShadows: readonly Target[];
  readonly sunShadowUniforms: SharedUniforms<SunShadowUniformValues>;
  readonly cascadeUniforms: readonly SharedUniforms<CascadeUniformValues>[];
  /** Column window for the sun pass: every column. */
  readonly sunMesh: SharedUniforms<TerrainMeshUniformValues>;
  readonly shadowSampler: GPUSampler;
  /** Sun transmittance of the cloud layer above each heightmap texel; rebuilt every frame while cloud shadows are on. */
  readonly cloudShadowMap: Texture;
  /** Ping-pong cloud buffers: `write` receives this frame, `read` is last frame's history. */
  readonly cloudsTargets: PingPongTargets;
  /** This frame's live cloud texels, packed (clouds-temporal.wgsl); only a viewport of the compact size is drawn. */
  readonly cloudMarch: Target;
  readonly cloudUpdate: SharedUniforms<CloudUpdateUniformValues>;
  readonly transmittance: Target;
  readonly multiScatter: Texture;
  readonly skyView: Target;
  readonly aerial: Texture;
  /** Aerial in-scatter with no shadow, and its single-scattering part alone: the scene pass shadows that part per pixel. */
  readonly aerialUnshadowed: Texture;
  readonly aerialDirect: Texture;
  /** Depth prepass of the terrain ring grid (reversed-Z, depth32float); its color is a masked-out dummy. */
  readonly terrainDepth: Target;
  readonly scene: Target;
  readonly transmittanceEffect: Effect;
  readonly multiScatterCompute: Compute;
  readonly skyViewEffect: Effect;
  readonly aerialCompute: Compute;
  readonly terrainSunDepthDraws: readonly Draw[];
  readonly cloudShadowCompute: Compute;
  /** Per-frame constants (sky ambient, sun disc trig, horizon terms) baked by a one-thread compute into a storage buffer. */
  readonly frameConstants: StorageBuffer;
  readonly frameConstantsCompute: Compute;
  /** Terrain ring grid, one triangle strip per visible column, depth only. */
  readonly terrainDraw: Draw;
  /** Shades every pixel once: terrain where the prepass left depth, sky and bare sphere elsewhere. */
  readonly sceneEffect: Effect;
  readonly cloudMarchEffect: Effect;
  readonly cloudResolveEffect: Effect;
  readonly presentEffect: Effect;
  readonly lutPreview: Effect;
  readonly sampler: GPUSampler;
  /** stale: medium changed; transmittance: transmittance pass encoded, multi-scatter dispatch pending; ready: both tables valid. */
  lutPhase: 'stale' | 'transmittance' | 'ready';
  bakedHaze: number;
  sunDirection: Vec3;
  cloudShadows: boolean;
  /** Instances of the terrain strip to draw this frame (terrainSector); 0 when the frustum looks above all terrain. */
  terrainColumns: number;
  /** Sun the shadow map was last rendered for; undefined until the first frame. */
  bakedSunDirection?: Vec3;
  frame: number;
  /** Live rendering blends re-marched cloud texels into their jittered history; stills keep it off to stay deterministic. */
  accumulate: boolean;
  /**
   * Frames left of fast cloud refresh: any change of camera or lighting stales the whole history, so the frame
   * re-marches every texel with full blend instead of one in sixteen accumulated. The march is latency-bound, so all
   * texels cost little more than half of them, and with nothing reused a change cannot ghost or blur: a reprojected
   * history was tried first, and it misregistered by pixels along cloud edges under translation and blurred under
   * rotation, since fifteen texels in sixteen were resampled every frame.
   */
  cloudChangeFrames: number;
  /** Frames since the fast refresh last ended: the accumulation weight of a re-marched texel is 1/(refreshes + 1) down to CLOUD_BLEND_FLOOR. */
  cloudRestFrames: number;
  cloudStateKey?: string;
  currentCamera?: CameraUniformValues;
  previousCamera?: CameraUniformValues;
}

/** Frames needed for every cloud texel to be re-marched at least once, at rest and right after a change. */
export const CLOUD_CONVERGENCE_FRAMES = 16;
export const CLOUD_FAST_REFRESH_PERIOD = 1;
/** Smallest weight of a re-marched texel against its history at rest; keeps the slow wind advection from lagging. */
const CLOUD_BLEND_FLOOR = 0.1;

export interface ThumbOptions {
  time?: number;
  onVariantRendered?: (variant: 'noon', pixels: Uint8Array, size: readonly [number, number]) => void | Promise<void>;
}

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const MAX_DPR = 1;
const MAX_FPS = 60;
const CLEAR = [0, 0, 0, 1] as const;
const AERIAL_WORKGROUP = 4;
const NOISE_WORKGROUP = 4;
const WEATHER_WORKGROUP = 8;
/** Keep in sync with TERRAIN_MAP_SIZE in terrain.wgsl. */
const TERRAIN_MAP_SIZE = 2048;
const SUN_SHADOW_MAP_SIZE = 2048;
/** Each cascade covers a disc of this radius (km) around the camera axis, from the ground up to SUN_SHADOW_HEIGHT (km). */
const SUN_SHADOW_RADII = [6, 30, 130] as const;
const SUN_SHADOW_HEIGHT = 6;
/** Keep in sync with CLOUD_SHADOW_MAP_SIZE in clouds-common.wgsl. */
const CLOUD_SHADOW_MAP_SIZE = 512;
/** Keep in sync with TERRAIN_MESH_COLUMNS and TERRAIN_MESH_RINGS in terrain.wgsl. */
const TERRAIN_MESH_COLUMNS = 4096;
const TERRAIN_MESH_RINGS = 512;
/** Keep in sync with SIZE in curl-noise.wgsl. */
const CURL_SIZE = 128;
/** Size of FrameConstants in atmosphere-common.wgsl: four 16-byte rows plus the 64-entry terrain transmittance table. */
const FRAME_CONSTANTS_BYTES = 64 + 64 * 16;

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const { installControls } = await import('./controls');
  // `?bench` in the URL times the passes of a frame on this GPU (bench.ts) before the live loop starts.
  const bench = typeof location !== 'undefined' && new URLSearchParams(location.search).has('bench') ? await import('./bench') : undefined;
  const gpu = await init();
  // Device pixels and frame rate are capped: the frame cost is linear in pixels and this is a laptop demo.
  const surface = createSurface(gpu, canvas, { dpr: MAX_DPR });
  const graph = await createGraph(gpu, surface, 'atmosphere-live');
  graph.accumulate = true;
  if (bench) await bench.mountBenchReport(canvas, await bench.runBench(gpu, [canvas.clientWidth, canvas.clientHeight]));
  const controls = installControls(canvas, { ...PRESETS[DEFAULT_PRESET] });
  let disposed = false;
  let sawInitialResize = false;
  const unsubscribeResize = surface.onResize(() => {
    if (!sawInitialResize) { sawInitialResize = true; return; }
    if (disposed) return;
    resizeGraph(graph, surface.size);
  });
  const timeline = createClock(gpu);
  let fpsWindowStart = performance.now();
  let fpsWindowFrames = 0;
  const loop = frameLoop(gpu, (frame) => {
    const state = { ...controls.getState(), time: timeline.time };
    applyState(graph, state, surface.size);
    renderGraph(frame, graph, surface);
    // Frame rate over half-second windows, so the cap and the cost of a change are visible in the panel.
    fpsWindowFrames += 1;
    const elapsed = performance.now() - fpsWindowStart;
    if (elapsed >= 500) {
      controls.setFps(fpsWindowFrames * 1000 / elapsed);
      fpsWindowStart += elapsed;
      fpsWindowFrames = 0;
    }
  }, { fps: MAX_FPS });
  return () => {
    if (disposed) return;
    disposed = true;
    loop.stop();
    unsubscribeResize();
    controls.dispose();
    destroyGraph(graph);
    surface.dispose();
    gpu.dispose();
  };
}

type RendererRun = (canvas: HTMLCanvasElement) => Promise<() => void>;

/**
 * A canvas context is shared even when separate vgpu instances configure it.
 * Keep each renderer's complete lifetime serialized so a late Strict Mode
 * cleanup cannot unconfigure the context owned by the replacement renderer.
 */
const canvasRendererLifetimes = new WeakMap<HTMLCanvasElement, Promise<void>>();

export function createRenderer(
  { canvas }: { readonly canvas: HTMLCanvasElement },
  start: RendererRun = run,
) {
  let cleanup: (() => void) | undefined;
  let disposed = false;
  let released = false;
  let releaseLifetime!: () => void;

  const previousLifetime = canvasRendererLifetimes.get(canvas) ?? Promise.resolve();
  const lifetime = new Promise<void>((resolve) => {
    releaseLifetime = resolve;
  });
  const queuedLifetime = previousLifetime.catch(() => undefined).then(() => lifetime);
  canvasRendererLifetimes.set(canvas, queuedLifetime);

  const release = () => {
    if (released) return;
    released = true;
    releaseLifetime();
    if (canvasRendererLifetimes.get(canvas) === queuedLifetime) {
      canvasRendererLifetimes.delete(canvas);
    }
  };

  const ready = previousLifetime
    .catch(() => undefined)
    .then(async () => {
      if (disposed) {
        release();
        return;
      }

      const nextCleanup = await start(canvas);
      if (disposed) {
        try {
          nextCleanup();
        } finally {
          release();
        }
      } else {
        cleanup = nextCleanup;
      }
    })
    .catch((error: unknown) => {
      release();
      if (!disposed) throw error;
    });

  return {
    ready,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (!cleanup) return;
      const disposeRenderer = cleanup;
      cleanup = undefined;
      try {
        disposeRenderer();
      } finally {
        release();
      }
    },
  };
}

/** Docs thumbnail: golden hour, plus a noon variant so the thumbnail check can compare sky colour. */
export async function renderThumb(gpu: Gpu, output: Target, opts: ThumbOptions = {}): Promise<void> {
  const graph = await createGraph(gpu, output, 'atmosphere-thumb');
  renderState(gpu, graph, output, PRESETS.noon);
  await gpu.gpu.queue.onSubmittedWorkDone();
  await opts.onVariantRendered?.('noon', await output.read(), output.size);
  renderState(gpu, graph, output, PRESETS[DEFAULT_PRESET]);
  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
  destroyGraph(graph);
}

/** Headless still for scripts: one state, one target, optional LUT debug view instead of the scene. */
export async function renderStill(gpu: Gpu, output: Target, state: AtmosphereState, debug?: DebugView): Promise<void> {
  const graph = await createGraph(gpu, output, 'atmosphere-still');
  if (debug) {
    applyState(graph, state, output.size);
    bakeLuts(gpu, graph);
    createFrame(gpu, (frame) => encodeSkyView(frame, graph));
    const sources = { transmittance: graph.transmittance, multiscatter: graph.multiScatter, weather: graph.weatherMap, terrain: graph.terrainMap, 'sky-view': graph.skyView } as const;
    const gains = { transmittance: 1, multiscatter: 1, weather: 1, terrain: 0.3, 'sky-view': 2 ** state.exposureEv } as const;
    graph.lutPreview.set({ preview: { gain: gains[debug], channel: 0, pad: [0, 0] }, lut: sources[debug], linearSampler: graph.sampler });
    await graph.lutPreview.compile(output);
    createFrame(gpu, (frame) => frame.pass({ target: output, clear: CLEAR }, (pass) => pass.draw(graph.lutPreview)));
  } else {
    renderState(gpu, graph, output, state);
  }
  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
  destroyGraph(graph);
}

export async function createGraph(gpu: Gpu, output: Output, label: string): Promise<AtmosphereGraph> {
  const sampler = createSampler(gpu, { minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
  const atmosphere = createUniforms<AtmosphereUniformValues>(gpu, { ...ATMOSPHERE_PHYSICS, sunDirection: [0, 1, 0] });
  const camera = createUniforms<CameraUniformValues>(gpu, cameraUniforms(PRESETS[DEFAULT_PRESET], output.size));
  const clouds = createUniforms<CloudUniformValues>(gpu, cloudUniforms(PRESETS[DEFAULT_PRESET]));
  const terrainMesh = createUniforms<TerrainMeshUniformValues>(gpu, { columnOffset: 0, columns: 0 });
  const noiseSampler = createSampler(gpu, { minFilter: 'linear', magFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
  const transmittance = createTarget(gpu, { size: LUT_SIZES.transmittance, format: HDR_FORMAT, label: `${label}-transmittance` });
  const multiScatter = createTexture(gpu, { size: [LUT_SIZES.multiScatter, LUT_SIZES.multiScatter], format: HDR_FORMAT, label: `${label}-multiscatter` });
  const skyView = createTarget(gpu, { size: LUT_SIZES.skyView, format: HDR_FORMAT, label: `${label}-sky-view` });
  const aerial = createTexture(gpu, { size: LUT_SIZES.aerial, format: HDR_FORMAT, dimension: '3d', label: `${label}-aerial` });
  const aerialUnshadowed = createTexture(gpu, { size: LUT_SIZES.aerial, format: HDR_FORMAT, dimension: '3d', label: `${label}-aerial-unshadowed` });
  const aerialDirect = createTexture(gpu, { size: LUT_SIZES.aerial, format: HDR_FORMAT, dimension: '3d', label: `${label}-aerial-direct` });
  const terrainDepth = createTarget(gpu, { size: output.size, format: 'r8unorm', depth: 'depth32float', label: `${label}-terrain-depth` });
  const scene = createTarget(gpu, { size: output.size, format: HDR_FORMAT, label: `${label}-scene` });
  const cloudSize = cloudSizeFor(output.size);
  const cloudsTargets = pingPong(gpu, cloudSize[0], cloudSize[1], { format: HDR_FORMAT, label: `${label}-clouds` });
  const cloudMarch = createTarget(gpu, { size: cloudSize, format: HDR_FORMAT, label: `${label}-cloud-march` });
  const cloudUpdate = createUniforms<CloudUpdateUniformValues>(gpu, cloudUpdateUniforms({ valid: false, frame: 0, accumulate: false, fast: false, restFrames: 0, size: cloudSize }));
  const noise = CLOUD_TUNING.noise;
  const shapeNoise = createTexture(gpu, { size: [noise.shape, noise.shape, noise.shape], format: 'rgba8unorm', dimension: '3d', label: `${label}-cloud-shape` });
  const detailNoise = createTexture(gpu, { size: [noise.detail, noise.detail, noise.detail], format: 'rgba8unorm', dimension: '3d', label: `${label}-cloud-detail` });
  const weatherMap = createTexture(gpu, { size: [noise.weather, noise.weather], format: 'rgba8unorm', label: `${label}-weather` });
  const terrainMap = createTexture(gpu, { size: [TERRAIN_MAP_SIZE, TERRAIN_MAP_SIZE], format: HDR_FORMAT, label: `${label}-terrain` });
  const terrainAlbedoMap = createTexture(gpu, { size: [TERRAIN_MAP_SIZE, TERRAIN_MAP_SIZE], format: 'rgba8unorm', label: `${label}-terrain-albedo` });
  const sunShadows = SUN_SHADOW_RADII.map((_, index) => createTarget(gpu, { size: [SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE], format: 'r8unorm', depth: 'depth32float', label: `${label}-sun-shadow-${index}` }));
  const sunShadowUniforms = createUniforms<SunShadowUniformValues>(gpu, sunShadowUniformValues(sunDirection(PRESETS[DEFAULT_PRESET])));
  const cascadeUniforms = SUN_SHADOW_RADII.map((_, index) => createUniforms<CascadeUniformValues>(gpu, { index, pad0: 0, pad1: 0, pad2: 0 }));
  const sunMesh = createUniforms<TerrainMeshUniformValues>(gpu, { columnOffset: 0, columns: TERRAIN_MESH_COLUMNS });
  // Linear comparison sampler: the hardware compares the four neighbours and blends the results, a first level of penumbra.
  const shadowSampler = createSampler(gpu, { compare: 'less-equal', minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const cloudShadowMap = createTexture(gpu, { size: [CLOUD_SHADOW_MAP_SIZE, CLOUD_SHADOW_MAP_SIZE], format: HDR_FORMAT, label: `${label}-cloud-shadow` });
  const curlNoise = createTexture(gpu, { size: [CURL_SIZE, CURL_SIZE], format: 'rgba8unorm', label: `${label}-curl` });

  const transmittanceEffect = createEffect(gpu, transmittanceLutWgsl, { label: `${label}-transmittance`, set: { atmosphere } });
  const multiScatterCompute = createCompute(gpu, multiScatterLutWgsl, { label: `${label}-multiscatter`, set: { atmosphere, transmittanceLut: transmittance, lutSampler: sampler, multiScatterLut: multiScatter } });
  const skyViewEffect = createEffect(gpu, skyViewLutWgsl, { label: `${label}-sky-view`, set: { atmosphere, camera, transmittanceLut: transmittance, multiScatterLut: multiScatter, lutSampler: sampler } });
  const aerialCompute = createCompute(gpu, aerialLutWgsl, { label: `${label}-aerial`, set: { atmosphere, camera, transmittanceLut: transmittance, multiScatterLut: multiScatter, lutSampler: sampler, aerialLut: aerial, sunShadowMap0: sunShadows[0]!, sunShadowMap1: sunShadows[1]!, sunShadowMap2: sunShadows[2]!, aerialUnshadowedLut: aerialUnshadowed, aerialDirectLut: aerialDirect, clouds, cloudShadowMap, shadowSampler, sunShadow: sunShadowUniforms } });
  const cloudShadowCompute = createCompute(gpu, cloudShadowWgsl, { label: `${label}-cloud-shadow`, set: { atmosphere, clouds, shapeNoise, detailNoise, weatherMap, curlNoise, noiseSampler, cloudShadowMap, sunShadow: sunShadowUniforms } });
  const frameConstants = createStorage(gpu, FRAME_CONSTANTS_BYTES, 'read-write');
  const frameConstantsCompute = createCompute(gpu, frameConstantsWgsl, { label: `${label}-frame-constants`, set: { atmosphere, camera, transmittanceLut: transmittance, skyViewLut: skyView.color, lutSampler: sampler, frameConstants, terrainMap } });
  const terrainSunDepthDraws = cascadeUniforms.map((cascade, index) => createDraw(gpu, {
    shader: terrainSunDepthWgsl,
    label: `${label}-terrain-sun-depth-${index}`,
    geometry: { topology: 'triangle-strip', vertexCount: 2 * (TERRAIN_MESH_RINGS + 1) },
    depth: { compare: 'less' },
    writeMask: [],
    set: { atmosphere, mesh: sunMesh, terrainMap, lutSampler: sampler, sunShadow: sunShadowUniforms, cascade },
  }));
  const terrainDraw = createDraw(gpu, {
    shader: terrainDepthWgsl,
    label: `${label}-terrain-depth`,
    geometry: { topology: 'triangle-strip', vertexCount: 2 * (TERRAIN_MESH_RINGS + 1) },
    depth: { compare: 'greater' },
    writeMask: [],
    set: { atmosphere, camera, mesh: terrainMesh, terrainMap, lutSampler: sampler },
  });
  const sceneEffect = createEffect(gpu, sceneWgsl, { label: `${label}-scene`, set: { atmosphere, camera, transmittanceLut: transmittance, skyViewLut: skyView, aerialLut: aerial, lutSampler: sampler, clouds, terrainMap, terrainAlbedoMap, frame: frameConstants, aerialUnshadowedLut: aerialUnshadowed, aerialDirectLut: aerialDirect, terrainDepth: terrainDepth.depth!, cloudShadowMap, sunShadowMap0: sunShadows[0]!, sunShadowMap1: sunShadows[1]!, sunShadowMap2: sunShadows[2]!, shadowSampler, sunShadow: sunShadowUniforms } });
  const cloudMarchEffect = createEffect(gpu, cloudsMarchWgsl, { label: `${label}-cloud-march`, set: {
    atmosphere, camera, clouds, transmittanceLut: transmittance, aerialLut: aerial, shapeNoise, detailNoise, weatherMap, curlNoise, sceneHdr: scene,
    lutSampler: sampler, noiseSampler, update: cloudUpdate, frame: frameConstants,
  } });
  const cloudResolveEffect = createEffect(gpu, cloudsResolveWgsl, { label: `${label}-cloud-resolve`, set: { marchColor: cloudMarch, history: cloudsTargets.read, lutSampler: sampler, update: cloudUpdate } });
  const presentEffect = createEffect(gpu, presentWgsl, { label: `${label}-present`, set: { present: { exposure: 1, tonemap: 0, dither: 1, pad: 0 }, sceneHdr: scene, cloudsHdr: cloudsTargets.write, linearSampler: sampler } });
  // Cloud noise and weather are static: generate them once with compute into storage textures.
  createCompute(gpu, cloudShapeNoiseWgsl, { label: `${label}-cloud-shape-noise`, set: { shapeNoise } }).dispatch(noise.shape / NOISE_WORKGROUP, noise.shape / NOISE_WORKGROUP, noise.shape / NOISE_WORKGROUP);
  createCompute(gpu, cloudDetailNoiseWgsl, { label: `${label}-cloud-detail-noise`, set: { detailNoise } }).dispatch(noise.detail / NOISE_WORKGROUP, noise.detail / NOISE_WORKGROUP, noise.detail / NOISE_WORKGROUP);
  createCompute(gpu, weatherMapWgsl, { label: `${label}-weather-map`, set: { weatherMap } }).dispatch(noise.weather / WEATHER_WORKGROUP, noise.weather / WEATHER_WORKGROUP, 1);
  createCompute(gpu, curlNoiseWgsl, { label: `${label}-curl-noise`, set: { curlNoise } }).dispatch(CURL_SIZE / WEATHER_WORKGROUP, CURL_SIZE / WEATHER_WORKGROUP, 1);
  // The heightfield is baked once too: the terrain march then costs one texture tap per step instead of a 6-octave fbm.
  createCompute(gpu, terrainHeightmapWgsl, { label: `${label}-terrain-heightmap`, set: { terrainMap, albedoMap: terrainAlbedoMap } }).dispatch(TERRAIN_MAP_SIZE / WEATHER_WORKGROUP, TERRAIN_MAP_SIZE / WEATHER_WORKGROUP, 1);
  const lutPreview = createEffect(gpu, lutPreviewWgsl, { label: `${label}-lut-preview` });

  const graph: AtmosphereGraph = {
    atmosphere, camera, clouds, terrainMesh, shapeNoise, detailNoise, weatherMap, curlNoise, terrainMap, terrainAlbedoMap, sunShadows, sunShadowUniforms, cascadeUniforms, sunMesh, shadowSampler, cloudShadowMap, cloudsTargets, cloudMarch, cloudUpdate, transmittance, multiScatter, skyView, aerial, aerialUnshadowed, aerialDirect, terrainDepth, scene,
    transmittanceEffect, multiScatterCompute, skyViewEffect, aerialCompute, terrainSunDepthDraws, cloudShadowCompute, frameConstants, frameConstantsCompute, terrainDraw, sceneEffect, cloudMarchEffect, cloudResolveEffect, presentEffect, lutPreview, sampler,
    lutPhase: 'stale', bakedHaze: 1, frame: 0, accumulate: false, cloudChangeFrames: CLOUD_FAST_REFRESH_PERIOD, cloudRestFrames: 0, sunDirection: sunDirection(PRESETS[DEFAULT_PRESET]), cloudShadows: true, terrainColumns: 0,
  };
  await Promise.all([
    transmittanceEffect.compile(transmittance),
    skyViewEffect.compile(skyView),
    terrainDraw.compile(terrainDepth),
    ...terrainSunDepthDraws.map((draw, index) => draw.compile(sunShadows[index]!)),
    sceneEffect.compile(scene),
    cloudMarchEffect.compile(cloudMarch),
    cloudResolveEffect.compile(cloudsTargets.write),
    presentEffect.compile({ colors: [output.format] }),
  ]);
  return graph;
}

/** Transmittance and multi-scattering only depend on the medium: bake both up front outside a frame loop. */
export function bakeLuts(gpu: Gpu, graph: AtmosphereGraph): void {
  createFrame(gpu, (frame) => encodeTransmittance(frame, graph));
  dispatchMultiScatter(graph);
}

function encodeTransmittance(frame: Frame, graph: AtmosphereGraph): void {
  frame.pass({ target: graph.transmittance, clear: CLEAR }, (pass) => pass.draw(graph.transmittanceEffect));
  graph.lutPhase = 'transmittance';
}

/** Reads the transmittance table, so it must run after the frame that encoded it has been submitted. */
function dispatchMultiScatter(graph: AtmosphereGraph): void {
  graph.multiScatterCompute.dispatch(LUT_SIZES.multiScatter, LUT_SIZES.multiScatter, 1);
  graph.lutPhase = 'ready';
}

export function applyState(graph: AtmosphereGraph, state: AtmosphereState, size: readonly [number, number]): void {
  const haze = Math.max(0.01, state.haze);
  graph.sunDirection = sunDirection(state);
  graph.atmosphere.set({
    sunDirection: graph.sunDirection,
    mieScattering: scale(ATMOSPHERE_PHYSICS.mieScattering, haze),
    mieAbsorption: scale(ATMOSPHERE_PHYSICS.mieAbsorption, haze),
  });
  graph.currentCamera = cameraUniforms(state, size);
  graph.camera.set(graph.currentCamera);
  graph.clouds.set(cloudUniforms(state));
  graph.cloudShadows = state.cloudShadows && state.cloudCoverage > 0;
  const sector = terrainSector(graph.currentCamera, TERRAIN_MESH_COLUMNS);
  graph.terrainMesh.set({ columnOffset: sector.first, columns: sector.count });
  graph.terrainColumns = sector.count;
  graph.presentEffect.set({ present: { exposure: 2 ** state.exposureEv, tonemap: TONEMAPS.indexOf(state.tonemap), dither: 1, pad: 0 } });
  // The medium changed, so the baked transmittance and multi-scattering tables are stale.
  if (graph.bakedHaze !== haze) graph.lutPhase = 'stale';
  graph.bakedHaze = haze;
  // Any change of camera or lighting stales the cloud history; only the wind, which moves metres per second, does not.
  const cloudStateKey = [state.sunElevation, state.sunAzimuth, state.altitudeKm, state.yaw, state.pitch, haze, state.cloudCoverage, state.cloudDetail, state.cloudType, state.cloudSeed].join(',');
  if (graph.cloudStateKey !== undefined && graph.cloudStateKey !== cloudStateKey) {
    graph.cloudChangeFrames = CLOUD_FAST_REFRESH_PERIOD;
    graph.cloudRestFrames = 0;
  }
  graph.cloudStateKey = cloudStateKey;
}

/**
 * Per-frame work: compute dispatches submit immediately, so they run before this frame's passes.
 * A stale medium re-encodes transmittance in this frame and dispatches multi-scatter on the next one.
 * Each pass is its own function so bench.ts can time them one at a time.
 */
export function renderGraph(frame: Frame, graph: AtmosphereGraph, output: Output): void {
  if (graph.lutPhase === 'transmittance') dispatchMultiScatter(graph);
  // The sun frame is refreshed before the computes that lay their maps out in it; the shadow render itself comes later.
  if (!sameDirection(graph.bakedSunDirection, graph.sunDirection)) graph.sunShadowUniforms.set(sunShadowUniformValues(graph.sunDirection));
  encodeCloudShadow(graph);
  encodeAerial(graph);
  encodeFrameConstants(graph);
  if (graph.lutPhase === 'stale') encodeTransmittance(frame, graph);
  encodeSunShadow(frame, graph);
  encodeSkyView(frame, graph);
  encodeScene(frame, graph);
  encodeClouds(frame, graph);
  encodePresent(frame, graph, output);
  finishFrame(graph);
}

/**
 * The sun's shadow map depends only on the sun (the heightmap is static): re-rendered when the sun moves. It is a render
 * pass, so this frame's compute dispatches (the aerial LUT) read last frame's map, a frame late while the sun drags.
 */
export function encodeSunShadow(frame: Frame, graph: AtmosphereGraph): void {
  if (sameDirection(graph.bakedSunDirection, graph.sunDirection)) return;
  graph.sunShadowUniforms.set(sunShadowUniformValues(graph.sunDirection));
  graph.sunShadows.forEach((target, index) => {
    frame.pass({ target, clear: [0, 0, 0, 0], clearDepth: 1 }, (pass) => {
      if (graph.sunDirection[1] > 0) pass.draw(graph.terrainSunDepthDraws[index]!, { instances: TERRAIN_MESH_COLUMNS });
    });
  });
  graph.bakedSunDirection = graph.sunDirection;
}

/**
 * Orthographic frames looking along the sun, one per cascade: x across the sun's horizontal, y along its vertical
 * companion, z along the light (nearest to the sun first). Each window is sized to a cylinder of the cascade's
 * radius around the camera axis and SUN_SHADOW_HEIGHT tall; the depth range of every cascade reaches back to the
 * whole terrain toward the sun, since a far peak shadows the near disc along the light just the same.
 */
function sunShadowUniformValues(sun: Vec3): SunShadowUniformValues {
  let right = cross([0, 1, 0], sun);
  if (Math.hypot(...right) < 1e-4) right = [1, 0, 0];
  right = normalize(right);
  const up = cross(sun, right);
  const light: Vec3 = [-sun[0], -sun[1], -sun[2]];
  const sinE = Math.max(sun[1], 0);
  const cosE = Math.sqrt(Math.max(1 - sinE * sinE, 0));
  const farthest = SUN_SHADOW_RADII[SUN_SHADOW_RADII.length - 1]!;
  const zNear = -farthest * cosE - SUN_SHADOW_HEIGHT * sinE;
  const matrices = SUN_SHADOW_RADII.map((radius) => {
    const yMin = -radius * sinE;
    const yMax = radius * sinE + SUN_SHADOW_HEIGHT * cosE;
    const yCenter = 0.5 * (yMin + yMax);
    const yHalf = Math.max(0.5 * (yMax - yMin), 1e-3);
    const zFar = radius * cosE + SUN_SHADOW_HEIGHT;
    const zRange = zFar - zNear;
    // Rows of the mapping; WGSL wants columns.
    const rows = [
      [right[0] / radius, right[1] / radius, right[2] / radius, 0],
      [up[0] / yHalf, up[1] / yHalf, up[2] / yHalf, -yCenter / yHalf],
      [light[0] / zRange, light[1] / zRange, light[2] / zRange, -zNear / zRange],
      [0, 0, 0, 1],
    ];
    const matrix: number[] = [];
    for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) matrix.push(rows[row]![column]!);
    // The inverse, clip space back to a position: columns are the frame's axes scaled by the window, plus its origin.
    const inverse = [
      right[0] * radius, right[1] * radius, right[2] * radius, 0,
      up[0] * yHalf, up[1] * yHalf, up[2] * yHalf, 0,
      light[0] * zRange, light[1] * zRange, light[2] * zRange, 0,
      up[0] * yCenter + light[0] * zNear, up[1] * yCenter + light[1] * zNear, up[2] * yCenter + light[2] * zNear, 1,
    ];
    // Two texels of this cascade's ground footprint, in its depth units, so a slope one texel wide does not shadow itself.
    const bias = (2 * (2 * radius) / SUN_SHADOW_MAP_SIZE) / zRange;
    return { matrix, inverse, bias };
  });
  return {
    toShadow0: matrices[0]!.matrix, toShadow1: matrices[1]!.matrix, toShadow2: matrices[2]!.matrix, fromShadow2: matrices[2]!.inverse,
    radii: [SUN_SHADOW_RADII[0], SUN_SHADOW_RADII[1], SUN_SHADOW_RADII[2], 0],
    bias: [matrices[0]!.bias, matrices[1]!.bias, matrices[2]!.bias, 0],
  };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** The cloud shadow map follows the wind and the sun, so it is rebuilt every frame the clouds cast shadows at all. */
export function encodeCloudShadow(graph: AtmosphereGraph): void {
  if (!graph.cloudShadows) return;
  const groups = CLOUD_SHADOW_MAP_SIZE / WEATHER_WORKGROUP;
  graph.cloudShadowCompute.dispatch(groups, groups, 1);
}

export function encodeAerial(graph: AtmosphereGraph): void {
  graph.aerialCompute.dispatch(LUT_SIZES.aerial[0] / AERIAL_WORKGROUP, LUT_SIZES.aerial[1] / AERIAL_WORKGROUP, LUT_SIZES.aerial[2] / AERIAL_WORKGROUP);
}

/** Reads the sky-view LUT of the previous frame; stills pre-render one sky-view pass so it is already current. */
export function encodeFrameConstants(graph: AtmosphereGraph): void {
  graph.frameConstantsCompute.dispatch(1);
}

export function encodeSkyView(frame: Frame, graph: AtmosphereGraph): void {
  frame.pass({ target: graph.skyView, clear: CLEAR }, (pass) => pass.draw(graph.skyViewEffect));
}

/** Terrain depth prepass (reversed-Z, cleared to 0 = no terrain), then one fullscreen pass shades every pixel once. */
export function encodeScene(frame: Frame, graph: AtmosphereGraph): void {
  frame.pass({ target: graph.terrainDepth, clear: [0, 0, 0, 0], clearDepth: 0 }, (pass) => {
    if (graph.terrainColumns > 0) pass.draw(graph.terrainDraw, { instances: graph.terrainColumns });
  });
  frame.pass({ target: graph.scene, clear: CLEAR }, (pass) => pass.draw(graph.sceneEffect));
}

/**
 * Temporal cloud update in two passes: the frame's live texels (one in sixteen at rest, all of them on a frame that
 * follows a change) are marched packed into a viewport of the compact size, then the resolve pass scatters them
 * into the history and keeps the rest from last frame's buffer.
 */
export function encodeClouds(frame: Frame, graph: AtmosphereGraph): void {
  const fast = graph.cloudChangeFrames > 0;
  const period = fast ? CLOUD_FAST_REFRESH_PERIOD : CLOUD_CONVERGENCE_FRAMES;
  const size = graph.cloudsTargets.write.size;
  graph.cloudUpdate.set(cloudUpdateUniforms({ valid: graph.previousCamera !== undefined, frame: graph.frame, accumulate: graph.accumulate, fast, restFrames: graph.cloudRestFrames, size }));
  graph.cloudResolveEffect.set({ history: graph.cloudsTargets.read });
  const compact = compactCloudSize(size, period);
  frame.pass({ target: graph.cloudMarch, clear: [0, 0, 0, 1], viewport: { width: compact[0], height: compact[1] } }, (pass) => pass.draw(graph.cloudMarchEffect));
  frame.pass({ target: graph.cloudsTargets.write, clear: [0, 0, 0, 1] }, (pass) => pass.draw(graph.cloudResolveEffect));
}

/** Keep in sync with compactSize in clouds-temporal.wgsl: one texel per 4x4 block, a checkerboard, or everything. */
function compactCloudSize(size: readonly [number, number], period: number): readonly [number, number] {
  if (period === 16) return [Math.ceil(size[0] / 4), Math.ceil(size[1] / 4)];
  if (period === 2) return [Math.ceil(size[0] / 2), size[1]];
  return size;
}

export function encodePresent(frame: Frame, graph: AtmosphereGraph, output: Output): void {
  graph.presentEffect.set({ cloudsHdr: graph.cloudsTargets.write });
  frame.pass({ target: output, clear: CLEAR }, (pass) => pass.draw(graph.presentEffect));
}

/** Swaps the cloud history and advances the temporal sequence; once per frame, after the passes. */
export function finishFrame(graph: AtmosphereGraph): void {
  graph.cloudsTargets.swap();
  graph.previousCamera = graph.currentCamera;
  graph.frame += 1;
  if (graph.cloudChangeFrames > 0) graph.cloudChangeFrames -= 1;
  else graph.cloudRestFrames += 1;
}

/** Stills render enough frames for the temporal cloud update to touch every texel. */
function renderState(gpu: Gpu, graph: AtmosphereGraph, output: Target, state: AtmosphereState): void {
  applyState(graph, state, output.size);
  if (graph.lutPhase !== 'ready') bakeLuts(gpu, graph);
  // The per-frame constants read the sky-view LUT before this frame's pass writes it, and the aerial LUT reads the
  // sun's shadow map the same way: make both current first, or the first of the 16 frames differs from the rest.
  createFrame(gpu, (frame) => { encodeSkyView(frame, graph); encodeSunShadow(frame, graph); });
  for (let i = 0; i < CLOUD_CONVERGENCE_FRAMES; i++) createFrame(gpu, (frame) => renderGraph(frame, graph, output));
}

/** 4x4 Bayer sequence, centred: the sub-texel offsets a texel cycles through while accumulating. */
const JITTER_SEQUENCE: readonly (readonly [number, number])[] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
  .map((index) => [((index % 4) + 0.5) / 4 - 0.5, (Math.floor(index / 4) + 0.5) / 4 - 0.5] as const);

interface CloudUpdateState {
  /** False until a frame has rendered into the history, and again after a resize replaced the buffers. */
  readonly valid: boolean;
  readonly frame: number;
  readonly accumulate: boolean;
  readonly fast: boolean;
  readonly restFrames: number;
  readonly size: readonly [number, number];
}

/**
 * Fast (right after a change): every texel, full blend, no jitter, half the march steps. At rest: one in sixteen, each
 * re-marched texel weighted 1/(refreshes since the change + 1) down to CLOUD_BLEND_FLOOR, so the march noise and the
 * sub-texel jitter average into a supersampled image, and the long march. Stills always use full blend and no jitter.
 */
function cloudUpdateUniforms({ valid, frame, accumulate, fast, restFrames, size }: CloudUpdateState): CloudUpdateUniformValues {
  const refreshes = Math.floor(restFrames / CLOUD_CONVERGENCE_FRAMES);
  const blend = accumulate && !fast ? Math.max(1 / (refreshes + 1), CLOUD_BLEND_FLOOR) : 1;
  return {
    frame, valid: valid ? 1 : 0, blend, refreshPeriod: fast ? CLOUD_FAST_REFRESH_PERIOD : CLOUD_CONVERGENCE_FRAMES,
    jitter: blend < 1 ? JITTER_SEQUENCE[Math.floor(frame / 16) % 16]! : [0, 0], size,
    detail: fast ? 0 : 1, pad0: 0, pad1: 0, pad2: 0,
  };
}

function resizeGraph(graph: AtmosphereGraph, size: readonly [number, number]): void {
  graph.scene.resize(size);
  graph.terrainDepth.resize(size);
  // The scene reads the depth attachment itself (a texture_2d<f32> binding, see scene.wgsl); the resize replaced it.
  graph.sceneEffect.set({ terrainDepth: graph.terrainDepth.depth! });
  const cloudSize = cloudSizeFor(size);
  graph.cloudsTargets.read.resize(cloudSize);
  graph.cloudsTargets.write.resize(cloudSize);
  graph.cloudMarch.resize(cloudSize);
  // The history no longer matches the new size; re-march every texel on the next frame.
  graph.previousCamera = undefined;
  graph.cloudChangeFrames = CLOUD_FAST_REFRESH_PERIOD;
}

function cloudSizeFor(size: readonly [number, number]): readonly [number, number] {
  return [Math.max(1, Math.round(size[0] / CLOUD_TUNING.renderScale)), Math.max(1, Math.round(size[1] / CLOUD_TUNING.renderScale))];
}

function cloudUniforms(state: AtmosphereState): CloudUniformValues {
  return {
    bottom: CLOUD_TUNING.bottom, top: CLOUD_TUNING.top, coverage: Math.min(1, Math.max(0, state.cloudCoverage)), density: CLOUD_TUNING.density,
    shapeScale: CLOUD_TUNING.shapeScale, detailScale: CLOUD_TUNING.detailScale, weatherScale: CLOUD_TUNING.weatherScale, wind: state.time * CLOUD_TUNING.windSpeed,
    detailStrength: CLOUD_TUNING.detailStrength * Math.max(0, state.cloudDetail), groundRadius: ATMOSPHERE_PHYSICS.groundRadius,
    curlStrength: CLOUD_TUNING.curlStrength * Math.max(0, state.cloudDetail), detailLodDistance: CLOUD_TUNING.detailLodDistance,
    typeBias: state.cloudType * 0.5, seed: state.cloudSeed, shadows: state.cloudShadows ? 1 : 0, pad1: 0,
  };
}

function scale(v: Vec3, factor: number): Vec3 { return [v[0] * factor, v[1] * factor, v[2] * factor]; }

function sameDirection(a: Vec3 | undefined, b: Vec3): boolean {
  return a !== undefined && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function destroyGraph(graph: AtmosphereGraph): void {
  for (const target of [graph.transmittance, graph.skyView, graph.scene, graph.terrainDepth, ...graph.sunShadows, graph.cloudsTargets.read, graph.cloudsTargets.write, graph.cloudMarch]) for (const color of target.colors) color.destroy();
  graph.terrainDepth.depth?.destroy();
  for (const target of graph.sunShadows) target.depth?.destroy();
  for (const texture of [graph.multiScatter, graph.aerial, graph.aerialUnshadowed, graph.aerialDirect, graph.shapeNoise, graph.detailNoise, graph.weatherMap, graph.curlNoise, graph.terrainMap, graph.terrainAlbedoMap, graph.cloudShadowMap]) texture.destroy();
}
