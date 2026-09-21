import { effect, sampler, target, type Frame, type Gpu, type Surface, type Target } from 'vgpu';

import bloomBlurWgsl from './bloom-blur.wgsl';
import bloomExtractWgsl from './bloom-extract.wgsl';
import compositeWgsl from './composite.wgsl';
import fieldWgsl from './field.wgsl';
import type { QualityTier } from './quality';
import type { TierResources } from './quality-controller';

type Output = Surface | Target;

/** What each tier costs. Low is a real cheaper pipeline, not just a lower resolution. */
export const TIER_SETTINGS = {
  high: { steps: 48, bloom: true },
  low: { steps: 16, bloom: false },
} as const satisfies Record<QualityTier, { steps: number; bloom: boolean }>;

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const CLEAR = [0, 0, 0, 1] as const;

export interface Scene extends TierResources {
  readonly tier: QualityTier;
  resize(size: readonly [number, number]): void;
  render(currentFrame: Frame, time: number): void;
}

/**
 * High: field → HDR target → bright pass → two half-res blurs → tone-mapped composite.
 * Low: field straight to the output with in-shader tone mapping and a third of the march steps.
 */
export function createScene(gpu: Gpu, output: Output, tier: QualityTier): Scene {
  const settings = TIER_SETTINGS[tier];
  const owned: Target[] = [];
  const own = (created: Target) => {
    owned.push(created);
    return created;
  };
  const destroyOwned = () => {
    for (const created of owned.reverse()) destroyTarget(created);
    owned.length = 0;
  };

  try {
    const [width, height] = output.size;
    const field = effect(gpu, fieldWgsl, {
      label: `adaptive-quality-field-${tier}`,
      set: { params: { time: 0, aspect: width / height, steps: settings.steps, tonemap: settings.bloom ? 0 : 1 } },
    });

    if (!settings.bloom) {
      return {
        tier,
        prepare: () => field.compile({ colors: [output.format] }).then(() => undefined),
        resize: (size) => field.set({ params: { aspect: size[0] / size[1] } }),
        render: (currentFrame, time) => {
          field.set({ params: { time } });
          currentFrame.pass({ target: output, clear: CLEAR }, field);
        },
        destroy: destroyOwned,
      };
    }

    const samp = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });
    const scene = own(target(gpu, { size: [width, height], format: HDR_FORMAT }));
    const bloom = [
      own(target(gpu, { size: bloomSize([width, height]), format: HDR_FORMAT })),
      own(target(gpu, { size: bloomSize([width, height]), format: HDR_FORMAT })),
    ] as const;
    const extract = effect(gpu, bloomExtractWgsl, { set: { samp, src: scene } });
    const blurH = effect(gpu, bloomBlurWgsl, {
      set: { samp, src: bloom[0], blur: { texelSize: bloom[0].texelSize, direction: [1, 0] } },
    });
    const blurV = effect(gpu, bloomBlurWgsl, {
      set: { samp, src: bloom[1], blur: { texelSize: bloom[1].texelSize, direction: [0, 1] } },
    });
    const composite = effect(gpu, compositeWgsl, { set: { samp, scene, bloom: bloom[0] } });

    const compileAll = (): Promise<void> =>
      Promise.all([
        field.compile(scene),
        extract.compile(bloom[0]),
        blurH.compile(bloom[1]),
        blurV.compile(bloom[0]),
        composite.compile({ colors: [output.format] }),
      ]).then(() => undefined);

    return {
      tier,
      prepare: compileAll,
      resize: (size) => {
        scene.resize(size);
        const half = bloomSize(size);
        bloom[0].resize(half);
        bloom[1].resize(half);
        field.set({ params: { aspect: size[0] / size[1] } });
        blurH.set({ blur: { texelSize: bloom[0].texelSize } });
        blurV.set({ blur: { texelSize: bloom[1].texelSize } });
      },
      render: (currentFrame, time) => {
        field.set({ params: { time } });
        currentFrame.pass({ target: scene, clear: CLEAR }, field);
        currentFrame.pass({ target: bloom[0], clear: CLEAR }, extract);
        currentFrame.pass({ target: bloom[1], clear: CLEAR }, blurH);
        currentFrame.pass({ target: bloom[0], clear: CLEAR }, blurV);
        currentFrame.pass({ target: output, clear: CLEAR }, composite);
      },
      destroy: destroyOwned,
    };
  } catch (error) {
    destroyOwned();
    throw error;
  }
}

function bloomSize(size: readonly [number, number]): [number, number] {
  return [Math.max(1, Math.round(size[0] / 2)), Math.max(1, Math.round(size[1] / 2))];
}

function destroyTarget(color: Target): void {
  (color as { destroy?: () => void }).destroy?.();
}
