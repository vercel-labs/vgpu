import {
  compute,
  draw,
  effect,
  sampler,
  storage,
  target,
  type Compute,
  type Draw,
  type Effect,
  type Frame,
  type Gpu,
  type StorageBuffer,
  type Surface,
  type Target,
} from "vgpu";

import backgroundWgsl from "./background.wgsl";
import particlesWgsl from "./particles.wgsl";
import presentWgsl from "./present.wgsl";
import simulateWgsl from "./simulate.wgsl";

export const PARTICLE_COUNT = 98_304;
export const PARTICLE_FLOATS = 16;
const WORKGROUP_SIZE = 128;

type GeoPoint = readonly [longitude: number, latitude: number];

const CONTINENTS: readonly (readonly GeoPoint[])[] = [
  [
    [-2.95, 0.86],
    [-2.57, 1.24],
    [-1.92, 1.25],
    [-1.28, 0.91],
    [-1.14, 0.56],
    [-1.48, 0.28],
    [-1.76, 0.18],
    [-2.04, 0.42],
    [-2.42, 0.34],
    [-2.7, 0.57],
  ],
  [
    [-1.58, 0.32],
    [-1.23, 0.26],
    [-0.86, 0.02],
    [-0.77, -0.36],
    [-1, -0.83],
    [-1.25, -1.13],
    [-1.43, -0.68],
    [-1.58, -0.16],
  ],
  [
    [-0.34, 0.58],
    [0.16, 0.65],
    [0.57, 0.42],
    [0.67, 0.03],
    [0.39, -0.58],
    [0.08, -0.88],
    [-0.2, -0.53],
    [-0.4, 0.05],
  ],
  [
    [-0.25, 0.64],
    [0.22, 1.02],
    [1.03, 1.18],
    [1.77, 1.08],
    [2.55, 0.82],
    [2.82, 0.47],
    [2.29, 0.18],
    [1.74, 0.29],
    [1.4, 0.07],
    [1.05, 0.25],
    [0.69, 0.2],
    [0.35, 0.5],
  ],
  [
    [1.03, 0.33],
    [1.55, 0.29],
    [1.34, -0.12],
  ],
  [
    [1.84, -0.47],
    [2.25, -0.36],
    [2.7, -0.55],
    [2.58, -0.82],
    [2.13, -0.9],
    [1.81, -0.69],
  ],
  [
    [-1.37, 1.12],
    [-0.92, 1.31],
    [-0.67, 1.13],
    [-0.92, 0.92],
  ],
];

export interface LiquidGeoScene {
  readonly particleCount: number;
  readonly particles: StorageBuffer;
  readonly simulation: Compute;
  readonly background: Draw;
  readonly beads: Draw;
  readonly present: Effect;
  readonly sceneTarget: Target;
}

export interface SceneFrame {
  readonly time: number;
  readonly deltaTime: number;
  readonly pointer: readonly [number, number];
  readonly pointerStrength: number;
  readonly reducedMotion: boolean;
  readonly earthMix: number;
}

export function createInitialParticles(
  count = PARTICLE_COUNT,
  seed = 0x6d2b79f5
): Float32Array<ArrayBuffer> {
  const data = new Float32Array(count * PARTICLE_FLOATS);
  let state = seed >>> 0;
  const random = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < count; i++) {
    const offset = i * PARTICLE_FLOATS;
    const longitude = random() * Math.PI * 2;
    const latitude = random() * 2 - 1;
    const ring = Math.sqrt(Math.max(0, 1 - latitude * latitude));
    const radius = 0.97 + random() * 0.03;
    const x = Math.cos(longitude) * ring * radius;
    const y = latitude * radius;
    const z = Math.sin(longitude) * ring * radius;
    const grain = random();
    const mapLongitude =
      longitude > Math.PI ? longitude - Math.PI * 2 : longitude;
    const land = isEarthLand(mapLongitude, Math.asin(latitude)) ? 1 : 0;
    data.set(
      [
        x,
        y,
        z,
        1,
        0,
        0,
        0,
        0,
        longitude,
        latitude,
        radius,
        grain,
        land,
        0,
        0,
        0,
      ],
      offset
    );
  }
  return data;
}

export function isEarthLand(longitude: number, latitude: number): boolean {
  if (latitude < -1.3) return true;
  return CONTINENTS.some((polygon) =>
    pointInPolygon(longitude, latitude, polygon)
  );
}

function pointInPolygon(x: number, y: number, polygon: readonly GeoPoint[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export async function createLiquidGeoScene(
  gpu: Gpu,
  output: Surface | Target,
  count = PARTICLE_COUNT
): Promise<LiquidGeoScene> {
  const particles = storage(gpu, count * PARTICLE_FLOATS * 4, "read-write");
  const sceneTarget = target(gpu, {
    size: output.size,
    format: "rgba8unorm",
    depth: true,
    label: "liquid-geo-scene",
  });
  try {
    particles.write(createInitialParticles(count));
    const simulation = compute(gpu, simulateWgsl, {
      label: "liquid-geo-simulation",
      set: { particles },
    });
    const background = draw(gpu, {
      shader: backgroundWgsl,
      label: "liquid-geo-background",
      vertices: 3,
      depth: false,
    });
    const beads = draw(gpu, {
      shader: particlesWgsl,
      label: "liquid-geo-beads",
      vertices: 6,
      instances: count,
      depth: { write: true, compare: "less" },
      set: { particles },
    });
    const present = effect(gpu, presentWgsl, {
      label: "liquid-geo-present",
      set: {
        scene_texture: sceneTarget,
        linear_sampler: sampler(gpu, {
          minFilter: "linear",
          magFilter: "linear",
        }),
        present: { resolution: output.size },
      },
    });
    const view = viewUniforms(output.size, 0);
    background.set({ view });
    beads.set({ view });
    await Promise.all([
      background.compile(sceneTarget),
      beads.compile(sceneTarget),
    ]);
    return {
      particleCount: count,
      particles,
      simulation,
      background,
      beads,
      present,
      sceneTarget,
    };
  } catch (error) {
    destroyStorage(particles);
    destroyTarget(sceneTarget);
    throw error;
  }
}

export function resizeLiquidGeoScene(
  scene: LiquidGeoScene,
  output: Surface | Target
): void {
  scene.sceneTarget.resize(output.size);
  scene.present.set({ present: { resolution: output.size } });
}

export function renderLiquidGeo(
  currentFrame: Frame,
  scene: LiquidGeoScene,
  output: Surface | Target,
  state: SceneFrame
): void {
  const size = output.size;
  const view = viewUniforms(size, state.time);
  scene.simulation
    .set({
      params: {
        time: state.time,
        dt: Math.min(1 / 30, Math.max(0.0001, state.deltaTime)),
        aspect: size[0] / Math.max(1, size[1]),
        reduced_motion: state.reducedMotion ? 1 : 0,
        earth_mix: state.earthMix,
        pointer: state.pointer,
        pointer_strength: state.pointerStrength,
        particle_count: scene.particleCount,
      },
    })
    .dispatch(Math.ceil(scene.particleCount / WORKGROUP_SIZE));
  scene.background.set({ view });
  scene.beads.set({ view });
  currentFrame.pass(
    { target: scene.sceneTarget, clear: [0.79, 0.805, 0.825, 1] },
    (pass) => {
      pass.draw(scene.background);
      pass.draw(scene.beads);
    }
  );
  currentFrame.pass({ target: output }, (pass) => pass.draw(scene.present));
}

export function destroyLiquidGeoScene(scene: LiquidGeoScene): void {
  destroyStorage(scene.particles);
  destroyTarget(scene.sceneTarget);
}

function viewUniforms(size: readonly [number, number], time: number) {
  return {
    aspect: size[0] / Math.max(1, size[1]),
    pixel_scale: Math.min(2, Math.max(1, devicePixelRatioSafe())),
    height: Math.max(1, size[1]),
    time,
  };
}

function devicePixelRatioSafe(): number {
  return typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
}

function destroyTarget(value: Target): void {
  (value as Target & { destroy(): void }).destroy();
}

function destroyStorage(value: StorageBuffer): void {
  (value as StorageBuffer & { destroy(): void }).destroy();
}
