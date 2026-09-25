// Pure per-frame liquid dynamics. The renderer measures the laid-out cards and
// hands over one sample per card; this module turns them into the primitives
// the field shader blends (rounded rects for card bodies, filleted bars for
// necks, capsules for droplets and drips) and the tiny air bubbles the shade
// pass draws. It owns everything the DOM does not have: speed-driven softness,
// a jelly strain spring, necks that grow between resting row neighbours and
// pinch apart when either card moves, drips for cards that leave and splashes
// for cards that arrive. Every card, a dragged one included, merges in the grid layer; only
// the open panel and the card flying back from it float in the layer above.
// No DOM, no GPU.

import { cornerRadius, type Layer } from './layout-store';

export const MAX_PRIMS = 32;
/** Four vec4f per primitive; see field.wgsl for the layout. */
export const PRIM_FLOATS = 16;
export const MAX_BUBBLES = 28;
/** One vec4f per bubble: centre.xy, radius, alpha (negative on the panel layer). */
export const BUBBLE_FLOATS = 4;

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
  /** Calmer path: no stretch, slow wobble, fades instead of drips and splashes. */
  reducedMotion: boolean;
}

export interface LiquidFrame {
  readonly data: Float32Array;
  readonly count: number;
  readonly bubbles: Float32Array;
  readonly bubbleCount: number;
  /** Seconds of surface flow: the wobble and bubble clock, slower under reduced motion. */
  readonly flow: number;
  /** Tint, energy and opacity of the top layer, taken from its most lifted blob. */
  readonly panelHue: number;
  readonly panelEnergy: number;
  readonly panelLift: number;
}

type Strain = [number, number, number];

interface Blob {
  readonly id: string;
  /** Stable per card: phases the wobble and places the bubbles. */
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
  splashed: boolean;
  offsetX: number;
  offsetY: number;
  scale: number;
  /** Seconds the card has rested in its slot; necks only grow between resting cards. */
  rest: number;
  seen: boolean;
}

interface Neck {
  readonly left: string;
  readonly right: string;
  /** Where the neck sits on the pair's shared height, 0 (top) to 1. */
  readonly height: number;
  /** Where its droplet sits along the neck, or -1 for none. */
  readonly bead: number;
  readonly seed: number;
  /** 0 (not formed) to 1 (full); falls quickly while the neck pinches apart. */
  grow: number;
}

interface Drip {
  readonly hue: number;
  readonly cx: number;
  readonly cy: number;
  readonly hw: number;
  readonly hh: number;
  readonly energy: number;
  readonly calm: boolean;
  driftX: number;
  driftVelocity: number;
  age: number;
  dropY: number;
  dropVelocity: number;
  dropRadius: number;
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
export const MAX_NECKS = 2;
// Half-size (CSS px) below which a card's moving radius and wobble scale down with it.
const REACH_SIZE = 120;
const K_DRIP = 30;
const K_BEAD = 5;

const STRETCH_MAX = 0.3;
const JELLY_OMEGA = 2 * Math.PI * 3;
const JELLY_DAMPING = 0.3;
const STRAIN_LIMIT = 0.42;
const SIZE_KICK = 0.35;
const LAG_SECONDS = 0.012;
const LAG_LIMIT = 18;

const ENTER_FALL = 0.26;
const ENTER_TOTAL = 1.1;
const ENTER_STAGGER = 0.06;
const GROW_OMEGA = 2 * Math.PI * 2.4;
const GROW_DAMPING = 0.5;

const DRAIN = 1.05;
const DRIP_RELEASE = 0.5;
const GRAVITY = 2400;
const MAX_DRIPS = 9;

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

// Necks: a thin bar at mid-height between resting row neighbours that flares
// into both edges. It grows in once both cards have rested for NECK_REST
// seconds and pinches apart as soon as either moves. Its ends reach NECK_INSET
// px inside each card, past its wobble; NECK_BULGE is how far a resting edge
// typically bows into the gap. NECK_K is the radius later primitives blend
// with near it.
const NECK_GAP_MIN = 4;
const NECK_GAP_MAX = 64;
const NECK_OVERLAP = 0.6;
const NECK_REST = 0.35;
const NECK_GROW = 0.9;
const NECK_BREAK = 0.22;
const NECK_INSET = 8;
const NECK_BULGE = 4;
const NECK_K = 7;

// Surface tension: edges bulge by up to WOBBLE px on a REACH_SIZE card.
const WOBBLE = 6.5;
const PANEL_WOBBLE = 7;
// Under reduced motion the surface still breathes, five times slower.
const CALM_FLOW = 0.2;

export function createDynamics(options: DynamicsOptions) {
  const settings: DynamicsOptions = { ...options };
  const blobs = new Map<string, Blob>();
  const necks = new Map<string, Neck>();
  const drips: Drip[] = [];
  const data = new Float32Array(MAX_PRIMS * PRIM_FLOATS);
  const bubbles = new Float32Array(MAX_BUBBLES * BUBBLE_FLOATS);
  let count = 0;
  let bubbleCount = 0;
  let viewportHeight = 1;
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

  /** A tapered capsule (drips and splashes); skipped while it has no radius. */
  function capsule(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    ra: number,
    rb: number,
    k: number,
    layer: Layer,
    hue: number,
    energy: number,
  ) {
    if (ra <= 0.25 && rb <= 0.25) return;
    segment(ax, ay, bx, by, ra, rb, k, layer === 'panel' ? 3 : 1, hue, energy, 0);
  }

  /**
   * A grid-layer droplet of `radius` that blends with its own radius only. A
   * negative radius keeps it below the surface.
   */
  function bead(x: number, y: number, radius: number, k: number, hue: number) {
    segment(x, y, x, y, 0, 0, k, 5, hue, 0, -radius);
  }

  /**
   * A grid-layer bar across a gap, `waist` thick on each side of its axis,
   * that flares into the edges it meets with circular fillets of `fillet` px.
   * At a waist of -fillet it leaves the surface untouched.
   */
  function bridge(cx: number, cy: number, halfLength: number, fillet: number, waist: number, hue: number) {
    const i = push();
    if (i < 0) return;
    const o = i * PRIM_FLOATS;
    data.fill(0, o, o + PRIM_FLOATS);
    data[o] = cx;
    data[o + 1] = cy;
    data[o + 2] = halfLength;
    data[o + 3] = fillet;
    data[o + 4] = Math.max(waist, -fillet);
    data[o + 5] = Math.max(1, NECK_K * settings.smoothness);
    data[o + 6] = 8;
    data[o + 7] = hue;
  }

  function segment(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    ra: number,
    rb: number,
    k: number,
    kind: number,
    hue: number,
    energy: number,
    erode: number,
  ) {
    const i = push();
    if (i < 0) return;
    const o = i * PRIM_FLOATS;
    data[o] = ax;
    data[o + 1] = ay;
    data[o + 2] = bx;
    data[o + 3] = by;
    data[o + 4] = Math.max(0, ra);
    data[o + 5] = Math.max(1, k * settings.smoothness);
    data[o + 6] = kind;
    data[o + 7] = hue;
    data[o + 8] = Math.max(0, rb);
    data[o + 9] = 0;
    data[o + 10] = 0;
    data[o + 11] = 0;
    data[o + 12] = erode;
    data[o + 13] = energy;
    data[o + 14] = 1;
    data[o + 15] = 0;
  }

  function bubble(x: number, y: number, radius: number, alpha: number) {
    if (bubbleCount >= MAX_BUBBLES || Math.abs(alpha) < 0.01) return;
    const o = bubbleCount++ * BUBBLE_FLOATS;
    bubbles[o] = x;
    bubbles[o + 1] = y;
    bubbles[o + 2] = radius;
    bubbles[o + 3] = alpha;
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
      splashed: false,
      offsetX: sample.offsetX,
      offsetY: sample.offsetY,
      scale: sample.scale,
      rest: 0,
      seen: true,
    };
  }

  function startDrip(blob: Blob) {
    // A card that has not finished entering has less liquid to lose.
    const grown = blob.enter === Infinity ? 1 : Math.min(1, Math.max(0, blob.grow));
    if (grown < 0.2) return;
    if (drips.length >= MAX_DRIPS) drips.shift();
    drips.push({
      hue: blob.hue,
      cx: blob.cx,
      cy: blob.cy,
      hw: blob.hw * grown,
      hh: blob.hh * grown,
      energy: blob.energy,
      calm: settings.reducedMotion,
      driftX: 0,
      driftVelocity: blob.vx * 0.25,
      age: 0,
      dropY: blob.cy + blob.hh * grown,
      dropVelocity: 0,
      dropRadius: 0,
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
    // Hover and press only scale a card, so they do not count as moving.
    const resting =
      blob.layer === 'grid' &&
      blob.lift === 0 &&
      blob.enter === Infinity &&
      !held &&
      Math.hypot(blob.vx, blob.vy) < 24 &&
      Math.abs(blob.melt) < 0.06;
    blob.rest = resting ? blob.rest + dt : 0;

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
    const radius = 0.42 * Math.min(blob.hw, blob.hh);
    const fallFrom = blob.cy - blob.hh - 90;
    if (t < ENTER_FALL) {
      const u = t / ENTER_FALL;
      const y = fallFrom + (blob.cy - fallFrom) * u * u;
      const velocity = (2 * (blob.cy - fallFrom) * u) / ENTER_FALL;
      const tail = Math.min(velocity * 0.03, 70);
      capsule(blob.cx, y - tail, blob.cx, y, radius * 0.55, radius * smoothstep(0, 0.4, u), K_DRIP, blob.layer, blob.hue, 1);
      return;
    }
    if (!blob.splashed) {
      blob.splashed = true;
      // A wide squash on impact, released through the jelly spring.
      blob.strainVelocity = [4, 0, -4];
    }
    const accel = GROW_OMEGA * GROW_OMEGA * (1 - blob.grow) - 2 * GROW_DAMPING * GROW_OMEGA * blob.growVelocity;
    blob.growVelocity += accel * dt;
    blob.grow += blob.growVelocity * dt;
    const grow = Math.min(blob.grow, 1.1);
    const settle = smoothstep(ENTER_FALL, ENTER_TOTAL, t);
    const hw = radius + (blob.hw - radius) * grow;
    const hh = radius + (blob.hh - radius) * grow;
    const blend = Math.min(1, Math.max(0, grow));
    rect({
      cx: blob.cx,
      cy: blob.cy,
      hw,
      hh,
      corner: radius + (corner - radius) * blend,
      k: k + K_DRIP * (1 - settle),
      layer: blob.layer,
      hue: blob.hue,
      energy: Math.max(energy, 1 - settle),
      rotation: blob.rotation,
      strain: blob.strain,
      wobble: wobbleOf(blob) * settle,
      seed: blob.seed,
    });
    // The last of the droplet sinks into the new body.
    const sink = 1 - smoothstep(ENTER_FALL, ENTER_FALL + 0.2, t);
    if (sink > 0) capsule(blob.cx, blob.cy, blob.cx, blob.cy, 0, radius * sink, K_DRIP, blob.layer, blob.hue, 1);
    if (t >= ENTER_TOTAL && Math.abs(blob.grow - 1) < 0.01 && Math.abs(blob.growVelocity) < 0.05) {
      blob.enter = Infinity;
      blob.grow = 1;
    }
  }

  function emitDrip(drip: Drip, dt: number): boolean {
    drip.age += dt;
    drip.driftVelocity *= Math.exp(-dt / 0.3);
    drip.driftX += drip.driftVelocity * dt;
    const cx = drip.cx + drip.driftX;
    const corner = Math.min(cornerRadius(2 * drip.hw, 2 * drip.hh), 0.3 * Math.min(drip.hw, drip.hh));
    if (drip.calm) {
      const u = smoothstep(0, 0.45, drip.age);
      rect({
        cx,
        cy: drip.cy,
        hw: drip.hw,
        hh: drip.hh,
        corner,
        k: K_REST,
        layer: 'grid',
        hue: drip.hue,
        energy: 0,
        erode: u * Math.min(drip.hw, drip.hh) * 1.05,
      });
      return drip.age < 0.45;
    }

    // The body drains downward: its top sinks, it narrows and rounds, then erodes.
    const u = easeInOut(clamp(drip.age / DRAIN, 0, 1));
    const bottom = drip.cy + drip.hh;
    const hh = Math.max(1, drip.hh * (1 - 0.9 * u));
    const hw = Math.max(1, drip.hw * (1 - 0.55 * u));
    const erode = smoothstep(0.7, 1, drip.age / DRAIN) * Math.min(hw, hh) * 1.2;
    rect({
      cx,
      cy: bottom - hh,
      hw,
      hh,
      corner: Math.min(hw, hh) * (0.3 + 0.7 * u) + corner * (1 - u),
      k: K_DRIP,
      layer: 'grid',
      hue: drip.hue,
      energy: Math.max(drip.energy, 0.6 * (1 - u)),
      erode,
    });

    // The drop grows at the bottom edge, necks, then lets go and falls.
    const grownRadius = Math.min(drip.hw * 0.32, 30);
    drip.dropRadius = grownRadius * smoothstep(0.1, 0.55, drip.age);
    if (drip.age < DRIP_RELEASE) {
      drip.dropY = bottom - drip.dropRadius * 0.4 + drip.dropRadius * 1.4 * smoothstep(0.2, DRIP_RELEASE, drip.age);
    } else {
      drip.dropVelocity += GRAVITY * dt;
      drip.dropY += drip.dropVelocity * dt;
    }
    const tail = Math.min(drip.dropVelocity * 0.035, 60) + drip.dropRadius * 0.5;
    capsule(cx, drip.dropY - tail, cx, drip.dropY, drip.dropRadius * 0.45, drip.dropRadius, K_DRIP, 'grid', drip.hue, 0.9);
    return drip.dropY - tail - drip.dropRadius < viewportHeight + 40 || drip.age < DRAIN;
  }

  /** The gap between a left and a right card, or NaN when they do not share a row. */
  function rowGap(left: Blob, right: Blob): number {
    const top = Math.max(left.cy - left.hh, right.cy - right.hh);
    const bottom = Math.min(left.cy + left.hh, right.cy + right.hh);
    if (bottom - top < NECK_OVERLAP * 2 * Math.min(left.hh, right.hh)) return Number.NaN;
    return right.cx - right.hw - (left.cx + left.hw);
  }

  const fits = (gap: number) => gap >= NECK_GAP_MIN && gap <= NECK_GAP_MAX;
  const resting = (blob: Blob | undefined, seconds: number): blob is Blob => !!blob && blob.rest > seconds;

  function updateNecks(dt: number) {
    const used = new Set<string>();
    for (const [key, neck] of necks) {
      const left = blobs.get(neck.left);
      const right = blobs.get(neck.right);
      const wanted = resting(left, 0) && resting(right, 0) && fits(rowGap(left, right));
      // A neck stretched past its range snaps at once instead of spanning the grid.
      const snapped = !left || !right || !(rowGap(left, right) <= NECK_GAP_MAX * 1.5);
      neck.grow = Math.min(1, neck.grow + (wanted ? dt / NECK_GROW : -dt / (snapped ? 0.08 : NECK_BREAK)));
      if (!left || !right || (!wanted && neck.grow <= 0)) {
        necks.delete(key);
        continue;
      }
      used.add(neck.left);
      used.add(neck.right);
    }
    if (necks.size >= MAX_NECKS) return;

    // Each resting card may neck with its nearest resting right-hand neighbour;
    // a hash of the pair decides which of those pairs get one, stable per pair.
    const candidates: { left: Blob; right: Blob; key: string; seed: number }[] = [];
    for (const left of blobs.values()) {
      if (!resting(left, NECK_REST) || used.has(left.id)) continue;
      let nearest: Blob | undefined;
      let nearestGap = Number.POSITIVE_INFINITY;
      for (const right of blobs.values()) {
        if (right === left || !resting(right, NECK_REST)) continue;
        const gap = rowGap(left, right);
        if (fits(gap) && gap < nearestGap) {
          nearest = right;
          nearestGap = gap;
        }
      }
      if (!nearest || used.has(nearest.id)) continue;
      const key = `${left.id}|${nearest.id}`;
      candidates.push({ left, right: nearest, key, seed: hashString(key) });
    }
    candidates.sort((a, b) => a.seed - b.seed);
    for (const { left, right, key, seed } of candidates) {
      if (necks.size >= MAX_NECKS) break;
      if (used.has(left.id) || used.has(right.id)) continue;
      used.add(left.id);
      used.add(right.id);
      necks.set(key, {
        left: left.id,
        right: right.id,
        height: 0.36 + 0.2 * unit(seed, 1),
        bead: unit(seed, 2) < 0.5 ? 0.3 + 0.4 * unit(seed, 3) : -1,
        seed,
        grow: 0,
      });
    }
  }

  function emitNeck(neck: Neck) {
    const left = blobs.get(neck.left)!;
    const right = blobs.get(neck.right)!;
    const top = Math.max(left.cy - left.hh, right.cy - right.hh);
    const bottom = Math.min(left.cy + left.hh, right.cy + right.hh);
    const y = top + (bottom - top) * neck.height;
    const edgeA = left.cx + left.hw;
    const edgeB = right.cx - right.hw;
    const gap = Math.max(1, edgeB - edgeA);
    // The flares scale with the gap, so a phone grid necks as finely as a desktop
    // one, and stop short of meeting over the bulging edges: a short straight
    // waist stays between them.
    const fillet = clamp(0.5 * gap - NECK_BULGE, 4, 12);
    const thickness = clamp(Math.min(left.hh, right.hh) * 0.034, 2.2, 4.5);
    const grow = easeInOut(clamp(neck.grow, 0, 1));
    const breathe = settings.reducedMotion ? 0 : 0.5 * Math.sin(flow * 1.7 + (neck.seed % 97));
    // Below zero the waist parts: two horns rise from the facing edges, meet in
    // the middle at zero and thicken into the neck; pinching runs it backwards.
    const waist = -fillet + (fillet + thickness + breathe) * grow;
    const hue = (left.hue + right.hue) / 2;
    bridge(edgeA + gap / 2, y, gap / 2 + NECK_INSET, fillet, waist, hue);
    if (neck.bead >= 0) {
      // The droplet blends with its own small radius, so it stays a bead on the neck.
      const grown = easeInOut(clamp((neck.grow - 0.55) / 0.45, 0, 1));
      const x = edgeA + gap * neck.bead;
      bead(x, y, -K_BEAD + (thickness + 2.2 + K_BEAD) * grown, K_BEAD, hue);
    }
  }

  function emitBubbles(blob: Blob) {
    const grown = blob.enter === Infinity ? 1 : blob.enter < ENTER_FALL ? 0 : clamp(blob.grow, 0, 1);
    const alpha = grown * (1 - 0.85 * smoothstep(0.05, 0.45, blob.energy)) * (blob.lift > 0.5 ? -1 : 1);
    if (Math.abs(alpha) < 0.01) return;
    const corner = cornerRadius(2 * blob.hw, 2 * blob.hh);
    const c = Math.cos(blob.rotation);
    const s = Math.sin(blob.rotation);
    const first = Math.floor(unit(blob.seed, 0) * 4);
    for (let cluster = 0; cluster < 2; cluster++) {
      const salt = 8 + cluster * 16;
      // Clusters sit in opposite corners; the second is a lone bubble on a card.
      const cornerIndex = (first + cluster * 2) % 4;
      const sx = cornerIndex & 1 ? 1 : -1;
      const sy = cornerIndex & 2 ? 1 : -1;
      // The chip sits at the top left: bubbles there run down the side edge.
      const alongSide = (sx < 0 && sy < 0) || unit(blob.seed, salt) < 0.5;
      const bubblesHere = cluster === 0 || blob.layer === 'panel' ? 2 : 1;
      let along = corner + 4 + unit(blob.seed, salt + 1) * (alongSide ? blob.hh : blob.hw) * 0.3;
      for (let i = 0; i < bubblesHere; i++) {
        const radius = i === 0 ? 2.6 + 1.9 * unit(blob.seed, salt + 2 + i) : 1.4 + 1 * unit(blob.seed, salt + 2 + i);
        const inset = radius + 6 + 3 * unit(blob.seed, salt + 5 + i);
        along += i === 0 ? radius : radius + 2.5 + 3 * unit(blob.seed, salt + 7 + i);
        const phase = unit(blob.seed, salt + 9 + i) * 6.283;
        const drift = settings.reducedMotion ? 0.5 : 2;
        const lx = (alongSide ? sx * (blob.hw - inset) : sx * (blob.hw - along)) + drift * Math.sin(flow * 0.53 + phase);
        const ly = (alongSide ? sy * (blob.hh - along) : sy * (blob.hh - inset)) + drift * Math.cos(flow * 0.41 + phase * 1.3);
        along += radius;
        bubble(blob.cx + c * lx - s * ly, blob.cy + s * lx + c * ly, radius, alpha);
      }
    }
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
      viewportHeight = viewport[1];
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

      // Cards arriving together fall in reading order, one after another.
      entering.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
      entering.forEach((blob, rank) => {
        blob.enter = -rank * ENTER_STAGGER;
      });

      for (const [id, blob] of blobs) {
        if (blob.seen) continue;
        blobs.delete(id);
        startDrip(blob);
      }
      updateNecks(step);

      count = 0;
      bubbleCount = 0;
      let panelHue = 0;
      let panelEnergy = 0;
      let panelLift = 0;
      for (const blob of blobs.values()) {
        emitBlob(blob, step);
        emitBubbles(blob);
        if (blob.lift > panelLift) {
          panelLift = blob.lift;
          panelHue = blob.hue;
          panelEnergy = Math.max(blob.energy, blob.hover * 0.55);
        }
      }
      for (const neck of necks.values()) emitNeck(neck);
      for (let i = drips.length - 1; i >= 0; i--) {
        if (!emitDrip(drips[i]!, step)) drips.splice(i, 1);
      }
      return { data, count, bubbles, bubbleCount, flow, panelHue, panelEnergy, panelLift };
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

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** FNV-1a: a stable seed per card id and per neck pair. */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/** A uniform number in [0, 1) from a seed and a salt (a murmur3 finaliser). */
function unit(seed: number, salt: number): number {
  let hash = Math.imul(seed ^ Math.imul(salt + 1, 0x9e3779b1), 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

/** field.wgsl reads the wobble phase and amplitude from one float: phase * 16 + amplitude. */
function wobbleCode(seed: number, amplitude: number): number {
  return (seed % 64) * 16 + clamp(amplitude, 0, 15.9);
}
