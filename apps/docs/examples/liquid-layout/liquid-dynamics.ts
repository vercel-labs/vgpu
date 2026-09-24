// Pure per-frame liquid dynamics. The renderer measures the laid-out cards and
// hands over one sample per card; this module turns them into the primitives
// the field shader blends: rounded rects for card bodies, tapered capsules for
// tethers and droplets. It owns everything the DOM does not have: speed-driven
// softness, a jelly strain spring, drips for cards that leave, splashes for
// cards that arrive and the tether behind a dragged card. Bodies merge within
// their layer: the grid, or the top layer that floats over it and holds the open
// panel, a held card and a card flying back to its slot. No DOM, no GPU.

import type { Layer } from './layout-store';

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
  /** Calmer path: no stretch, no wobble, fades instead of drips and splashes. */
  reducedMotion: boolean;
}

export interface LiquidFrame {
  readonly data: Float32Array;
  readonly count: number;
  /** Tint, energy and opacity of the top layer, taken from its most lifted blob. */
  readonly panelHue: number;
  readonly panelEnergy: number;
  readonly panelLift: number;
  /** 0 at rest; rises with speed, drips and tethers. Drives the caustics. */
  readonly activity: number;
}

type Strain = [number, number, number];

interface Blob {
  readonly id: string;
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
   * 0 in the grid layer, 1 in the top layer (the open panel, a dragged card, a
   * card flying back). Eases, so a blob fades between layers instead of popping.
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
  seen: boolean;
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

// Rest corner radius and the smooth-min radius range (CSS px). The rest radius
// stays well under half the grid gap so resting cards never touch; the moving
// radius bridges neighbours that pass within ~20 px of each other.
export const CORNER = 22;
export const PANEL_CORNER = 30;
export const K_REST = 6;
export const K_MOVING = 46;
// Half-size (CSS px) below which a card's moving radius scales down with it.
const REACH_SIZE = 120;
const K_TETHER = 26;
const K_DRIP = 30;

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
const MAX_DRIPS = 10;

const TETHER_START = 4;
const LIFT_TAU = 0.06;
// A held card keeps most of its shape: its copy is still on it.
const DRAG_MELT = 0.25;

// Flying cards melt: they shrink by up to MELT_SHRINK and round off, so passing
// cards neck and bridge instead of fusing into one slab.
const MELT_SHRINK = 0.14;
const MELT_OMEGA = 2 * Math.PI * 5;
const MELT_DAMPING = 0.55;

export function createDynamics(options: DynamicsOptions) {
  const settings: DynamicsOptions = { ...options };
  const blobs = new Map<string, Blob>();
  const drips: Drip[] = [];
  const data = new Float32Array(MAX_PRIMS * PRIM_FLOATS);
  let count = 0;
  let viewportHeight = 1;

  const push = (): number => (count < MAX_PRIMS ? count++ : -1);

  function rect(
    cx: number,
    cy: number,
    hw: number,
    hh: number,
    corner: number,
    k: number,
    layer: Layer,
    hue: number,
    energy: number,
    rotation = 0,
    strain: Strain = [0, 0, 0],
    erode = 0,
  ) {
    const i = push();
    if (i < 0 || hw <= 0.5 || hh <= 0.5) {
      if (i >= 0) count--;
      return;
    }
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
    data[o] = cx;
    data[o + 1] = cy;
    data[o + 2] = hw;
    data[o + 3] = hh;
    data[o + 4] = Math.min(corner, hw, hh);
    data[o + 5] = Math.max(1, k * settings.smoothness);
    data[o + 6] = layer === 'panel' ? 2 : 0;
    data[o + 7] = hue;
    data[o + 8] = m00;
    data[o + 9] = m01;
    data[o + 10] = m10;
    data[o + 11] = m11;
    data[o + 12] = erode;
    data[o + 13] = energy;
    data[o + 14] = distScale;
    data[o + 15] = 0;
  }

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
    erode = 0,
  ) {
    if (ra <= 0.25 && rb <= 0.25) return;
    const i = push();
    if (i < 0) return;
    const o = i * PRIM_FLOATS;
    data[o] = ax;
    data[o + 1] = ay;
    data[o + 2] = bx;
    data[o + 3] = by;
    data[o + 4] = Math.max(0, ra);
    data[o + 5] = Math.max(1, k * settings.smoothness);
    data[o + 6] = layer === 'panel' ? 3 : 1;
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

  function createBlob(sample: CardSample): Blob {
    return {
      id: sample.id,
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

    const held = tethered(blob);
    const liftTarget = sample.lifted || held ? 1 : 0;
    blob.lift = teleport ? liftTarget : blob.lift + (liftTarget - blob.lift) * (1 - Math.exp(-dt / LIFT_TAU));
    if (Math.abs(liftTarget - blob.lift) < 0.01) blob.lift = liftTarget;

    const speed = Math.hypot(blob.vx, blob.vy) + 0.6 * (Math.abs(blob.vw) + Math.abs(blob.vh));
    const target = 1 - Math.exp(-speed / 700);
    const tau = target > blob.energy ? 0.05 : 0.45;
    blob.energy += (target - blob.energy) * (1 - Math.exp(-dt / tau));
    blob.hover += ((sample.hovered ? 1 : 0) - blob.hover) * (1 - Math.exp(-dt / 0.12));

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

  function emitBlob(blob: Blob, dt: number) {
    const corner = blob.layer === 'panel' ? PANEL_CORNER : Math.min(CORNER, 0.3 * Math.min(blob.hw, blob.hh));
    const hover = blob.hover * 0.55;
    const energy = Math.max(blob.energy, hover);
    // Bridges follow the melt, not the raw speed: a card rounds off before it
    // reaches for its neighbours, and lets go as soon as it lands.
    // Small cards on small screens reach proportionally, so a phone grid bridges
    // rather than fusing into one puddle.
    const reach = clamp(blob.melt, 0, 1) * clamp(Math.min(blob.hw, blob.hh) / REACH_SIZE, 0.55, 1);
    const k = K_REST + K_MOVING * reach * reach;

    // Tether: a dragged card lifts off a puddle in its slot and stays joined to
    // it by a rope of liquid that thins as it stretches and sags a little.
    if (tethered(blob)) {
      const offset = Math.hypot(blob.offsetX, blob.offsetY);
      const scale = Math.max(0.5, blob.scale);
      const sx = blob.cx - blob.offsetX;
      const sy = blob.cy - blob.offsetY;
      const shrink = 1 - 0.55 * smoothstep(10, 260, offset);
      const phw = (blob.hw / scale) * shrink;
      const phh = (blob.hh / scale) * shrink;
      const tension = smoothstep(0, 300, offset);
      rect(sx, sy, phw, phh, Math.min(phw, phh) * (0.35 + 0.55 * tension), K_TETHER, 'grid', blob.hue, 0.25 + 0.5 * tension);
      const radius = clamp(290 / Math.sqrt(offset), 8, 34) * smoothstep(TETHER_START, 36, offset);
      const sag = Math.min(offset * 0.16, 56) * (0.4 + 0.6 * Math.abs(blob.offsetX) / offset);
      const mx = (sx + blob.cx) / 2;
      const my = (sy + blob.cy) / 2 + sag;
      capsule(sx, sy, mx, my, radius * 1.3, radius * 0.72, K_TETHER, 'grid', blob.hue, 0.4 + 0.5 * tension);
      capsule(mx, my, blob.cx, blob.cy, radius * 0.72, radius * 1.05, K_TETHER, 'grid', blob.hue, 0.4 + 0.5 * tension);
    }

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
      rect(
        blob.cx + (settings.reducedMotion ? 0 : lagX),
        blob.cy + (settings.reducedMotion ? 0 : lagY),
        hw,
        hh,
        corner + (0.92 * Math.min(hw, hh) - corner) * round,
        k,
        layer,
        blob.hue,
        energy,
        blob.rotation,
        blob.strain,
      );
    // Between layers the body is in both: the top copy fades in (or out) over
    // the grid copy, which stays whole until the lift completes.
    if (blob.lift < 1) body('grid');
    if (blob.lift > 0) body('panel');
  }

  function tethered(blob: Blob): boolean {
    return blob.layer === 'grid' && blob.enter === Infinity && Math.hypot(blob.offsetX, blob.offsetY) > TETHER_START;
  }

  function emitEntering(blob: Blob, corner: number, k: number, energy: number, dt: number) {
    const t = blob.enter;
    if (t < 0) return;
    if (settings.reducedMotion) {
      const grow = smoothstep(0, 0.35, t);
      blob.grow = grow;
      if (t >= 0.35) blob.enter = Infinity;
      rect(blob.cx, blob.cy, blob.hw, blob.hh, corner, k, blob.layer, blob.hue, energy, blob.rotation, undefined, (1 - grow) * 22);
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
    rect(
      blob.cx,
      blob.cy,
      hw,
      hh,
      radius + (corner - radius) * blend,
      k + K_DRIP * (1 - settle),
      blob.layer,
      blob.hue,
      Math.max(energy, 1 - settle),
      blob.rotation,
      blob.strain,
    );
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
    const corner = Math.min(CORNER, 0.3 * Math.min(drip.hw, drip.hh));
    if (drip.calm) {
      const u = smoothstep(0, 0.45, drip.age);
      rect(cx, drip.cy, drip.hw, drip.hh, corner, K_REST, 'grid', drip.hue, 0, 0, undefined, u * Math.min(drip.hw, drip.hh) * 1.05);
      return drip.age < 0.45;
    }

    // The body drains downward: its top sinks, it narrows and rounds, then erodes.
    const u = easeInOut(clamp(drip.age / DRAIN, 0, 1));
    const bottom = drip.cy + drip.hh;
    const hh = Math.max(1, drip.hh * (1 - 0.9 * u));
    const hw = Math.max(1, drip.hw * (1 - 0.55 * u));
    const erode = smoothstep(0.7, 1, drip.age / DRAIN) * Math.min(hw, hh) * 1.2;
    const energy = Math.max(drip.energy, 0.6 * (1 - u));
    rect(cx, bottom - hh, hw, hh, Math.min(hw, hh) * (0.3 + 0.7 * u) + corner * (1 - u), K_DRIP, 'grid', drip.hue, energy, 0, undefined, erode);

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

  return {
    get options(): Readonly<DynamicsOptions> {
      return settings;
    },
    setOptions(next: Partial<DynamicsOptions>) {
      Object.assign(settings, next);
    },
    /** Forget velocities, e.g. after a resize moved every card at once. */
    reset() {
      for (const blob of blobs.values()) {
        blob.vx = blob.vy = blob.vw = blob.vh = 0;
        blob.strain = [0, 0, 0];
        blob.strainVelocity = [0, 0, 0];
      }
    },
    /**
     * Advances by `dt` seconds. `viewport` is the canvas size in CSS px; pass
     * `teleport` when every card moved for a reason other than animation.
     */
    update(samples: readonly CardSample[], dt: number, viewport: readonly [number, number], teleport = false): LiquidFrame {
      const step = clamp(dt, 1 / 1000, 1 / 20);
      viewportHeight = viewport[1];
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

      count = 0;
      let panelHue = 0;
      let panelEnergy = 0;
      let panelLift = 0;
      let activity = 0;
      for (const blob of blobs.values()) {
        emitBlob(blob, step);
        activity = Math.max(activity, blob.energy);
        if (blob.lift > panelLift) {
          panelLift = blob.lift;
          panelHue = blob.hue;
          panelEnergy = Math.max(blob.energy, blob.hover * 0.55);
        }
      }
      for (let i = drips.length - 1; i >= 0; i--) {
        if (!emitDrip(drips[i]!, step)) drips.splice(i, 1);
      }
      if (drips.length > 0) activity = Math.max(activity, 0.6);
      return { data, count, panelHue, panelEnergy, panelLift, activity };
    },
    get dripCount() {
      return drips.length;
    },
    get blobCount() {
      return blobs.size;
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
