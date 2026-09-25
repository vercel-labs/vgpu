// The choreography as pure functions of timeline time, shared by the live
// renderer and the thumbnail. Motion supplies the physics and the timing:
// its spring generator is baked into a position/velocity lookup table and its
// stagger() into per-pattern delay tables. The GPU then evaluates
//
//   x_i(t) = S_base + Σ_active (S_next − S_prev) · s(t − T_k − delay_k(i))
//
// a linear spring chasing a stepwise target: overlapping morphs keep their
// momentum and every frame is reproducible from the playhead alone.

import { calcGeneratorDuration, spring, stagger, type Easing } from 'motion';

export interface Pose {
  /** Radians added to the orbit. */
  readonly yaw: number;
  /** Radians above the horizon. */
  readonly pitch: number;
  readonly distance: number;
}

export const SHAPES = [
  { id: 'triangle', label: 'Hello triangle', pose: { yaw: 0, pitch: 0.08, distance: 4.6 } },
  { id: 'sphere', label: 'Sphere', pose: { yaw: 0.35, pitch: 0.32, distance: 4.8 } },
  { id: 'knot', label: 'Torus knot', pose: { yaw: -0.25, pitch: 0.62, distance: 4.7 } },
  { id: 'galaxy', label: 'Galaxy', pose: { yaw: 0.2, pitch: 0.98, distance: 4.6 } },
  { id: 'waves', label: 'Wave field', pose: { yaw: -0.3, pitch: 0.5, distance: 4.9 } },
] as const satisfies readonly { id: string; label: string; pose: Pose }[];

export const SHAPE_COUNT = SHAPES.length;
/** Seconds between morph cues. */
export const SEGMENT = 4.5;
/** The first morph starts after a short look at the opening shape. */
export const LEAD = 0.9;
export const LOOP = SHAPE_COUNT * SEGMENT;
/** More than the longest spring plus the widest spread can overlap. */
export const MAX_ACTIVE = 4;

/** Timeline time when segment k (shape k → shape k + 1) starts. */
export function cueTime(k: number): number {
  return LEAD + k * SEGMENT;
}

export function wrapTime(t: number): number {
  return ((t % LOOP) + LOOP) % LOOP;
}

// ---------------------------------------------------------------- springs

export interface SpringSettings {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
}

export const SPRING_PRESETS = {
  Bouncy: { stiffness: 140, damping: 8, mass: 1 },
  Wobbly: { stiffness: 70, damping: 4.5, mass: 1.4 },
  Snappy: { stiffness: 380, damping: 26, mass: 1 },
  Gentle: { stiffness: 60, damping: 13, mass: 1 },
} as const satisfies Record<string, SpringSettings>;

export type SpringPreset = keyof typeof SPRING_PRESETS;
export const DEFAULT_SPRING: SpringSettings = SPRING_PRESETS.Bouncy;

export const SPRING_SAMPLES = 1024;
/** Longer springs are faded into their target over the last quarter. */
export const MAX_SPRING_DURATION = 6;

export interface SpringTable {
  /** Seconds covered by the table; s = 1, s' = 0 afterwards. */
  readonly duration: number;
  /** Interleaved position and velocity (per second) of the unit step. */
  readonly values: Float32Array<ArrayBuffer>;
  readonly peakVelocity: number;
  readonly overshoot: number;
}

/** Critical damping for the same stiffness and mass: no overshoot, no wobble. */
export function criticallyDamped(settings: SpringSettings): SpringSettings {
  return { ...settings, damping: Math.max(settings.damping, 2 * Math.sqrt(settings.stiffness * settings.mass)) };
}

export function bakeSpring(settings: SpringSettings, samples = SPRING_SAMPLES): SpringTable {
  const generator = spring({ keyframes: [0, 1], ...settings });
  const settle = calcGeneratorDuration(generator) / 1000;
  const duration = Math.min(Math.max(settle, 0.2), MAX_SPRING_DURATION);
  const fadeFrom = settle > duration ? duration * 0.75 : duration;
  const values = new Float32Array(samples * 2);
  let peakVelocity = 0;
  let overshoot = 0;
  for (let i = 0; i < samples; i++) {
    const t = (i / (samples - 1)) * duration;
    let x = generator.next(t * 1000).value;
    let v = generator.velocity?.(t * 1000) ?? 0;
    if (t > fadeFrom) {
      // Window the residual so a capped spring still lands exactly on 1.
      const u = (t - fadeFrom) / (duration - fadeFrom);
      const w = 1 - u * u * (3 - 2 * u);
      const dw = (-6 * u * (1 - u)) / (duration - fadeFrom);
      v = v * w + (x - 1) * dw;
      x = 1 + (x - 1) * w;
    }
    values[i * 2] = x;
    values[i * 2 + 1] = v;
    peakVelocity = Math.max(peakVelocity, Math.abs(v));
    overshoot = Math.max(overshoot, x - 1);
  }
  values[(samples - 1) * 2] = 1;
  values[(samples - 1) * 2 + 1] = 0;
  return { duration, values, peakVelocity: Math.max(peakVelocity, 1e-3), overshoot };
}

// ---------------------------------------------------------------- stagger

export const STAGGER_BINS = 256;
/** Rows of the delay table, in the order swarm.wgsl indexes them. */
export const STAGGER_ROWS = ['first', 'last', 'center', 'burst'] as const;
export const BURST_SPREAD = 0.55;

export const STAGGER_EASES = {
  Linear: 'linear',
  'Ease in': 'easeIn',
  'Ease out': 'easeOut',
  'Ease in-out': 'easeInOut',
  'Circ out': 'circOut',
} as const satisfies Record<string, Easing>;

export type StaggerEase = (typeof STAGGER_EASES)[keyof typeof STAGGER_EASES];

/** Each row is Motion's stagger() over 256 bins, normalised so its largest delay is `spread`. */
export function bakeStagger(spread: number, ease: StaggerEase): Float32Array<ArrayBuffer> {
  const table = new Float32Array(STAGGER_ROWS.length * STAGGER_BINS);
  const rows = [
    { from: 'first', ease, spread },
    { from: 'last', ease, spread },
    { from: 'center', ease, spread },
    { from: 'first', ease: 'easeIn', spread: BURST_SPREAD },
  ] as const;
  rows.forEach((row, r) => {
    const delay = stagger(1 / STAGGER_BINS, { from: row.from, ease: row.ease });
    let max = 0;
    for (let i = 0; i < STAGGER_BINS; i++) {
      const value = delay(i, STAGGER_BINS);
      table[r * STAGGER_BINS + i] = value;
      max = Math.max(max, value);
    }
    const scale = max > 0 ? row.spread / max : 0;
    for (let i = 0; i < STAGGER_BINS; i++) table[r * STAGGER_BINS + i]! *= scale;
  });
  return table;
}

export const DEFAULT_STAGGER = { spread: 1.1, ease: 'easeInOut' } as const satisfies {
  spread: number;
  ease: StaggerEase;
};

/** Seconds a morph is in flight: the slowest particle's delay (spread plus 8% jitter), then its whole spring. */
export function morphWindow(spread: number, springDuration: number): number {
  return spread * 1.08 + springDuration + 0.05;
}

/** Coordinate kinds; swarm.wgsl maps each to 0..1 before the delay lookup. */
export const COORD = { radius: 0, screenX: 1, noise: 2, spiral: 3, cursor: 4 } as const;

export const PATTERNS = {
  center: { label: 'Center out', coord: COORD.radius, row: 0 },
  edges: { label: 'Edges in', coord: COORD.radius, row: 1 },
  sweep: { label: 'Sweep', coord: COORD.screenX, row: 0 },
  split: { label: 'Split', coord: COORD.screenX, row: 2 },
  noise: { label: 'Noise bands', coord: COORD.noise, row: 0 },
  spiral: { label: 'Spiral', coord: COORD.spiral, row: 0 },
  cursor: { label: 'Cursor', coord: COORD.cursor, row: 0 },
} as const;

export type PatternId = keyof typeof PATTERNS;
export type PatternChoice = PatternId | 'auto';
/** Auto gives every cue of the loop its own pattern. */
export const AUTO_PATTERNS: readonly PatternId[] = ['center', 'sweep', 'noise', 'spiral', 'edges'];

export function patternFor(choice: PatternChoice, k: number): PatternId {
  return choice === 'auto' ? AUTO_PATTERNS[k % AUTO_PATTERNS.length]! : choice;
}

// ---------------------------------------------------------------- timeline

export interface ActiveSegment {
  readonly index: number;
  readonly source: number;
  readonly target: number;
  /** Seconds since the cue, before the per-particle delay. */
  readonly elapsed: number;
}

/**
 * Segments still moving at timeline time t: started, and not yet past the
 * slowest particle's delay plus the spring. Completed segments are folded into
 * the base shape. Sorted oldest first, so each target is the next source.
 */
export function activeSegments(time: number, window: number): ActiveSegment[] {
  const t = wrapTime(time);
  const active: ActiveSegment[] = [];
  for (const offset of [-LOOP, 0]) {
    for (let k = 0; k < SHAPE_COUNT; k++) {
      const elapsed = t - (cueTime(k) + offset);
      if (elapsed >= 0 && elapsed < window) {
        active.push({ index: k, source: k, target: (k + 1) % SHAPE_COUNT, elapsed });
      }
    }
  }
  active.sort((a, b) => b.elapsed - a.elapsed);
  return active.slice(-MAX_ACTIVE);
}

/** The shape every particle rests on before the active segments add their deltas. */
export function baseShape(time: number, active: readonly ActiveSegment[]): number {
  if (active.length > 0) return active[0]!.source;
  return (latestCue(wrapTime(time)).index + 1) % SHAPE_COUNT;
}

/** The shape the swarm is heading for or holding: what the Shape menu shows. */
export function currentShape(time: number): number {
  return (latestCue(wrapTime(time)).index + 1) % SHAPE_COUNT;
}

/** Timeline time where the morph into `shape` starts. */
export function arrivalCue(shape: number): number {
  return cueTime((shape - 1 + SHAPE_COUNT) % SHAPE_COUNT);
}

function latestCue(t: number): { index: number; elapsed: number } {
  for (let k = SHAPE_COUNT - 1; k >= 0; k--) {
    if (t >= cueTime(k)) return { index: k, elapsed: t - cueTime(k) };
  }
  // Before the first cue the previous loop's last morph is still the latest.
  return { index: SHAPE_COUNT - 1, elapsed: t - (cueTime(SHAPE_COUNT - 1) - LOOP) };
}

// ---------------------------------------------------------------- camera

const cameraEase = spring({ keyframes: [0, 1], visualDuration: 2.8, bounce: 0.18 });
const FOV = (38 * Math.PI) / 180;

export interface Camera {
  readonly viewProjection: Float32Array<ArrayBuffer>;
  /** Orbit angle, so the triangle can keep facing the viewer. */
  readonly yaw: number;
}

/** Portrait viewports pull the camera back so the widest shapes still fit. */
export function pullback(aspect: number): number {
  return aspect < 1 ? 1 + (1 - aspect) * 1.1 : 1;
}

/**
 * Each shape has a pose and a Motion spring eases towards the next one from
 * every cue. The previous cue's spring is still summed in, so a camera that has
 * not settled when the next cue fires carries on smoothly. The orbit turns once
 * per loop, so the loop seam is invisible.
 */
export function cameraAt(time: number, aspect: number, orbit = 1): Camera {
  const t = wrapTime(time);
  const cue = latestCue(t);
  const pose = (offset: number) => SHAPES[(cue.index + offset + SHAPE_COUNT) % SHAPE_COUNT]!.pose;
  const settle = cameraEase.next((cue.elapsed + SEGMENT) * 1000).value;
  const arrive = cameraEase.next(cue.elapsed * 1000).value;
  const mixPose = (key: keyof Pose) =>
    pose(-1)[key] + (pose(0)[key] - pose(-1)[key]) * settle + (pose(1)[key] - pose(0)[key]) * arrive;
  const yaw = mixPose('yaw') + orbit * ((t / LOOP) * Math.PI * 2);
  const pitch = mixPose('pitch');
  const distance = mixPose('distance') * pullback(aspect);
  const eye = [
    Math.sin(yaw) * Math.cos(pitch) * distance,
    Math.sin(pitch) * distance,
    Math.cos(yaw) * Math.cos(pitch) * distance,
  ] as const;
  return { viewProjection: lookAtOrigin(eye, aspect), yaw };
}

/** Perspective × look-at-origin with +Y up; column-major, WebGPU clip depth 0..1. */
function lookAtOrigin([ex, ey, ez]: readonly [number, number, number], aspect: number) {
  const length = Math.hypot(ex, ey, ez);
  const [fx, fy, fz] = [-ex / length, -ey / length, -ez / length];
  // side = normalize(forward × up), up = forward-corrected +Y.
  const sideLength = Math.hypot(fz, fx) || 1;
  const [sx, sy, sz] = [-fz / sideLength, 0, fx / sideLength];
  const [ux, uy, uz] = [sy * fz - sz * fy, sz * fx - sx * fz, sx * fy - sy * fx];
  const near = 0.05;
  const far = 40;
  const g = 1 / Math.tan(FOV / 2);
  const a = far / (near - far);
  const b = (near * far) / (near - far);
  const tx = -(sx * ex + sy * ey + sz * ez);
  const ty = -(ux * ex + uy * ey + uz * ez);
  const tz = fx * ex + fy * ey + fz * ez;
  // Rows of the view matrix are side, up and −forward; projection folded in.
  // prettier-ignore
  return new Float32Array([
    (g / aspect) * sx, g * ux, -a * fx, fx,
    (g / aspect) * sy, g * uy, -a * fy, fy,
    (g / aspect) * sz, g * uz, -a * fz, fz,
    (g / aspect) * tx, g * ty, a * tz + b, -tz,
  ]);
}
