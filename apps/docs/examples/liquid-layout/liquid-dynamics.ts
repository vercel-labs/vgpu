// Pure per-frame liquid dynamics. The renderer measures the laid-out cards and
// hands over one sample per card; this module turns them into the primitives
// the field shader blends (one rounded rect per card). It owns everything the
// DOM does not have: speed-driven softness, a jelly strain spring, and circles
// that open out of the centre of cards that arrive and close back into it for
// cards that leave. Every card, a dragged one included, merges in the grid
// layer; only the open panel and the card flying back from it float in the
// layer above.
// No DOM, no GPU.

import { cornerRadius, type Layer } from './layout-store';

export const MAX_PRIMS = 32;
/** Four vec4f per primitive; see field.wgsl for the layout. */
export const PRIM_FLOATS = 16;

export interface CardSample {
  readonly id: string;
  readonly layer: Layer;
  /** Visual centre and unrotated half extents, CSS px from the canvas top-left. */
  readonly cx: number;
  readonly cy: number;
  readonly hw: number;
  readonly hh: number;
  /** Radians. */
  readonly rotation: number;
  /** Drag offset from the layout slot, CSS px. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly scale: number;
  readonly hue: number;
  readonly present: boolean;
  readonly hovered: boolean;
  /** Floats above the grid: the open panel, or the card flying back from it. */
  readonly lifted: boolean;
}

export interface DynamicsOptions {
  /** Multiplies every smooth-min radius; 1 is the tuned default. */
  smoothness: number;
  /** Calmer path: no stretch, fades instead of opening and closing circles. */
  reducedMotion: boolean;
}

export interface LiquidFrame {
  readonly data: Float32Array;
  readonly count: number;
  /** Seconds of surface flow: the wobble clock, slower under reduced motion. */
  readonly flow: number;
  /** Tint, energy and opacity of the top layer, taken from its most lifted blob. */
  readonly panelHue: number;
  readonly panelEnergy: number;
  readonly panelLift: number;
  /** Smallest corner radius (CSS px) among the cards; the glass bezel stays inside it. */
  readonly minCorner: number;
}

type Strain = [number, number, number];

interface Blob {
  readonly id: string;
  /** Stable per card: phases the wobble. */
  readonly seed: number;
  layer: Layer;
  hue: number;
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  rotation: number;
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  energy: number;
  hover: number;
  /** 0 at rest, ~1 in flight: the body shrinks into a rounder pebble. Springy, so landings overshoot. */
  melt: number;
  meltVelocity: number;
  /**
   * 0 in the grid layer, 1 in the top layer (the open panel, a card flying
   * back). Eases, so a blob fades between layers instead of popping.
   */
  lift: number;
  strain: Strain;
  strainVelocity: Strain;
  /** Seconds since the entry started; negative while staggered, Infinity when done. */
  enter: number;
  grow: number;
  growVelocity: number;
  offsetX: number;
  offsetY: number;
  scale: number;
  seen: boolean;
}

/** A card that has left: its glass closes back into its centre, the entry in reverse. */
interface Exit {
  readonly hue: number;
  readonly cx: number;
  readonly cy: number;
  readonly hw: number;
  readonly hh: number;
  readonly corner: number;
  readonly rotation: number;
  readonly energy: number;
  readonly calm: boolean;
  age: number;
  grow: number;
  growVelocity: number;
}

interface RectPrim {
  readonly cx: number;
  readonly cy: number;
  readonly hw: number;
  readonly hh: number;
  readonly corner: number;
  readonly k: number;
  readonly layer: Layer;
  readonly hue: number;
  readonly energy: number;
  readonly rotation?: number;
  readonly strain?: Strain;
  readonly erode?: number;
  /** Edge bulge in CSS px; 0 keeps the rect exact. */
  readonly wobble?: number;
  readonly seed?: number;
}

// Smooth-min radius range (CSS px). The rest radius stays well under half the
// grid gap so resting cards never touch; the moving radius bridges neighbours
// that pass within ~20 px of each other.
export const K_REST = 6;
export const K_MOVING = 28;
/** A dragged card fuses with every card it passes. */
export const K_DRAG = 30;
// Half-size (CSS px) below which a card's moving radius and wobble scale down with it.
const REACH_SIZE = 120;

const STRETCH_MAX = 0.3;
const JELLY_OMEGA = 2 * Math.PI * 3;
const JELLY_DAMPING = 0.3;
const STRAIN_LIMIT = 0.42;
const SIZE_KICK = 0.35;
const LAG_SECONDS = 0.012;
const LAG_LIMIT = 18;

// Entry: circles open out of each card on a gentle spring (reaches the card in
// about 0.4 s, swells ~4% past it), one card after another in reading order.
// Exits run the same spring back to nothing.
const ENTER_TOTAL = 1.1;
const ENTER_STAGGER = 0.06;
const ENTER_SWELL = 0.5;
const GROW_OMEGA = 2 * Math.PI * 1.1;
const GROW_DAMPING = 0.62;

const MAX_EXITS = 9;

// A card counts as held once it is dragged this far (CSS px) from its slot.
const HOLD_START = 4;
const LIFT_TAU = 0.06;
// A held card keeps most of its shape: its copy is still on it.
const DRAG_MELT = 0.25;

// Flying cards melt: they shrink by up to MELT_SHRINK and round off, so passing
// cards neck and bridge instead of fusing into one slab.
const MELT_SHRINK = 0.08;
const MELT_OMEGA = 2 * Math.PI * 5;
const MELT_DAMPING = 0.55;


// Resting edges stay exact rounded rects, like system glass; only motion
// (strain, melt) deforms them.
const WOBBLE = 0;
const PANEL_WOBBLE = 0;
// Under reduced motion the surface still breathes, five times slower.
const CALM_FLOW = 0.2;

export function createDynamics(options: DynamicsOptions) {
  const settings: DynamicsOptions = { ...options };
  const blobs = new Map<string, Blob>();
  const exits: Exit[] = [];
  const data = new Float32Array(MAX_PRIMS * PRIM_FLOATS);
  let count = 0;
  let flow = 0;

  const push = (): number => (count < MAX_PRIMS ? count++ : -1);

  function rect(prim: RectPrim) {
    const { hw, hh, strain = [0, 0, 0], rotation = 0 } = prim;
    if (hw <= 0.5 || hh <= 0.5) return;
    const i = push();
    if (i < 0) return;
    // World → local: undo the strain (I + T), then the card rotation.
    const a = 1 + strain[0];
    const b = strain[1];
    const d = 1 + strain[2];
    const det = a * d - b * b;
    const inv00 = d / det;
    const inv01 = -b / det;
    const inv11 = a / det;
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    // Rot(-θ) · (I + T)⁻¹
    const m00 = c * inv00 + s * inv01;
    const m01 = c * inv01 + s * inv11;
    const m10 = -s * inv00 + c * inv01;
    const m11 = -s * inv01 + c * inv11;
    // The smallest singular value of (I + T) keeps the distance a lower bound.
    const mean = (a + d) / 2;
    const spread = Math.hypot((a - d) / 2, b);
    const distScale = Math.max(0.2, mean - spread);
    const o = i * PRIM_FLOATS;
    data[o] = prim.cx;
    data[o + 1] = prim.cy;
    data[o + 2] = hw;
    data[o + 3] = hh;
    data[o + 4] = Math.min(prim.corner, hw, hh);
    data[o + 5] = Math.max(1, prim.k * settings.smoothness);
    data[o + 6] = prim.layer === 'panel' ? 2 : 0;
    data[o + 7] = prim.hue;
    data[o + 8] = m00;
    data[o + 9] = m01;
    data[o + 10] = m10;
    data[o + 11] = m11;
    data[o + 12] = prim.erode ?? 0;
    data[o + 13] = prim.energy;
    data[o + 14] = distScale;
    data[o + 15] = wobbleCode(prim.seed ?? 0, prim.wobble ?? 0);
  }

  function createBlob(sample: CardSample): Blob {
    return {
      id: sample.id,
      seed: hashString(sample.id),
      layer: sample.layer,
      hue: sample.hue,
      cx: sample.cx,
      cy: sample.cy,
      hw: sample.hw,
      hh: sample.hh,
      rotation: sample.rotation,
      vx: 0,
      vy: 0,
      vw: 0,
      vh: 0,
      energy: 0,
      hover: 0,
      melt: 0,
      meltVelocity: 0,
      lift: sample.lifted ? 1 : 0,
      strain: [0, 0, 0],
      strainVelocity: [0, 0, 0],
      enter: 0,
      grow: 0,
      growVelocity: 0,
      offsetX: sample.offsetX,
      offsetY: sample.offsetY,
      scale: sample.scale,
      seen: true,
    };
  }

  function startExit(blob: Blob) {
    // A card that leaves mid-entry closes from wherever its circle had reached,
    // keeping the spring's momentum.
    const entered = blob.enter === Infinity;
    const grow = entered ? 1 : blob.grow;
    if (grow < 0.05) return;
    if (exits.length >= MAX_EXITS) exits.shift();
    exits.push({
      hue: blob.hue,
      cx: blob.cx,
      cy: blob.cy,
      hw: blob.hw,
      hh: blob.hh,
      corner: cornerRadius(2 * blob.hw, 2 * blob.hh),
      rotation: blob.rotation,
      energy: blob.energy,
      calm: settings.reducedMotion,
      age: 0,
      grow,
      growVelocity: entered ? 0 : blob.growVelocity,
    });
  }

  function stepKinematics(blob: Blob, sample: CardSample, dt: number, teleport: boolean) {
    const rawVx = (sample.cx - blob.cx) / dt;
    const rawVy = (sample.cy - blob.cy) / dt;
    const rawVw = (sample.hw - blob.hw) / dt;
    const rawVh = (sample.hh - blob.hh) / dt;
    const previousVw = blob.vw;
    const previousVh = blob.vh;
    if (teleport) {
      blob.vx = blob.vy = blob.vw = blob.vh = 0;
    } else {
      const follow = 1 - Math.exp(-dt / 0.035);
      blob.vx += (rawVx - blob.vx) * follow;
      blob.vy += (rawVy - blob.vy) * follow;
      blob.vw += (rawVw - blob.vw) * follow;
      blob.vh += (rawVh - blob.vh) * follow;
    }
    blob.cx = sample.cx;
    blob.cy = sample.cy;
    blob.hw = sample.hw;
    blob.hh = sample.hh;
    blob.rotation = sample.rotation;
    blob.layer = sample.layer;
    blob.hue = sample.hue;
    blob.offsetX = sample.offsetX;
    blob.offsetY = sample.offsetY;
    blob.scale = sample.scale;

    const liftTarget = sample.lifted ? 1 : 0;
    blob.lift = teleport ? liftTarget : blob.lift + (liftTarget - blob.lift) * (1 - Math.exp(-dt / LIFT_TAU));
    if (Math.abs(liftTarget - blob.lift) < 0.01) blob.lift = liftTarget;

    const speed = Math.hypot(blob.vx, blob.vy) + 0.6 * (Math.abs(blob.vw) + Math.abs(blob.vh));
    const target = 1 - Math.exp(-speed / 700);
    const tau = target > blob.energy ? 0.05 : 0.45;
    blob.energy += (target - blob.energy) * (1 - Math.exp(-dt / tau));
    blob.hover += ((sample.hovered ? 1 : 0) - blob.hover) * (1 - Math.exp(-dt / 0.12));

    const held = isHeld(blob);

    if (settings.reducedMotion) {
      blob.strain = [0, 0, 0];
      blob.strainVelocity = [0, 0, 0];
      blob.melt = 0;
      blob.meltVelocity = 0;
      return;
    }

    const meltTarget = teleport ? 0 : smoothstep(120, 1000, Math.hypot(blob.vx, blob.vy)) * (held ? DRAG_MELT : 1);
    const meltAccel =
      MELT_OMEGA * MELT_OMEGA * (meltTarget - blob.melt) - 2 * MELT_DAMPING * MELT_OMEGA * blob.meltVelocity;
    blob.meltVelocity += meltAccel * dt;
    blob.melt = clamp(blob.melt + blob.meltVelocity * dt, -0.12, 1.2);

    // Jelly: the strain chases a velocity-aligned stretch through an
    // under-damped spring, so a card that stops overshoots into a squash.
    const moveSpeed = Math.hypot(blob.vx, blob.vy);
    let target00 = 0;
    let target01 = 0;
    let target11 = 0;
    if (moveSpeed > 1) {
      const amount = STRETCH_MAX * (1 - Math.exp(-moveSpeed / 1600));
      const dx = blob.vx / moveSpeed;
      const dy = blob.vy / moveSpeed;
      const squeeze = 0.35 * amount;
      target00 = amount * dx * dx - squeeze * dy * dy;
      target01 = (amount + squeeze) * dx * dy;
      target11 = amount * dy * dy - squeeze * dx * dx;
    }
    // Size changes (the layoutId flight, the panel landing) kick the jelly too.
    const kickX = teleport ? 0 : (-(blob.vw - previousVw) / dt / Math.max(40, blob.hw)) * SIZE_KICK;
    const kickY = teleport ? 0 : (-(blob.vh - previousVh) / dt / Math.max(40, blob.hh)) * SIZE_KICK;
    const targets: Strain = [target00, target01, target11];
    const kicks: Strain = [kickX, 0, kickY];
    const omega2 = JELLY_OMEGA * JELLY_OMEGA;
    const damping = 2 * JELLY_DAMPING * JELLY_OMEGA;
    for (let c = 0; c < 3; c++) {
      const accel = omega2 * (targets[c]! - blob.strain[c]!) - damping * blob.strainVelocity[c]! + kicks[c]!;
      blob.strainVelocity[c] = blob.strainVelocity[c]! + accel * dt;
      blob.strain[c] = clamp(blob.strain[c]! + blob.strainVelocity[c]! * dt, -STRAIN_LIMIT, STRAIN_LIMIT);
    }
  }

  function isHeld(blob: Blob): boolean {
    return blob.layer === 'grid' && blob.enter === Infinity && Math.hypot(blob.offsetX, blob.offsetY) > HOLD_START;
  }

  function wobbleOf(blob: Blob): number {
    const size = clamp(Math.min(blob.hw, blob.hh) / REACH_SIZE, 0.5, 1.2);
    return (blob.layer === 'panel' ? PANEL_WOBBLE : WOBBLE * size) * (1 - 0.6 * clamp(blob.melt, 0, 1));
  }

  function emitBlob(blob: Blob, dt: number) {
    const corner = cornerRadius(2 * blob.hw, 2 * blob.hh);
    const hover = blob.hover * 0.55;
    const energy = Math.max(blob.energy, hover);
    // Bridges follow the melt, not the raw speed: a card rounds off before it
    // reaches for its neighbours, and lets go as soon as it lands.
    // Small cards on small screens reach proportionally, so a phone grid bridges
    // rather than fusing into one puddle.
    const reach = clamp(blob.melt, 0, 1) * clamp(Math.min(blob.hw, blob.hh) / REACH_SIZE, 0.55, 1);
    let k = K_REST + K_MOVING * reach * reach;
    // A dragged card stays in the grid field with a wide merge radius, so it
    // fuses with each card it crosses and pinches off as it leaves.
    if (isHeld(blob)) k = Math.max(k, K_DRAG * smoothstep(HOLD_START, 40, Math.hypot(blob.offsetX, blob.offsetY)));

    if (blob.enter !== Infinity) {
      emitEntering(blob, corner, k, energy, dt);
      return;
    }

    // The body trails the card slightly, so the stretch reads as drag, not scale.
    const lagX = clamp(-blob.vx * LAG_SECONDS, -LAG_LIMIT, LAG_LIMIT);
    const lagY = clamp(-blob.vy * LAG_SECONDS, -LAG_LIMIT, LAG_LIMIT);
    // Below 0 the spring has overshot on landing: the body swells a touch, then settles.
    const melt = blob.melt;
    const size = 1 - MELT_SHRINK * melt;
    const hw = blob.hw * size;
    const hh = blob.hh * size;
    // Rounds off early in the melt, so crossing cards overlap as pebbles rather than slabs.
    const round = smoothstep(0, 0.75, melt);
    const body = (layer: Layer) =>
      rect({
        cx: blob.cx + (settings.reducedMotion ? 0 : lagX),
        cy: blob.cy + (settings.reducedMotion ? 0 : lagY),
        hw,
        hh,
        corner: corner + (0.6 * Math.min(hw, hh) - corner) * round,
        k,
        layer,
        hue: blob.hue,
        energy,
        rotation: blob.rotation,
        strain: blob.strain,
        wobble: wobbleOf(blob),
        seed: blob.seed,
      });
    // Between layers the body is in both: the top copy fades in (or out) over
    // the grid copy, which stays whole until the lift completes.
    if (blob.lift < 1) body('grid');
    if (blob.lift > 0) body('panel');
  }

  function emitEntering(blob: Blob, corner: number, k: number, energy: number, dt: number) {
    const t = blob.enter;
    if (t < 0) return;
    if (settings.reducedMotion) {
      const grow = smoothstep(0, 0.35, t);
      blob.grow = grow;
      if (t >= 0.35) blob.enter = Infinity;
      rect({
        cx: blob.cx,
        cy: blob.cy,
        hw: blob.hw,
        hh: blob.hh,
        corner,
        k,
        layer: blob.layer,
        hue: blob.hue,
        energy,
        rotation: blob.rotation,
        erode: (1 - grow) * 22,
        wobble: wobbleOf(blob) * grow,
        seed: blob.seed,
      });
      return;
    }
    // A circle opens out of the card's centre on one spring that swells the
    // card a touch past its size before it settles.
    const accel = GROW_OMEGA * GROW_OMEGA * (1 - blob.grow) - 2 * GROW_DAMPING * GROW_OMEGA * blob.growVelocity;
    blob.growVelocity += accel * dt;
    blob.grow += blob.growVelocity * dt;
    rect({
      cx: blob.cx,
      cy: blob.cy,
      ...opening(blob.hw, blob.hh, corner, blob.grow),
      k,
      layer: blob.layer,
      hue: blob.hue,
      energy: Math.max(energy, 1 - clamp(blob.grow, 0, 1)),
      rotation: blob.rotation,
      strain: blob.strain,
    });
    if (t >= ENTER_TOTAL && Math.abs(blob.grow - 1) < 0.01 && Math.abs(blob.growVelocity) < 0.05) {
      blob.enter = Infinity;
      blob.grow = 1;
    }
  }

  function emitExit(exit: Exit, dt: number): boolean {
    exit.age += dt;
    if (exit.calm) {
      const u = smoothstep(0, 0.45, exit.age);
      rect({
        cx: exit.cx,
        cy: exit.cy,
        hw: exit.hw,
        hh: exit.hh,
        corner: exit.corner,
        k: K_REST,
        layer: 'grid',
        hue: exit.hue,
        energy: 0,
        erode: u * Math.min(exit.hw, exit.hh) * 1.05,
      });
      return exit.age < 0.45;
    }
    // The entry in reverse, on its spring: the corners round into a pill, the
    // pill into a circle, and the circle shrinks into the card's centre.
    const accel = -GROW_OMEGA * GROW_OMEGA * exit.grow - 2 * GROW_DAMPING * GROW_OMEGA * exit.growVelocity;
    exit.growVelocity += accel * dt;
    exit.grow += exit.growVelocity * dt;
    if (exit.grow <= 0) return false;
    rect({
      cx: exit.cx,
      cy: exit.cy,
      ...opening(exit.hw, exit.hh, exit.corner, exit.grow),
      k: K_REST,
      layer: 'grid',
      hue: exit.hue,
      energy: Math.max(exit.energy, 1 - clamp(exit.grow, 0, 1)),
      rotation: exit.rotation,
    });
    return true;
  }

  return {
    setOptions(next: Partial<DynamicsOptions>) {
      Object.assign(settings, next);
    },
    /**
     * Advances by `dt` seconds. `viewport` is the canvas size in CSS px; pass
     * `teleport` when every card moved for a reason other than animation.
     */
    update(samples: readonly CardSample[], dt: number, viewport: readonly [number, number], teleport = false): LiquidFrame {
      const step = clamp(dt, 1 / 1000, 1 / 20);
      flow += step * (settings.reducedMotion ? CALM_FLOW : 1);
      const jump = 0.5 * Math.max(viewport[0], viewport[1]);
      for (const blob of blobs.values()) blob.seen = false;
      const entering: Blob[] = [];

      for (const sample of samples) {
        if (!sample.present) continue;
        let blob = blobs.get(sample.id);
        if (!blob) {
          blob = createBlob(sample);
          blobs.set(sample.id, blob);
          entering.push(blob);
          continue;
        }
        blob.seen = true;
        const moved = Math.hypot(sample.cx - blob.cx, sample.cy - blob.cy);
        stepKinematics(blob, sample, step, teleport || moved > jump);
        if (blob.enter !== Infinity) blob.enter += step;
      }

      // Cards arriving together open in reading order, one after another.
      entering.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
      entering.forEach((blob, rank) => {
        blob.enter = -rank * ENTER_STAGGER;
      });

      for (const [id, blob] of blobs) {
        if (blob.seen) continue;
        blobs.delete(id);
        startExit(blob);
      }

      count = 0;
      let panelHue = 0;
      let panelEnergy = 0;
      let panelLift = 0;
      let minCorner = Number.POSITIVE_INFINITY;
      for (const blob of blobs.values()) {
        minCorner = Math.min(minCorner, cornerRadius(2 * blob.hw, 2 * blob.hh));
        emitBlob(blob, step);
        if (blob.lift > panelLift) {
          panelLift = blob.lift;
          panelHue = blob.hue;
          panelEnergy = Math.max(blob.energy, blob.hover * 0.55);
        }
      }
      for (let i = exits.length - 1; i >= 0; i--) {
        if (!emitExit(exits[i]!, step)) exits.splice(i, 1);
      }
      return { data, count, flow, panelHue, panelEnergy, panelLift, minCorner };
    },
  };
}

export type Dynamics = ReturnType<typeof createDynamics>;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * A card's shape `grow` of the way through opening out of its centre: a circle
 * until it meets the card's nearer sides, a pill until it meets the farther
 * ones, then the corners tighten to the card's own. Past 1 the card swells.
 */
function opening(hw: number, hh: number, corner: number, grow: number) {
  const short = Math.min(hw, hh);
  const long = Math.max(hw, hh);
  // The circle's radius runs from 0 to the short half-size, on to the long
  // one, then on by as much as the corners have left to tighten.
  const radius = Math.max(0, grow) * (long + Math.max(0, short - corner));
  const swell = 1 + ENTER_SWELL * Math.max(0, grow - 1);
  return {
    hw: Math.min(radius, hw) * swell,
    hh: Math.min(radius, hh) * swell,
    // While the circle is smaller than the card the rect clamps this to its
    // half-size, so it stays round.
    corner: clamp(Math.min(radius, short) - Math.max(0, radius - long), corner, short),
  };
}

/** FNV-1a: a stable seed per card id. */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}


/** field.wgsl reads the wobble phase and amplitude from one float: phase * 16 + amplitude. */
function wobbleCode(seed: number, amplitude: number): number {
  return (seed % 64) * 16 + clamp(amplitude, 0, 15.9);
}
