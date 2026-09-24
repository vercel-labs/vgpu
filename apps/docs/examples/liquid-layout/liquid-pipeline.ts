// GPU resources and the per-frame chain shared by the browser renderer and the
// thumbnail: backdrop and liquid distance field at CSS-pixel resolution →
// glass shading at device resolution → bloom (half- and quarter-resolution
// Gaussian pairs) → composite (ACES, vignette, dither) into the output. The
// module imports nothing DOM-bound.

import { effect, sampler, target, type Frame, type Gpu, type Surface, type Target } from 'vgpu';

import type { LiquidFrame } from './liquid-dynamics';
import { MAX_PRIMS } from './liquid-dynamics';
import backdropWgsl from './backdrop.wgsl';
import blurWgsl from './blur.wgsl';
import brightWgsl from './bright.wgsl';
import compositeWgsl from './composite.wgsl';
import fieldWgsl from './field.wgsl';
import shadeWgsl from './shade.wgsl';

type Output = Surface | Target;
type Size = readonly [number, number];

const CLEAR = [0, 0, 0, 1] as const;
const FORMAT = 'rgba16float' as const;
const PRIM_VECTORS = MAX_PRIMS * 4;

// Half-resolution pair for a tight halo, quarter-resolution pair for the wide glow.
const BLURS = [
  { direction: [1, 0], radius: 1.3 },
  { direction: [0, 1], radius: 1.3 },
  { direction: [1, 0], radius: 2.4 },
  { direction: [0, 1], radius: 2.4 },
] as const;

export interface Look {
  /** Refraction offset at the steepest part of the bevel, in CSS px. */
  readonly refraction: number;
  /** Per-channel spread of the refraction offset (0 = no dispersion). */
  readonly dispersion: number;
  /** Bevel width in CSS px. */
  readonly bevel: number;
  readonly bloom: number;
  readonly exposure: number;
}

export const DEFAULT_LOOK: Look = {
  refraction: 26,
  dispersion: 0.18,
  bevel: 24,
  bloom: 0.6,
  exposure: 1.05,
};

export interface SceneInput {
  /** Seconds, drives the aurora and the caustics. */
  readonly time: number;
  readonly liquid: LiquidFrame;
  /** Key light in CSS px; z is its height above the glass. */
  readonly light: readonly [number, number, number];
  /** 0..1: dims the grid and the room while a card is open. */
  readonly dim: number;
  /** Caustic animation rate; lower under reduced motion. */
  readonly causticSpeed: number;
}

export interface LiquidPipeline {
  /** `size` is the output size in device px; the field runs at `size / dpr`. */
  resize(size: Size, dpr: number): void;
  setLook(look: Partial<Look>): void;
  update(input: SceneInput): void;
  encode(currentFrame: Frame, output: Output): void;
  prewarm(output: Output): Promise<void>;
}

export function cssSize(size: Size, dpr: number): [number, number] {
  const ratio = Math.max(dpr, 1e-3);
  return [Math.max(1, Math.round(size[0] / ratio)), Math.max(1, Math.round(size[1] / ratio))];
}

function scaled(size: Size, divisor: number): [number, number] {
  return [Math.max(1, Math.round(size[0] / divisor)), Math.max(1, Math.round(size[1] / divisor))];
}

export function createPipeline(gpu: Gpu, size: Size, dpr: number, initialLook: Look = DEFAULT_LOOK): LiquidPipeline {
  let look = { ...initialLook };
  let ratio = dpr;
  let css = cssSize(size, dpr);

  const targets = {
    backdrop: target(gpu, { size: css, format: FORMAT, label: 'liquid-layout-backdrop' }),
    field: target(gpu, { size: css, format: FORMAT, label: 'liquid-layout-field' }),
    scene: target(gpu, { size, format: FORMAT, label: 'liquid-layout-scene' }),
    near: [
      target(gpu, { size: scaled(size, 2), format: FORMAT, label: 'liquid-layout-near-a' }),
      target(gpu, { size: scaled(size, 2), format: FORMAT, label: 'liquid-layout-near-b' }),
    ] as const,
    far: [
      target(gpu, { size: scaled(size, 4), format: FORMAT, label: 'liquid-layout-far-a' }),
      target(gpu, { size: scaled(size, 4), format: FORMAT, label: 'liquid-layout-far-b' }),
    ] as const,
  };

  // near-a → near-b → near-a → far-a → far-b
  const blurSources = [targets.near[0], targets.near[1], targets.near[0], targets.far[0]] as const;

  const samp = sampler(gpu, {
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  // The field uniform takes the primitive array as 128 vec4f views over the
  // dynamics buffer, rebuilt only if the dynamics hands over a new buffer.
  let primSource: Float32Array | null = null;
  let primViews: Float32Array[] = [];
  const views = (data: Float32Array) => {
    if (data !== primSource) {
      primSource = data;
      primViews = Array.from({ length: PRIM_VECTORS }, (_, i) => data.subarray(i * 4, i * 4 + 4));
    }
    return primViews;
  };

  // Initial struct values must be complete; bind() writes the real sizes.
  const effects = {
    backdrop: effect(gpu, backdropWgsl, {
      label: 'liquid-layout-backdrop',
      set: { backdrop: { viewport: css, time: 0, dim: 0 } },
    }),
    field: effect(gpu, fieldWgsl, {
      label: 'liquid-layout-field',
      set: { field: { viewport: css, count: 0, pad: 0, prims: views(new Float32Array(PRIM_VECTORS * 4)) } },
    }),
    shade: effect(gpu, shadeWgsl, {
      label: 'liquid-layout-shade',
      set: {
        fieldTex: targets.field,
        backdropTex: targets.backdrop,
        samp,
        shade: {
          viewport: css,
          fieldTexel: targets.field.texelSize,
          light: [css[0] * 0.3, css[1] * 0.2, 420],
          time: 0,
          dpr,
          refraction: look.refraction,
          dispersion: look.dispersion,
          bevel: look.bevel,
          gridDim: 0,
          panelHue: 0,
          panelEnergy: 0,
          panelLift: 0,
          causticSpeed: 0.35,
        },
      },
    }),
    bright: effect(gpu, brightWgsl, {
      label: 'liquid-layout-bright',
      set: { src: targets.scene, samp, bright: { threshold: 0.75, smoothing: 0.9 } },
    }),
    blur: BLURS.map((options, i) =>
      effect(gpu, blurWgsl, {
        label: `liquid-layout-blur-${i}`,
        set: { src: blurSources[i]!, samp, blur: { ...options, texelSize: [1, 1] } },
      }),
    ),
    composite: effect(gpu, compositeWgsl, {
      label: 'liquid-layout-composite',
      set: {
        scene: targets.scene,
        bloomNear: targets.near[0],
        bloomFar: targets.far[1],
        samp,
        composite: { aspect: size[0] / Math.max(1, size[1]), bloom: look.bloom, exposure: look.exposure, vignette: 0.32 },
      },
    }),
  };

  const bind = (outputSize: Size) => {
    effects.backdrop.set({ backdrop: { viewport: css } });
    effects.field.set({ field: { viewport: css } });
    effects.shade.set({ shade: { viewport: css, fieldTexel: targets.field.texelSize, dpr: ratio } });
    effects.blur.forEach((blur, i) => blur.set({ blur: { texelSize: blurSources[i]!.texelSize } }));
    effects.composite.set({ composite: { aspect: outputSize[0] / Math.max(1, outputSize[1]) } });
  };
  bind(size);

  return {
    resize(nextSize, nextDpr) {
      ratio = nextDpr;
      css = cssSize(nextSize, nextDpr);
      // Effects bind the Target objects, so resized attachments follow automatically.
      targets.backdrop.resize(css);
      targets.field.resize(css);
      targets.scene.resize(nextSize);
      targets.near[0].resize(scaled(nextSize, 2));
      targets.near[1].resize(scaled(nextSize, 2));
      targets.far[0].resize(scaled(nextSize, 4));
      targets.far[1].resize(scaled(nextSize, 4));
      bind(nextSize);
    },
    setLook(next) {
      look = { ...look, ...next };
      effects.shade.set({ shade: { refraction: look.refraction, dispersion: look.dispersion, bevel: look.bevel } });
      effects.composite.set({ composite: { bloom: look.bloom, exposure: look.exposure } });
    },
    update(input) {
      const { liquid } = input;
      effects.backdrop.set({ backdrop: { time: input.time, dim: input.dim } });
      effects.field.set({ field: { count: liquid.count, prims: views(liquid.data) } });
      effects.shade.set({
        shade: {
          light: input.light,
          time: input.time,
          gridDim: input.dim,
          panelHue: liquid.panelHue,
          panelEnergy: liquid.panelEnergy,
          panelLift: liquid.panelLift,
          causticSpeed: input.causticSpeed,
        },
      });
    },
    encode(currentFrame, output) {
      currentFrame.pass({ target: targets.backdrop, clear: CLEAR }, (pass) => pass.draw(effects.backdrop));
      currentFrame.pass({ target: targets.field, clear: CLEAR }, (pass) => pass.draw(effects.field));
      currentFrame.pass({ target: targets.scene, clear: CLEAR }, (pass) => pass.draw(effects.shade));
      currentFrame.pass({ target: targets.near[0], clear: CLEAR }, (pass) => pass.draw(effects.bright));
      currentFrame.pass({ target: targets.near[1], clear: CLEAR }, (pass) => pass.draw(effects.blur[0]!));
      currentFrame.pass({ target: targets.near[0], clear: CLEAR }, (pass) => pass.draw(effects.blur[1]!));
      currentFrame.pass({ target: targets.far[0], clear: CLEAR }, (pass) => pass.draw(effects.blur[2]!));
      currentFrame.pass({ target: targets.far[1], clear: CLEAR }, (pass) => pass.draw(effects.blur[3]!));
      currentFrame.pass({ target: output, clear: CLEAR }, (pass) => pass.draw(effects.composite));
    },
    async prewarm(output) {
      await Promise.all([
        effects.backdrop.compile(targets.backdrop),
        effects.field.compile(targets.field),
        effects.shade.compile(targets.scene),
        effects.bright.compile(targets.near[0]),
        effects.blur[0]!.compile(targets.near[1]),
        effects.blur[1]!.compile(targets.near[0]),
        effects.blur[2]!.compile(targets.far[0]),
        effects.blur[3]!.compile(targets.far[1]),
        effects.composite.compile({ colors: [output.format] }),
      ]);
    },
  };
}
