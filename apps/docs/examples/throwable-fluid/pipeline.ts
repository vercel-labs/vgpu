// The per-frame chain shared by the page and the thumbnail: the orb's swept
// segment and splashes (CSS pixels, as the DOM reports them) are converted to
// the solver's units, the fluid steps once or twice, and the composite draws
// the lit ink and the glass orb into the output. The module imports nothing
// DOM-bound.

import { effect, type Frame, type Gpu, type Surface, type Target } from 'vgpu';

import compositeWgsl from './composite.wgsl';
import { createFluid, fluidSize, type FluidParams, type Quality, type Vec2, type Vec3 } from './fluid';

type Output = Surface | Target;

export const PALETTES = {
  Aurora: [
    [0.05, 0.9, 0.75],
    [0.1, 0.35, 1.0],
    [0.55, 0.15, 1.0],
    [1.0, 0.1, 0.55],
  ],
  Ember: [
    [1.0, 0.35, 0.05],
    [1.0, 0.7, 0.1],
    [0.9, 0.08, 0.05],
    [1.0, 0.85, 0.35],
  ],
  Lagoon: [
    [0.0, 0.6, 1.0],
    [0.0, 0.95, 0.6],
    [0.2, 0.3, 0.9],
    [0.6, 0.95, 1.0],
  ],
  Ink: [
    [0.55, 0.65, 0.85],
    [0.8, 0.85, 0.95],
    [0.35, 0.45, 0.75],
    [0.7, 0.75, 0.8],
  ],
} as const satisfies Record<string, readonly Vec3[]>;

export type PaletteName = keyof typeof PALETTES;
export const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];

/** A smooth cyclic blend through the palette; `phase` 1 is one full lap. */
export function paletteColor(name: PaletteName, phase: number): [number, number, number] {
  const colors = PALETTES[name];
  const position = (((phase % 1) + 1) % 1) * colors.length;
  const index = Math.floor(position);
  const a = colors[index % colors.length]!;
  const b = colors[(index + 1) % colors.length]!;
  const t = position - index;
  const s = t * t * (3 - 2 * t);
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

export interface OrbFrame {
  /** Visual centre at the previous and the current frame, CSS px from the canvas's top-left. */
  readonly from: Vec2;
  readonly to: Vec2;
  /** CSS px per second. */
  readonly velocity: Vec2;
  /** Radius including the hover/press scale, CSS px. */
  readonly radius: number;
  /** Squashed radii against a wall, CSS px. */
  readonly radii: Vec2;
  /** 0 resting .. 1 fully lifted by the press spring. */
  readonly lift: number;
  readonly visible: boolean;
}

export interface SplashFrame {
  /** Contact point, CSS px. */
  readonly point: Vec2;
  /** CSS px. */
  readonly radius: number;
  /** Fluid thrown back off the wall, CSS px per second. */
  readonly jet: Vec2;
  /** Swirl one radius from the centre, CSS px per second. */
  readonly swirl: number;
  readonly amount: number;
  /** 0 bursts the ink round the point; more lays that many arms around it. */
  readonly arms: number;
  /** Where the first arm points, radians. */
  readonly turn: number;
}

export interface Look {
  readonly refraction: number;
  readonly dispersion: number;
}

export interface Scene {
  readonly dt: number;
  /** Canvas size in CSS px. */
  readonly view: Vec2;
  readonly orb: OrbFrame;
  readonly splash: SplashFrame | null;
  readonly palette: PaletteName;
  /** Palette position of this frame's ink. */
  readonly phase: number;
  /** Ink laid per orb diameter travelled. */
  readonly ink: number;
  /** Share of the fluid under the orb pulled to its velocity per 1/60 s. */
  readonly drag: number;
  readonly params: FluidParams;
  readonly look: Look;
}

export interface Pipeline {
  /** Output size in physical px. */
  resize(size: Vec2): void;
  setQuality(quality: Quality): void;
  prewarm(output: Output): Promise<void>;
  /** Steps the fluid with this frame's stroke and splash. */
  simulate(currentFrame: Frame, scene: Scene): void;
  /** Draws the ink and the glass orb into the output. */
  draw(currentFrame: Frame, output: Output, scene: Scene): void;
}

export interface PipelineOptions {
  /** Output size in physical px. */
  readonly size: Vec2;
  readonly quality: Quality;
}

/** Ink laid per orb diameter travelled. */
export const INK = 0.9;
/** Velocity damping of the fluid, per second. */
export const FLUID_DAMPING = 0.35;

/** What the page starts with; the thumbnail renders with it too. */
export const DEFAULT_TUNING = {
  viscosity: 0.03,
  dissipation: 0.3,
  vorticity: 22,
  palette: 'Aurora' as PaletteName,
  quality: 'medium' as Quality,
  refraction: 1.4,
  dispersion: 1,
};

const SPLASH_COLOR_GAIN = 1.6;
/** Ink brightens with speed up to this many CSS px per second. */
const BRIGHT_SPEED = 2000;
/** Frames slower than this take two solver substeps so fast throws stay continuous. */
const SUBSTEP_DT = 1 / 45;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export function createPipeline(gpu: Gpu, options: PipelineOptions): Pipeline {
  let size = options.size;
  let quality = options.quality;
  const fluid = createFluid(gpu, fluidSize(size[0], size[1], quality));

  const view = {
    size,
    dyeTexel: fluid.dye[0].texelSize,
    orbCenter: [0, 0] as Vec2,
    orbRadii: [1, 1] as Vec2,
    orbRadius: 1,
    lift: 0,
    refraction: 1,
    dispersion: 1,
    gridSpacing: 28,
    pixelRatio: 1,
    orbVisible: 0,
    inkGain: 1,
  };
  const composites = fluid.dye.map((dye, i) =>
    effect(gpu, compositeWgsl, {
      label: `throwable-fluid-composite-${i}`,
      set: { dye, samp: fluid.sampler, view },
    }),
  );

  const refit = () => fluid.resize(fluidSize(size[0], size[1], quality));

  return {
    resize(next) {
      size = next;
      refit();
    },
    setQuality(next) {
      quality = next;
      refit();
    },
    async prewarm(output) {
      await Promise.all([fluid.prewarm(), ...composites.map((composite) => composite.compile({ colors: [output.format] }))]);
    },
    simulate(currentFrame, scene) {
      const { orb, view: css } = scene;
      const grid = fluid.size.grid;
      const aspect = css[0] / Math.max(1, css[1]);
      const texelsPerPx: Vec2 = [grid[0] / Math.max(1, css[0]), grid[1] / Math.max(1, css[1])];
      const uv = (p: Vec2): Vec2 => [p[0] / Math.max(1, css[0]), p[1] / Math.max(1, css[1])];
      const radius = orb.radius / Math.max(1, css[1]);
      const velocity: Vec2 = [orb.velocity[0] * texelsPerPx[0], orb.velocity[1] * texelsPerPx[1]];
      const speed = Math.hypot(orb.velocity[0], orb.velocity[1]);
      const brightness = 0.5 + 0.5 * clamp01(speed / BRIGHT_SPEED);
      const color = paletteColor(scene.palette, scene.phase);
      const [r, g, b] = paletteColor(scene.palette, scene.phase + 0.5);
      const splashColor: Vec3 = [r * SPLASH_COLOR_GAIN, g * SPLASH_COLOR_GAIN, b * SPLASH_COLOR_GAIN];

      const substeps = scene.dt > SUBSTEP_DT ? 2 : 1;
      const dt = scene.dt / substeps;
      const drag = orb.visible ? 1 - Math.pow(1 - clamp01(scene.drag), dt * 60) : 0;
      for (let i = 0; i < substeps; i++) {
        const from = lerp2(orb.from, orb.to, i / substeps);
        const to = lerp2(orb.from, orb.to, (i + 1) / substeps);
        const travelled = Math.hypot(to[0] - from[0], to[1] - from[1]);
        const splash = i === 0 ? scene.splash : null;
        fluid.step(currentFrame, {
          dt,
          aspect,
          params: scene.params,
          stroke: {
            from: uv(from),
            to: uv(to),
            velocity,
            radius: radius * 0.9,
            drag,
            amount: orb.visible ? scene.ink * clamp01(travelled / (2 * orb.radius)) * brightness : 0,
            color,
          },
          splash: splash && {
            center: uv(splash.point),
            radius: splash.radius / Math.max(1, css[1]),
            jet: [splash.jet[0] * texelsPerPx[1], splash.jet[1] * texelsPerPx[1]],
            swirl: splash.swirl * texelsPerPx[1],
            amount: splash.amount,
            color: splashColor,
            arms: splash.arms,
            turn: splash.turn,
          },
        });
      }
    },
    draw(currentFrame, output, scene) {
      const { orb, view: css } = scene;
      const ratio = output.size[0] / Math.max(1, css[0]);
      const composite = composites[fluid.current]!;
      composite.set({
        view: {
          size: output.size,
          dyeTexel: fluid.dye[fluid.current].texelSize,
          orbCenter: [orb.to[0] * ratio, orb.to[1] * ratio],
          orbRadii: [orb.radii[0] * ratio, orb.radii[1] * ratio],
          orbRadius: orb.radius * ratio,
          lift: orb.lift,
          refraction: scene.look.refraction,
          dispersion: scene.look.dispersion,
          gridSpacing: 28 * ratio,
          pixelRatio: ratio,
          orbVisible: orb.visible ? 1 : 0,
          inkGain: 1,
        },
      });
      currentFrame.pass(output, composite);
    },
  };
}
