import {
  effect,
  sampler,
  target,
  type Frame,
  type Gpu,
  type Target,
} from 'vgpu';

import jfaInitWgsl from './jfa-init.wgsl';
import jfaPassWgsl from './jfa-pass.wgsl';
import radianceCascadeWgsl from './radiance-cascade.wgsl';
import rcEmitterWgsl from './rc-emitter.wgsl';
import rcResolveWgsl from './rc-resolve.wgsl';
import sdfFinalizeWgsl from './sdf-finalize.wgsl';

const HDR_FORMAT = 'rgba16float' as const;
// Seeds store absolute pixel coordinates; f16 loses texels past 2048.
const SEED_FORMAT = 'rgba32float' as const;
// The light field is low-frequency, so it runs well below canvas resolution.
const MAX_HEIGHT = 288;

export function radianceFieldSize(
  screen: readonly [number, number],
): readonly [number, number] {
  const height = Math.max(1, Math.min(MAX_HEIGHT, screen[1]));
  return [
    Math.max(1, Math.round((height * screen[0]) / Math.max(1, screen[1]))),
    height,
  ];
}

export function radianceJumps(size: readonly [number, number]): readonly number[] {
  const jumpCount = Math.ceil(Math.log2(Math.max(size[0], size[1], 2)));
  return [
    ...Array.from({ length: jumpCount }, (_, index) =>
      Math.max(1, 2 ** (jumpCount - index - 1)),
    ),
    1,
    1,
  ];
}

export function radianceCascadeCount(size: readonly [number, number]): number {
  return Math.min(
    6,
    Math.max(
      5,
      Math.ceil(Math.log(1 + (3 * Math.hypot(size[0], size[1])) / 2) / Math.log(4)),
    ),
  );
}

export function createRadiance(gpu: Gpu, screen: readonly [number, number]) {
  const size = radianceFieldSize(screen);
  const cascadeCount = radianceCascadeCount(size);
  const spacing = 2 ** (cascadeCount - 1);
  const atlas: readonly [number, number] = [
    Math.ceil(size[0] / spacing) * spacing * 2,
    Math.ceil(size[1] / spacing) * spacing * 2,
  ];
  const jumps = radianceJumps(size);
  const owned: Target[] = [];
  const own = (created: Target) => {
    owned.push(created);
    return created;
  };

  try {
    const emitter = own(target(gpu, { size, format: HDR_FORMAT }));
    const jfa: readonly [Target, Target] = [
      own(target(gpu, { size, format: SEED_FORMAT })),
      own(target(gpu, { size, format: SEED_FORMAT })),
    ];
    const sdf = own(target(gpu, { size, format: HDR_FORMAT }));
    // Two atlases are recycled from the top of the hierarchy down.
    const cascades: readonly [Target, Target] = [
      own(target(gpu, { size: atlas, format: HDR_FORMAT })),
      own(target(gpu, { size: atlas, format: HDR_FORMAT })),
    ];
    const irradiance = own(target(gpu, { size, format: HDR_FORMAT }));
    const samp = sampler(gpu, {
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    return {
      size,
      cascadeCount,
      jumps,
      emitter,
      jfa,
      sdf,
      cascades,
      irradiance,
      samp,
      effects: {
        emitter: effect(gpu, rcEmitterWgsl, { set: { samp } }),
        jfaInit: effect(gpu, jfaInitWgsl),
        // Uniforms upload immediately, so every encoded pass needs its own effect.
        jfaSteps: jumps.map(() => effect(gpu, jfaPassWgsl)),
        sdfFinalize: effect(gpu, sdfFinalizeWgsl),
        cascade: Array.from({ length: cascadeCount }, () =>
          effect(gpu, radianceCascadeWgsl),
        ),
        resolve: effect(gpu, rcResolveWgsl),
      },
    };
  } catch (error) {
    for (const created of owned.reverse()) {
      (created as { destroy?: () => void }).destroy?.();
    }
    throw error;
  }
}

export type Radiance = ReturnType<typeof createRadiance>;

export function destroyRadiance(radiance: Radiance): void {
  const targets = [
    radiance.irradiance,
    radiance.cascades[1],
    radiance.cascades[0],
    radiance.sdf,
    radiance.jfa[1],
    radiance.jfa[0],
    radiance.emitter,
  ];
  for (const created of targets) {
    (created as { destroy?: () => void }).destroy?.();
  }
}

export function setRadianceScene(radiance: Radiance, scene: Target): void {
  const aspect = radiance.size[0] / radiance.size[1];
  radiance.effects.emitter.set({ scene, params: { aspect } });
}

export function setRadianceTime(radiance: Radiance, time: number): void {
  radiance.effects.emitter.set({ params: { time } });
}

export async function prewarmRadiance(radiance: Radiance): Promise<void> {
  const { effects } = radiance;
  await Promise.all([
    effects.emitter.compile(radiance.emitter),
    effects.jfaInit.compile(radiance.jfa[0]),
    ...effects.jfaSteps.map((pass) => pass.compile(radiance.jfa[0])),
    effects.sdfFinalize.compile(radiance.sdf),
    ...effects.cascade.map((pass) => pass.compile(radiance.cascades[0])),
    effects.resolve.compile(radiance.irradiance),
  ]);
}

// Encodes the whole light-field chain into the current frame:
// emitters → jump flood → SDF → cascades (top-down) → irradiance resolve.
export function encodeRadiance(frame: Frame, radiance: Radiance): void {
  const { effects, samp } = radiance;
  const clear = [0, 0, 0, 0] as const;

  frame.pass({ target: radiance.emitter, clear }, (pass) =>
    pass.draw(effects.emitter),
  );

  effects.jfaInit.set({ emitter: radiance.emitter });
  frame.pass({ target: radiance.jfa[0], clear }, (pass) =>
    pass.draw(effects.jfaInit),
  );

  let seedRead = radiance.jfa[0];
  let seedWrite = radiance.jfa[1];
  radiance.jumps.forEach((jump, index) => {
    const pass = effects.jfaSteps[index]!;
    pass.set({ jfa: { jump: [jump, 0, 0, 0] }, seeds: seedRead });
    frame.pass({ target: seedWrite, clear }, (encoder) => encoder.draw(pass));
    [seedRead, seedWrite] = [seedWrite, seedRead];
  });

  effects.sdfFinalize.set({ seeds: seedRead });
  frame.pass({ target: radiance.sdf, clear }, (pass) =>
    pass.draw(effects.sdfFinalize),
  );

  let atlasWrite = radiance.cascades[0];
  let atlasRead = radiance.cascades[1];
  for (let cascade = radiance.cascadeCount - 1; cascade >= 0; cascade--) {
    const pass = effects.cascade[cascade]!;
    pass.set({
      rc: { state: [cascade, cascade < radiance.cascadeCount - 1 ? 1 : 0, 0, 0] },
      sdf_tex: radiance.sdf,
      sdf_samp: samp,
      emitter_tex: radiance.emitter,
      emitter_samp: samp,
      upper_tex: atlasRead,
    });
    frame.pass({ target: atlasWrite, clear }, (encoder) => encoder.draw(pass));
    [atlasRead, atlasWrite] = [atlasWrite, atlasRead];
  }

  effects.resolve.set({ cascade_tex: atlasRead, field_tex: radiance.emitter });
  frame.pass({ target: radiance.irradiance, clear }, (pass) =>
    pass.draw(effects.resolve),
  );
}
