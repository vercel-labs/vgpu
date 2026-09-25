// GPU resources and the per-frame chain shared by the live renderer and the
// thumbnail: swarm (compute: every particle's spring state from the timeline)
// → sparks (additive capsules into an HDR scene, optionally over a fading copy
// of the last frame) → bloom (half- and quarter-resolution Gaussian pairs) →
// composite (ACES, backdrop, vignette) into the output.

import {
  compute,
  draw,
  effect,
  sampler,
  storage,
  target,
  type Frame,
  type Gpu,
  type StorageBuffer,
  type Surface,
  type Target,
} from 'vgpu';

import {
  MAX_ACTIVE,
  PATTERNS,
  SPRING_SAMPLES,
  STAGGER_BINS,
  STAGGER_ROWS,
  patternFor,
  pullback,
  type ActiveSegment,
  type PatternChoice,
  type SpringTable,
} from './choreography';
import blurWgsl from './blur.wgsl';
import brightWgsl from './bright.wgsl';
import compositeWgsl from './composite.wgsl';
import fadeWgsl from './fade.wgsl';
import spritesWgsl from './sprites.wgsl';
import swarmWgsl from './swarm.wgsl';

type Output = Surface | Target;

const CLEAR = [0, 0, 0, 1] as const;
const SCENE_FORMAT = 'rgba16float' as const;
const WORKGROUP_SIZE = 64;
const PARTICLE_BYTES = 32;
const TABLE_FLOATS = SPRING_SAMPLES * 2 + STAGGER_ROWS.length * STAGGER_BINS;
const SEGMENT_WORDS = 8;
const BURST_WORDS = 4;
/** Landscape canvas height in CSS pixels the spark energy is tuned for. */
const REFERENCE_HEIGHT = 720;
export const MAX_BURSTS = 4;
/** Particle counts offered in the controls; the default is 2^18. */
export const PARTICLE_COUNTS = { '65k': 65_536, '262k': 262_144, '524k': 524_288, '1M': 1_048_576 } as const;
export const DEFAULT_COUNT = PARTICLE_COUNTS['262k'];

const BLURS = [
  { direction: [1, 0], radius: 1.3 },
  { direction: [0, 1], radius: 1.3 },
  { direction: [1, 0], radius: 2.1 },
  { direction: [0, 1], radius: 2.1 },
] as const;

export const COLOR_MODES = { Shape: 0, Velocity: 1, 'Spring phase': 2 } as const;
export type ColorMode = (typeof COLOR_MODES)[keyof typeof COLOR_MODES];

export interface Look {
  readonly colorMode: ColorMode;
  /** Sparks' diameter in CSS pixels at the reference distance. */
  readonly size: number;
  /** Seconds of spring velocity each streak spans; 0 draws round sparks. */
  readonly streak: number;
  readonly bloom: boolean;
  readonly exposure: number;
}

export const DEFAULT_LOOK: Look = {
  colorMode: COLOR_MODES.Shape,
  size: 1.7,
  streak: 0.016,
  bloom: true,
  exposure: 1.05,
};

export interface Burst {
  /** Click point in NDC. */
  readonly origin: readonly [number, number];
  /** Seconds since the click. */
  readonly age: number;
  readonly amplitude: number;
}

export interface FrameState {
  readonly time: number;
  readonly viewProjection: Float32Array<ArrayBuffer>;
  readonly yaw: number;
  readonly baseShape: number;
  readonly segments: readonly ActiveSegment[];
  readonly pattern: PatternChoice;
  /** Stagger origin (NDC) per segment index, for the cursor pattern. */
  readonly origins?: ReadonlyMap<number, readonly [number, number]>;
  readonly bursts: readonly Burst[];
  readonly pointer: {
    readonly position: readonly [number, number];
    readonly velocity: readonly [number, number];
    readonly strength: number;
    /** CSS pixels. */
    readonly radius: number;
  };
  /** Trail persistence per frame (0 clears; ~0.85 is a long trail). */
  readonly keep: number;
}

export interface PipelineOptions {
  readonly count?: number;
  readonly look?: Look;
}

export interface Pipeline {
  readonly count: number;
  resize(size: readonly [number, number], pixelRatio: number): void;
  setCount(count: number): void;
  setSpring(table: SpringTable, stagger: Float32Array<ArrayBuffer>, spread: number): void;
  setLook(look: Partial<Look>): void;
  prewarm(output: Output): Promise<void>;
  encode(currentFrame: Frame, output: Output, state: FrameState): void;
}

export function createPipeline(gpu: Gpu, options: PipelineOptions = {}): Pipeline {
  let count = options.count ?? DEFAULT_COUNT;
  let look: Look = { ...DEFAULT_LOOK, ...options.look };
  let size: readonly [number, number] = [1, 1];
  let pixelRatio = 1;
  // The trail fade multiplies the previous frame; a new scene target has none.
  let sceneFresh = true;

  // Everything created here belongs to `gpu`; gpu.dispose() releases it.
  const tables = storage(gpu, TABLE_FLOATS * 4, 'read');
  const stateBytes = new ArrayBuffer((MAX_ACTIVE * SEGMENT_WORDS + MAX_BURSTS * BURST_WORDS) * 4);
  const stateFloats = new Float32Array(stateBytes);
  const stateWords = new Uint32Array(stateBytes);
  const state = storage(gpu, stateBytes.byteLength, 'read');
  state.write(stateFloats);
  // gpu.dispose() frees these; one buffer per count, so switching back does not allocate again.
  const particleBuffers = new Map<number, StorageBuffer>();
  const particlesFor = (n: number) => {
    let buffer = particleBuffers.get(n);
    if (!buffer) particleBuffers.set(n, (buffer = storage(gpu, n * PARTICLE_BYTES, 'read-write')));
    return buffer;
  };
  let particles = particlesFor(count);
  const targets = createTargets(gpu, size);

  const samp = sampler(gpu, {
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const swarm = compute(gpu, swarmWgsl, {
    label: 'spring-choreography-swarm',
    set: {
      tables,
      state,
      particles,
      params: {
        viewProjection: new Float32Array(16),
        resolution: [1, 1],
        pointer: [0, 0],
        pointerVelocity: [0, 0],
        pointerStrength: 0,
        pointerRadius: 1,
        time: 0,
        springDuration: 1,
        springPeak: 1,
        spread: 1,
        count,
        activeCount: 0,
        baseShape: 0,
        colorMode: look.colorMode,
        energy: 1,
        size: look.size,
        streak: look.streak,
        yaw: 0,
        pixelRatio: 1,
        pad: 0,
      },
    },
  });
  const sparks = draw(gpu, {
    shader: spritesWgsl,
    // One four-corner strip per spark: two fewer vertices than a triangle list.
    geometry: { topology: 'triangle-strip' },
    vertices: 4,
    instances: count,
    blend: {
      color: { src: 'src-alpha', dst: 'one' },
      alpha: { src: 'one', dst: 'one-minus-src-alpha' },
    },
    label: 'spring-choreography-sparks',
    set: { particles, view: { resolution: [1, 1], gain: 1 } },
  });
  const fade = effect(gpu, fadeWgsl, {
    label: 'spring-choreography-fade',
    blend: { color: { src: 'zero', dst: 'src' }, alpha: { src: 'zero', dst: 'one' } },
    set: { fade: { keep: 0 } },
  });
  const bright = effect(gpu, brightWgsl, {
    label: 'spring-choreography-bright',
    set: { samp, bright: { threshold: 0.35, knee: 0.9 } },
  });
  // Initial struct values must be complete; bind() replaces the texel size.
  const blurs = BLURS.map((blur, i) =>
    effect(gpu, blurWgsl, { label: `spring-choreography-blur-${i}`, set: { samp, blur: { ...blur, texelSize: [1, 1] } } }),
  );
  const composite = effect(gpu, compositeWgsl, {
    label: 'spring-choreography-composite',
    set: { samp, params: { exposure: look.exposure, bloomNear: 0.55, bloomFar: 0.7, aspect: 1 } },
  });

  const bind = () => {
    swarm.set({ params: { resolution: [size[0], size[1]], pixelRatio } });
    sparks.set({ view: { resolution: [size[0], size[1]] } });
    bright.set({ src: targets.scene });
    blurs[0]!.set({ src: targets.near[0], blur: { texelSize: targets.near[0].texelSize } });
    blurs[1]!.set({ src: targets.near[1], blur: { texelSize: targets.near[1].texelSize } });
    // The quarter-resolution pair downsamples the settled half-resolution glow.
    blurs[2]!.set({ src: targets.near[0], blur: { texelSize: targets.far[0].texelSize } });
    blurs[3]!.set({ src: targets.far[0], blur: { texelSize: targets.far[0].texelSize } });
    composite.set({
      scene: targets.scene,
      near: targets.near[0],
      far: targets.far[1],
      params: { aspect: size[0] / Math.max(1, size[1]) },
    });
  };
  bind();

  const writeState = (frameState: FrameState) => {
    stateFloats.fill(0);
    frameState.segments.forEach((segment, i) => {
      const pattern = PATTERNS[patternFor(frameState.pattern, segment.index)];
      const origin = frameState.origins?.get(segment.index) ?? [0, 0];
      const base = i * SEGMENT_WORDS;
      stateWords[base] = segment.source;
      stateWords[base + 1] = segment.target;
      stateWords[base + 2] = pattern.coord;
      stateWords[base + 3] = pattern.row;
      stateFloats[base + 4] = segment.elapsed;
      stateFloats[base + 5] = origin[0];
      stateFloats[base + 6] = origin[1];
      stateFloats[base + 7] = 1 / farthestCorner(origin, size);
    });
    frameState.bursts.slice(0, MAX_BURSTS).forEach((burst, i) => {
      const base = MAX_ACTIVE * SEGMENT_WORDS + i * BURST_WORDS;
      stateFloats[base] = burst.origin[0];
      stateFloats[base + 1] = burst.origin[1];
      stateFloats[base + 2] = burst.age;
      stateFloats[base + 3] = burst.amplitude;
    });
    state.write(stateFloats);
  };

  return {
    get count() {
      return count;
    },
    resize(next, ratio) {
      size = [Math.max(1, Math.round(next[0])), Math.max(1, Math.round(next[1]))];
      pixelRatio = ratio;
      targets.resize(size);
      sceneFresh = true;
      swarm.set({ params: { energy: energyFor(count, size, pixelRatio) } });
      bind();
    },
    setCount(next) {
      if (next === count) return;
      particles = particlesFor(next);
      count = next;
      swarm.set({ particles, params: { count, energy: energyFor(count, size, pixelRatio) } });
      sparks.set({ particles });
    },
    setSpring(table, stagger, spread) {
      const data = new Float32Array(TABLE_FLOATS);
      data.set(table.values, 0);
      data.set(stagger, SPRING_SAMPLES * 2);
      tables.write(data);
      swarm.set({ params: { springDuration: table.duration, springPeak: table.peakVelocity, spread } });
    },
    setLook(next) {
      look = { ...look, ...next };
      swarm.set({ params: { colorMode: look.colorMode, size: look.size, streak: look.streak } });
      composite.set({ params: { exposure: look.exposure } });
    },
    async prewarm(output) {
      swarm.set({ params: { energy: energyFor(count, size, pixelRatio) } });
      await Promise.all([
        swarm.compile(),
        sparks.compile(targets.scene),
        fade.compile(targets.scene),
        bright.compile(targets.near[0]),
        blurs[0]!.compile(targets.near[1]),
        blurs[1]!.compile(targets.near[0]),
        blurs[2]!.compile(targets.far[0]),
        blurs[3]!.compile(targets.far[1]),
        composite.compile({ colors: [output.format] }),
      ]);
    },
    encode(currentFrame, output, frameState) {
      writeState(frameState);
      swarm.set({
        params: {
          viewProjection: frameState.viewProjection,
          pointer: [frameState.pointer.position[0], frameState.pointer.position[1]],
          pointerVelocity: [frameState.pointer.velocity[0], frameState.pointer.velocity[1]],
          pointerStrength: frameState.pointer.strength,
          pointerRadius: frameState.pointer.radius * pixelRatio,
          time: frameState.time,
          activeCount: frameState.segments.length,
          baseShape: frameState.baseShape,
          yaw: frameState.yaw,
        },
      });
      currentFrame.computePass((pass) => pass.dispatch(swarm, Math.ceil(count / WORKGROUP_SIZE)));

      const trails = frameState.keep > 0 && !sceneFresh;
      if (trails) fade.set({ fade: { keep: frameState.keep } });
      sparks.set({ view: { gain: trails ? 1 - frameState.keep : 1 } });
      currentFrame.pass({ target: targets.scene, clear: trails ? false : CLEAR }, (pass) => {
        if (trails) pass.draw(fade);
        pass.draw(sparks, { instances: count });
      });
      sceneFresh = false;

      if (look.bloom) {
        currentFrame.pass({ target: targets.near[0], clear: CLEAR }, (pass) => pass.draw(bright));
        currentFrame.pass({ target: targets.near[1], clear: CLEAR }, (pass) => pass.draw(blurs[0]!));
        currentFrame.pass({ target: targets.near[0], clear: CLEAR }, (pass) => pass.draw(blurs[1]!));
        currentFrame.pass({ target: targets.far[0], clear: CLEAR }, (pass) => pass.draw(blurs[2]!));
        currentFrame.pass({ target: targets.far[1], clear: CLEAR }, (pass) => pass.draw(blurs[3]!));
      }
      composite.set({ params: { bloomNear: look.bloom ? 0.55 : 0, bloomFar: look.bloom ? 0.7 : 0 } });
      currentFrame.pass({ target: output, clear: CLEAR }, (pass) => pass.draw(composite));
    },
  };
}

/**
 * Each spark is faint, so shapes glow by density. Denser swarms get dimmer
 * sparks, and so do smaller shapes on screen: sparks keep their CSS size, so
 * the same swarm drawn smaller would stack brighter.
 */
function energyFor(count: number, size: readonly [number, number], pixelRatio: number): number {
  const shapeHeight = size[1] / pixelRatio / pullback(size[0] / Math.max(1, size[1]));
  const area = (shapeHeight / REFERENCE_HEIGHT) ** 2;
  return 0.13 * Math.pow(DEFAULT_COUNT / count, 0.8) * Math.min(Math.max(area, 0.15), 4);
}

/** Largest aspect-corrected NDC distance from `origin` to a viewport corner. */
function farthestCorner(origin: readonly [number, number], size: readonly [number, number]): number {
  const aspect = size[0] / Math.max(1, size[1]);
  let farthest = 0;
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      farthest = Math.max(farthest, Math.hypot((x - origin[0]) * aspect, y - origin[1]));
    }
  }
  return Math.max(farthest, 1e-3);
}

interface Targets {
  readonly scene: Target;
  readonly near: readonly [Target, Target];
  readonly far: readonly [Target, Target];
  resize(size: readonly [number, number]): void;
}

function createTargets(gpu: Gpu, size: readonly [number, number]): Targets {
  const scaled = (divisor: number): [number, number] => [
    Math.max(1, Math.round(size[0] / divisor)),
    Math.max(1, Math.round(size[1] / divisor)),
  ];
  const make = (divisor: number, label: string) =>
    target(gpu, { size: scaled(divisor), format: SCENE_FORMAT, label: `spring-choreography-${label}` });
  const scene = make(1, 'scene');
  const near = [make(2, 'near-a'), make(2, 'near-b')] as const;
  const far = [make(4, 'far-a'), make(4, 'far-b')] as const;
  return {
    scene,
    near,
    far,
    resize(next) {
      size = next;
      scene.resize(scaled(1));
      for (const half of near) half.resize(scaled(2));
      for (const quarter of far) quarter.resize(scaled(4));
    },
  };
}
