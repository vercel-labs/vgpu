// A self-contained 2D Navier–Stokes solver on half-float render targets,
// shared by the page and the thumbnail. Every field is a Target and every
// pass is a full-screen effect whose texture bindings never change: each
// read/write pairing has its own effect, and the step order below is fixed so
// that velocity and pressure always end a step in their first target. Only
// the dye alternates, and the composite keeps one effect per dye target.
// The module imports nothing DOM-bound.

import {
  effect,
  frame,
  sampler,
  target,
  type Effect,
  type EffectOptions,
  type Frame,
  type Gpu,
  type ShaderSource,
  type Target,
} from 'vgpu';

import advectDyeWgsl from './advect-dye.wgsl';
import advectVelocityWgsl from './advect-velocity.wgsl';
import carryWgsl from './carry.wgsl';
import curlWgsl from './curl.wgsl';
import divergenceWgsl from './divergence.wgsl';
import pressureWgsl from './pressure.wgsl';
import projectWgsl from './project.wgsl';

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export type Quality = 'low' | 'medium' | 'high';

/** Grid cells across the short side of the canvas. */
export const QUALITY_CELLS: Record<Quality, number> = { low: 96, medium: 144, high: 216 };

export const PRESSURE_ITERATIONS = 20;
/** Grid texels per second. */
const MAX_SPEED = 900;
const MAX_LONG_SIDE = 3;
const PRESSURE_WARM_START = 0.8;

export interface FluidSize {
  readonly grid: Vec2;
  readonly dye: Vec2;
}

/**
 * Grid and dye sizes for an output of `width`×`height` physical pixels. The
 * grid keeps the canvas aspect so cells stay square; the dye runs 2–4× finer,
 * never much finer than the pixels it lands on.
 */
export function fluidSize(width: number, height: number, quality: Quality): FluidSize {
  const cells = QUALITY_CELLS[quality];
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const long = Math.min(MAX_LONG_SIDE, Math.max(w, h) / Math.min(w, h));
  const grid: [number, number] =
    w >= h ? [Math.round(cells * long), cells] : [cells, Math.round(cells * long)];
  const scale = Math.min(4, Math.max(2, (Math.min(w, h) * 0.85) / cells));
  return { grid, dye: [Math.round(grid[0] * scale), Math.round(grid[1] * scale)] };
}

export interface FluidParams {
  /** Explicit diffusion weight per step (stable below 0.25). */
  readonly viscosity: number;
  readonly vorticity: number;
  /** Dye fade rate, per second. */
  readonly dissipation: number;
  /** Velocity damping rate, per second. */
  readonly damping: number;
}

/** The orb's contribution to one step, in uv (top-left origin) and grid texels. */
export interface Stroke {
  readonly from: Vec2;
  readonly to: Vec2;
  /** Grid texels per second. */
  readonly velocity: Vec2;
  /** Canvas-height units. */
  readonly radius: number;
  /** Share of the fluid velocity pulled to the orb's velocity this step. */
  readonly drag: number;
  readonly amount: number;
  readonly color: Vec3;
}

export interface Splash {
  readonly center: Vec2;
  /** Canvas-height units. */
  readonly radius: number;
  /** Grid texels per second thrown back into the field. */
  readonly jet: Vec2;
  /** Grid texels per second of swirl one radius from the centre. */
  readonly swirl: number;
  readonly amount: number;
  readonly color: Vec3;
  /** 0 bursts the ink round the centre; more lays that many arms around it. */
  readonly arms: number;
  /** Where the first arm points, radians. */
  readonly turn: number;
}

export interface StepInput {
  readonly dt: number;
  /** Canvas width / height. */
  readonly aspect: number;
  readonly params: FluidParams;
  readonly stroke: Stroke;
  readonly splash: Splash | null;
}

export interface Fluid {
  readonly size: FluidSize;
  readonly sampler: ReturnType<typeof sampler>;
  /** Both dye targets; `current` is the index holding the latest dye. */
  readonly dye: readonly [Target, Target];
  readonly current: 0 | 1;
  step(currentFrame: Frame, input: StepInput): void;
  /** Resizes every field, stretching velocity and dye into the new size. Call outside a frame. */
  resize(next: FluidSize): void;
  prewarm(): Promise<void>;
}

const NO_SPLASH: Splash = {
  center: [-10, -10],
  radius: 0.1,
  jet: [0, 0],
  swirl: 0,
  amount: 0,
  color: [0, 0, 0],
  arms: 0,
  turn: 0,
};

export function createFluid(gpu: Gpu, initial: FluidSize): Fluid {
  let size = initial;
  let current: 0 | 1 = 0;

  const field = (name: string, format: GPUTextureFormat, fieldSize: Vec2) =>
    target(gpu, { size: fieldSize, format, label: `throwable-fluid-${name}` });
  const velocity = [field('velocity-a', 'rg16float', size.grid), field('velocity-b', 'rg16float', size.grid)] as const;
  const pressure = [field('pressure-a', 'r16float', size.grid), field('pressure-b', 'r16float', size.grid)] as const;
  const curl = field('curl', 'r16float', size.grid);
  const divergence = field('divergence', 'r16float', size.grid);
  const dye = [field('dye-a', 'rgba16float', size.dye), field('dye-b', 'rgba16float', size.dye)] as const;

  const samp = sampler(gpu, {
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  const gridUniform = () => ({ size: size.grid, texel: [1 / size.grid[0], 1 / size.grid[1]] as Vec2 });
  const grid = gridUniform();
  const stir = {
    segmentStart: [0.5, 0.5] as Vec2,
    segmentEnd: [0.5, 0.5] as Vec2,
    orbVelocity: [0, 0] as Vec2,
    splashCenter: NO_SPLASH.center,
    splashJet: NO_SPLASH.jet,
    radius: 0.05,
    drag: 0,
    splashRadius: NO_SPLASH.radius,
    splashSwirl: 0,
    aspect: 1,
    dt: 1 / 60,
    vorticity: 0,
    viscosity: 0,
    dissipation: 0,
    maxSpeed: MAX_SPEED,
  };
  const ink = {
    segmentStart: [0.5, 0.5] as Vec2,
    segmentEnd: [0.5, 0.5] as Vec2,
    splashCenter: NO_SPLASH.center,
    radius: 0.05,
    amount: 0,
    color: [0, 0, 0] as Vec3,
    splashAmount: 0,
    splashColor: [0, 0, 0] as Vec3,
    splashRadius: NO_SPLASH.radius,
    splashArms: 0,
    splashTurn: 0,
    aspect: 1,
    dt: 1 / 60,
    dissipation: 0,
  };

  const pass = (label: string, shader: ShaderSource, set: EffectOptions['set']) =>
    effect(gpu, shader, { label: `throwable-fluid-${label}`, set });
  const pressurePass = (label: string, from: Target, warm: number) =>
    pass(label, pressureWgsl, { pressure: from, divergence, samp, grid, jacobi: { warm } });
  const dyePass = (label: string, from: Target) => pass(label, advectDyeWgsl, { dye: from, velocity: velocity[0], samp, grid, ink });
  const carryPass = (label: string, from: Target) => pass(label, carryWgsl, { source: from, samp, carry: { scale: [1, 1, 1, 1] } });

  // Reads → writes, in step order. Velocity: V0 → V1 → V0. Pressure ends in P0.
  const effects = {
    curl: pass('curl', curlWgsl, { velocity: velocity[0], samp, grid }), // V0 → curl
    advectVelocity: pass('advect-velocity', advectVelocityWgsl, { velocity: velocity[0], curl, samp, grid, stir }), // V0 → V1
    divergence: pass('divergence', divergenceWgsl, { velocity: velocity[1], samp, grid }), // V1 → div
    pressureFirst: pressurePass('pressure-first', pressure[0], PRESSURE_WARM_START), // P0 → P1
    pressureToA: pressurePass('pressure-to-a', pressure[1], 1), // P1 → P0
    pressureToB: pressurePass('pressure-to-b', pressure[0], 1), // P0 → P1
    project: pass('project', projectWgsl, { velocity: velocity[1], pressure: pressure[0], samp, grid }), // V1 → V0
    advectDye: [dyePass('advect-dye-a', dye[0]), dyePass('advect-dye-b', dye[1])] as const, // D0 → D1, D1 → D0
    carryVelocity: [carryPass('carry-velocity-a', velocity[0]), carryPass('carry-velocity-b', velocity[1])] as const,
    carryDye: [carryPass('carry-dye-a', dye[0]), carryPass('carry-dye-b', dye[1])] as const,
  };
  const gridBound: Effect[] = [
    effects.curl,
    effects.advectVelocity,
    effects.divergence,
    effects.pressureFirst,
    effects.pressureToA,
    effects.pressureToB,
    effects.project,
    ...effects.advectDye,
  ];

  const step = (currentFrame: Frame, input: StepInput) => {
    const { dt, aspect, params, stroke } = input;
    const splash = input.splash ?? NO_SPLASH;
    effects.advectVelocity.set({
      stir: {
        segmentStart: stroke.from,
        segmentEnd: stroke.to,
        orbVelocity: stroke.velocity,
        splashCenter: splash.center,
        splashJet: splash.jet,
        radius: stroke.radius,
        drag: stroke.drag,
        splashRadius: splash.radius,
        splashSwirl: splash.swirl,
        aspect,
        dt,
        vorticity: params.vorticity,
        viscosity: params.viscosity,
        dissipation: params.damping,
      },
    });
    const advectDye = effects.advectDye[current];
    advectDye.set({
      ink: {
        segmentStart: stroke.from,
        segmentEnd: stroke.to,
        splashCenter: splash.center,
        radius: stroke.radius,
        amount: stroke.amount,
        color: stroke.color,
        splashAmount: splash.amount,
        splashColor: splash.color,
        splashRadius: splash.radius * 0.8,
        splashArms: splash.arms,
        splashTurn: splash.turn,
        aspect,
        dt,
        dissipation: params.dissipation,
      },
    });

    currentFrame.pass(curl, effects.curl);
    currentFrame.pass(velocity[1], effects.advectVelocity);
    currentFrame.pass(divergence, effects.divergence);
    currentFrame.pass(pressure[1], effects.pressureFirst);
    for (let i = 1; i < PRESSURE_ITERATIONS; i++) {
      if (i % 2 === 1) currentFrame.pass(pressure[0], effects.pressureToA);
      else currentFrame.pass(pressure[1], effects.pressureToB);
    }
    currentFrame.pass(velocity[0], effects.project);
    const next = current === 0 ? 1 : 0;
    currentFrame.pass(dye[next], advectDye);
    current = next;
  };

  const resize = (next: FluidSize) => {
    const previous = size;
    size = next;
    const sameGrid = previous.grid[0] === next.grid[0] && previous.grid[1] === next.grid[1];
    const sameDye = previous.dye[0] === next.dye[0] && previous.dye[1] === next.dye[1];
    if (sameGrid && sameDye) return;
    const other = current === 0 ? 1 : 0;
    // Velocity is in grid texels per second, so it scales with the grid.
    effects.carryVelocity[0].set({
      carry: { scale: [next.grid[0] / previous.grid[0], next.grid[1] / previous.grid[1], 1, 1] },
    });
    // A resize destroys a target's old texture at once, so the stretch copy
    // runs in two submitted frames: out of each live field into its resized
    // twin, then back into the live one once that has been resized too.
    velocity[1].resize(next.grid);
    dye[other].resize(next.dye);
    frame(gpu, (currentFrame) => {
      currentFrame.pass(velocity[1], effects.carryVelocity[0]);
      currentFrame.pass(dye[other], effects.carryDye[current]);
    });
    velocity[0].resize(next.grid);
    dye[current].resize(next.dye);
    frame(gpu, (currentFrame) => {
      currentFrame.pass(velocity[0], effects.carryVelocity[1]);
      currentFrame.pass(dye[current], effects.carryDye[other]);
    });
    if (!sameGrid) {
      for (const fieldTarget of [pressure[0], pressure[1], curl, divergence]) fieldTarget.resize(next.grid);
      const uniform = gridUniform();
      for (const gridEffect of gridBound) gridEffect.set({ grid: uniform });
    }
  };

  return {
    get size() {
      return size;
    },
    sampler: samp,
    dye,
    get current() {
      return current;
    },
    step,
    resize,
    async prewarm() {
      await Promise.all([
        effects.curl.compile(curl),
        effects.advectVelocity.compile(velocity[1]),
        effects.divergence.compile(divergence),
        effects.pressureFirst.compile(pressure[1]),
        effects.pressureToA.compile(pressure[0]),
        effects.pressureToB.compile(pressure[1]),
        effects.project.compile(velocity[0]),
        effects.advectDye[0].compile(dye[1]),
        effects.advectDye[1].compile(dye[0]),
        effects.carryVelocity[0].compile(velocity[1]),
        effects.carryVelocity[1].compile(velocity[0]),
        effects.carryDye[0].compile(dye[1]),
        effects.carryDye[1].compile(dye[0]),
      ]);
    },
  };
}
