// Frame-to-frame state of the hero: the converging intro, drag rotation with
// per-stroke lag, flow along the strokes, and the pointer-repel input the
// compute pass consumes. Pure TypeScript with no DOM or GPU dependencies.

import { LAYER_FLOATS, type StarField } from './field';

/** Seconds a repelled star takes to coast back; matches simulate.wgsl. */
export const SETTLE_SECONDS = 6;
const MAX_ROTATION = 4 * Math.PI;

export interface AnimationOptions {
  readonly reducedMotion?: boolean;
  /** Seconds the scattered sky takes to converge onto the strokes. */
  readonly introDuration?: number;
  readonly flowSpeed?: number;
  readonly twinkleSpeed?: number;
  readonly intensity?: number;
  /** 0 keeps every stroke locked to the drag; 1 lets outer strokes trail. */
  readonly rotationLag?: number;
  /** Spring the field back to face the viewer after a drag. */
  readonly faceForward?: boolean;
  /** Pointer-repel radius in CSS pixels. */
  readonly repelRadius?: number;
  readonly particleRepel?: boolean;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** Values the simulation uniform receives each frame. */
export interface SimulationFrame {
  readonly time: number;
  readonly intro: number;
  readonly twinkleSpeed: number;
  readonly intensity: number;
  readonly backgroundEnabled: number;
  readonly repelEnabled: number;
  readonly repelImpulse: number;
  readonly repelAge: number;
  readonly pointer: readonly [number, number];
  readonly previous: readonly [number, number];
  readonly impulse: readonly [number, number];
}

export interface Animation {
  readonly layerData: Float32Array<ArrayBuffer>;
  readonly intro: number;
  readonly spin: Readonly<Vec2>;
  readonly rotation: Readonly<Vec2>;
  readonly returning: boolean;
  readonly repelRadius: number;
  readonly repelEnabled: boolean;
  /** Set after `replay()` or `resetMotion()`; the renderer clears the motion buffer and acknowledges. */
  readonly motionDirty: boolean;
  update(dt: number): SimulationFrame;
  /** Adds drag rotation in radians (x pitches, y yaws). */
  rotate(x: number, y: number): void;
  /** Ends a drag: springs back to face forward when configured. */
  release(): void;
  setPointer(x: number, y: number, pressed: boolean): void;
  clearPointer(): void;
  /** Turns hover repel on or off; reduced motion keeps it off. */
  setRepel(enabled: boolean): void;
  resetMotion(): void;
  acknowledgeMotion(): void;
  replay(): void;
  /** Jumps every spring to its target; used for deterministic thumbnails. */
  settle(): void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function smoothstep(x: number, edge0: number, edge1: number) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function positiveModulo(value: number, modulo: number) {
  return ((value % modulo) + modulo) % modulo;
}
function wrapAngle(value: number) {
  return positiveModulo(value + Math.PI, 2 * Math.PI) - Math.PI;
}

export function createAnimation(field: StarField, options: AnimationOptions = {}): Animation {
  const reduced = options.reducedMotion ?? false;
  const duration = clamp(options.introDuration ?? 5.5, 1, 10);
  const flowSpeed = reduced ? 0 : clamp(options.flowSpeed ?? 0.8, 0, 3);
  const twinkleSpeed = reduced ? 0 : clamp(options.twinkleSpeed ?? 0.62, 0, 2);
  const intensity = clamp(options.intensity ?? 1.2, 0.1, 3);
  const rotationLag = clamp(options.rotationLag ?? 0.68, 0, 1);
  const faceForward = options.faceForward ?? true;
  let repelEnabled = !reduced && (options.particleRepel ?? true);
  const repelRadius = clamp(options.repelRadius ?? 176, 16, 360);

  const layerData = new Float32Array(field.layers.length * LAYER_FLOATS);
  const layerSpin = field.layers.map(() => ({ x: 0, y: 0 }));
  const pathOffset = field.layers.map(() => 0);
  const rotation: Vec2 = { x: 0, y: 0 };
  const spin: Vec2 = { x: 0, y: 0 };
  const pointer = { active: false, pressed: false, x: 0, y: 0 };
  const lastPointer: Vec2 = { x: 0, y: 0 };
  const previous: Vec2 = { x: 0, y: 0 };
  let wasActive = false;
  let elapsed = 0;
  let introElapsed = reduced ? duration : 0;
  let returning = false;
  let coreTarget = 0;
  let coreRotation = 0;
  let motionAge = SETTLE_SECONDS;
  let remaining = 0;
  let motionDirty = false;
  let intro = reduced ? 1 : 0;

  const resetMotion = () => {
    motionAge = SETTLE_SECONDS;
    remaining = 0;
    wasActive = false;
    motionDirty = true;
  };

  const update = (deltaSeconds: number): SimulationFrame => {
    const dt = Number.isFinite(deltaSeconds) ? clamp(deltaSeconds, 0, 0.05) : 0;
    if (!reduced) {
      elapsed += dt;
      introElapsed = Math.min(introElapsed + dt, duration);
    }
    intro = reduced ? 1 : clamp(introElapsed / duration, 0, 1);
    const visibility = smoothstep(intro, 0.55, 1);

    // Drag rotation: the root follows quickly, each stroke trails by its lag.
    const spring = returning ? 5.5 : 14;
    const k = 1 - Math.exp(-spring * dt);
    spin.x = lerp(spin.x, rotation.x, k);
    spin.y = lerp(spin.y, rotation.y, k);
    if (Math.abs(spin.x - rotation.x) < 1e-4) spin.x = rotation.x;
    if (Math.abs(spin.y - rotation.y) < 1e-4) spin.y = rotation.y;

    coreTarget = wrapAngle(coreTarget + dt * 0.36 * flowSpeed);
    const coreDelta = Math.atan2(Math.sin(coreTarget - coreRotation), Math.cos(coreTarget - coreRotation));
    coreRotation = wrapAngle(coreRotation + coreDelta * (1 - Math.exp(-14 * dt)));

    field.layers.forEach((layer, i) => {
      const o = i * LAYER_FLOATS;
      const s = layerSpin[i]!;
      if (layer.isCore) {
        layerData[o] = spin.x * visibility + 0.08 * Math.sin(0.22 * elapsed) * visibility;
        layerData[o + 1] = spin.y * visibility + 0.14 * Math.cos(0.28 * elapsed) * visibility;
        layerData[o + 2] = coreRotation * visibility;
        layerData[o + 3] = 0;
        layerData[o + 4] = 0;
        layerData[o + 5] = 0;
        layerData[o + 6] = 1.22;
        return;
      }
      const kl = 1 - Math.exp(-(spring / (1 + layer.lag * rotationLag * 2.5)) * dt);
      s.x = lerp(s.x, rotation.x, kl);
      s.y = lerp(s.y, rotation.y, kl);
      pathOffset[i] = positiveModulo(pathOffset[i]! + dt * layer.speed * flowSpeed * visibility, 1);
      layerData[o] = s.x * visibility;
      layerData[o + 1] = s.y * visibility;
      layerData[o + 2] = 0;
      layerData[o + 3] = pathOffset[i]!;
      layerData[o + 4] = layer.sampleBase;
      layerData[o + 5] = 1;
      layerData[o + 6] = 1;
    });

    // Pointer repel: hovering (not dragging) pushes stars along the pointer path.
    const age = motionAge;
    motionAge = Math.min(SETTLE_SECONDS, motionAge + dt);
    let impulseX = 0;
    let impulseY = 0;
    let hasImpulse = false;
    const active = repelEnabled && pointer.active && !pointer.pressed;
    if (active) {
      previous.x = lastPointer.x;
      previous.y = lastPointer.y;
      lastPointer.x = pointer.x;
      lastPointer.y = pointer.y;
      if (wasActive) {
        impulseX = lastPointer.x - previous.x;
        impulseY = lastPointer.y - previous.y;
        if (impulseX * impulseX + impulseY * impulseY > 1e-8) {
          hasImpulse = true;
          remaining = SETTLE_SECONDS;
        }
      } else {
        previous.x = lastPointer.x;
        previous.y = lastPointer.y;
      }
    }
    wasActive = active;
    remaining = Math.max(0, remaining - dt);
    if (hasImpulse) motionAge = 0;

    return {
      time: elapsed,
      intro,
      twinkleSpeed: twinkleSpeed * visibility,
      intensity,
      backgroundEnabled: 1,
      repelEnabled: repelEnabled && (remaining > 0 || hasImpulse) ? 1 : 0,
      repelImpulse: hasImpulse ? 1 : 0,
      repelAge: age,
      pointer: [lastPointer.x, lastPointer.y],
      previous: [previous.x, previous.y],
      impulse: [impulseX, impulseY],
    };
  };

  return {
    layerData,
    get intro() {
      return intro;
    },
    spin,
    rotation,
    get returning() {
      return returning;
    },
    repelRadius,
    get repelEnabled() {
      return repelEnabled;
    },
    get motionDirty() {
      return motionDirty;
    },
    update,
    rotate(x, y) {
      rotation.x = clamp(rotation.x + x, -MAX_ROTATION, MAX_ROTATION);
      rotation.y = clamp(rotation.y + y, -MAX_ROTATION, MAX_ROTATION);
      returning = false;
    },
    release() {
      if (!faceForward) return;
      rotation.x = 0;
      rotation.y = 0;
      returning = true;
    },
    setPointer(x, y, pressed) {
      pointer.active = true;
      pointer.pressed = pressed;
      pointer.x = clamp(x, -1, 1);
      pointer.y = clamp(y, -1, 1);
    },
    clearPointer() {
      pointer.active = false;
      pointer.pressed = false;
    },
    setRepel(enabled) {
      repelEnabled = !reduced && enabled;
      if (!repelEnabled) {
        remaining = 0;
        wasActive = false;
      }
    },
    resetMotion,
    acknowledgeMotion() {
      motionDirty = false;
    },
    replay() {
      introElapsed = 0;
      intro = reduced ? 1 : 0;
      rotation.x = 0;
      rotation.y = 0;
      returning = true;
      pointer.active = false;
      pointer.pressed = false;
      resetMotion();
    },
    settle() {
      spin.x = rotation.x;
      spin.y = rotation.y;
      for (const s of layerSpin) {
        s.x = rotation.x;
        s.y = rotation.y;
      }
      coreRotation = coreTarget;
    },
  };
}
