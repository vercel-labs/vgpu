// GPU resources and the per-frame chain shared by the browser renderer and the
// thumbnail: backdrop at device resolution (its grid is hairlines) and the
// liquid distance field at CSS-pixel resolution → glass shading at device
// resolution → a faint quarter-resolution bloom →
// composite (ACES, vignette, dither) into the output. Seven passes, one frame. The module
// imports nothing DOM-bound.

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

// The bloom runs at a quarter of the output size; the blur steps 0.6 of its
// texels (2.4 device px) for a tight halo.
const BLOOM_DIVISOR = 4;
const BLURS = [
  { direction: [1, 0], radius: 0.6 },
  { direction: [0, 1], radius: 0.6 },
] as const;

export interface Look {
  /** Bezel width (CSS px): how far inside the edge the glass curves. */
  readonly refraction: number;
  /** Per-channel spread of the refraction offset (0 = no dispersion). */
  readonly dispersion: number;
  /** Lens band width in CSS px. */
  readonly lens: number;
  readonly bloom: number;
  readonly exposure: number;
}

export const DEFAULT_LOOK: Look = {
  refraction: 8,
  dispersion: 0.02,
  lens: 20,
  bloom: 0.06,
  exposure: 1.0,
};

export interface SceneInput {
  /** Also carries the flow clock that animates the wobble and the backdrop. */
  readonly liquid: LiquidFrame;
  /** Key light in CSS px; z is its height above the glass. */
  readonly light: readonly [number, number, number];
  /** 0..1: dims the grid and the room while a card is open. */
  readonly dim: number;
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
    backdrop: target(gpu, { size, format: FORMAT, label: 'liquid-layout-backdrop' }),
    field: target(gpu, { size: css, format: FORMAT, label: 'liquid-layout-field' }),
    scene: target(gpu, { size, format: FORMAT, label: 'liquid-layout-scene' }),
    bloom: [
      target(gpu, { size: scaled(size, BLOOM_DIVISOR), format: FORMAT, label: 'liquid-layout-bloom-a' }),
      target(gpu, { size: scaled(size, BLOOM_DIVISOR), format: FORMAT, label: 'liquid-layout-bloom-b' }),
    ] as const,
  };

  // bloom-a → bloom-b → bloom-a
  const blurSources = [targets.bloom[0], targets.bloom[1]] as const;

  const samp = sampler(gpu, {
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  // Uniform arrays take one vec4f view per element over the dynamics buffers,
  // rebuilt only if the dynamics hands over a new buffer.
  const vectorViews = (length: number) => {
    let source: Float32Array | null = null;
    let list: Float32Array[] = [];
    return (data: Float32Array) => {
      if (data !== source) {
        source = data;
        list = Array.from({ length }, (_, i) => data.subarray(i * 4, i * 4 + 4));
      }
      return list;
    };
  };
  const views = vectorViews(PRIM_VECTORS);

  // Initial struct values must be complete; bind() writes the real sizes.
  const effects = {
    backdrop: effect(gpu, backdropWgsl, {
      label: 'liquid-layout-backdrop',
      set: { backdrop: { viewport: css, time: 0, dim: 0, dpr } },
    }),
    field: effect(gpu, fieldWgsl, {
      label: 'liquid-layout-field',
      set: { field: { viewport: css, count: 0, time: 0, prims: views(new Float32Array(PRIM_VECTORS * 4)) } },
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
          dpr,
          refraction: look.refraction,
          dispersion: look.dispersion,
          lens: look.lens,
          gridDim: 0,
          panelHue: 0,
          panelEnergy: 0,
          panelLift: 0,
        },
      },
    }),
    bright: effect(gpu, brightWgsl, {
      label: 'liquid-layout-bright',
      set: { src: targets.scene, samp, bright: { texelSize: targets.scene.texelSize, threshold: 1.0, smoothing: 0.5 } },
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
        bloomTex: targets.bloom[0],
        samp,
        composite: { aspect: size[0] / Math.max(1, size[1]), bloom: look.bloom, exposure: look.exposure, vignette: 0.16 },
      },
    }),
  };

  const bind = (outputSize: Size) => {
    effects.backdrop.set({ backdrop: { viewport: css, dpr: ratio } });
    effects.field.set({ field: { viewport: css } });
    effects.shade.set({ shade: { viewport: css, fieldTexel: targets.field.texelSize, dpr: ratio } });
    effects.bright.set({ bright: { texelSize: targets.scene.texelSize } });
    effects.blur.forEach((blur, i) => blur.set({ blur: { texelSize: blurSources[i]!.texelSize } }));
    effects.composite.set({ composite: { aspect: outputSize[0] / Math.max(1, outputSize[1]) } });
  };
  bind(size);

  return {
    resize(nextSize, nextDpr) {
      ratio = nextDpr;
      css = cssSize(nextSize, nextDpr);
      // Effects bind the Target objects, so resized attachments follow automatically.
      targets.backdrop.resize(nextSize);
      targets.field.resize(css);
      targets.scene.resize(nextSize);
      targets.bloom[0].resize(scaled(nextSize, BLOOM_DIVISOR));
      targets.bloom[1].resize(scaled(nextSize, BLOOM_DIVISOR));
      bind(nextSize);
    },
    setLook(next) {
      look = { ...look, ...next };
      effects.shade.set({ shade: { refraction: look.refraction, dispersion: look.dispersion, lens: look.lens } });
      effects.composite.set({ composite: { bloom: look.bloom, exposure: look.exposure } });
    },
    update(input) {
      const { liquid } = input;
      // A bezel wider than a corner's radius would reach the fold in the
      // rounded rect's field along the corner diagonal and draw a seam there.
      const lens = Math.max(4, Math.min(look.lens, liquid.minCorner - 1));
      effects.backdrop.set({ backdrop: { time: liquid.flow, dim: input.dim } });
      effects.field.set({ field: { count: liquid.count, time: liquid.flow, prims: views(liquid.data) } });
      effects.shade.set({
        shade: {
          light: input.light,
          gridDim: input.dim,
          panelHue: liquid.panelHue,
          panelEnergy: liquid.panelEnergy,
          panelLift: liquid.panelLift,
          lens,
          // The bend narrows with the bezel, so a small card's edge still
          // magnifies instead of mirroring.
          refraction: (look.refraction * lens) / look.lens,
        },
      });
    },
    encode(currentFrame, output) {
      currentFrame.pass({ target: targets.backdrop, clear: CLEAR }, (pass) => pass.draw(effects.backdrop));
      currentFrame.pass({ target: targets.field, clear: CLEAR }, (pass) => pass.draw(effects.field));
      currentFrame.pass({ target: targets.scene, clear: CLEAR }, (pass) => pass.draw(effects.shade));
      currentFrame.pass({ target: targets.bloom[0], clear: CLEAR }, (pass) => pass.draw(effects.bright));
      currentFrame.pass({ target: targets.bloom[1], clear: CLEAR }, (pass) => pass.draw(effects.blur[0]!));
      currentFrame.pass({ target: targets.bloom[0], clear: CLEAR }, (pass) => pass.draw(effects.blur[1]!));
      currentFrame.pass({ target: output, clear: CLEAR }, (pass) => pass.draw(effects.composite));
    },
    async prewarm(output) {
      await Promise.all([
        effects.backdrop.compile(targets.backdrop),
        effects.field.compile(targets.field),
        effects.shade.compile(targets.scene),
        effects.bright.compile(targets.bloom[0]),
        effects.blur[0]!.compile(targets.bloom[1]),
        effects.blur[1]!.compile(targets.bloom[0]),
        effects.composite.compile({ colors: [output.format] }),
      ]);
    },
  };
}
