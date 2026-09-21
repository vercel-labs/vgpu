import {
  effect,
  frame,
  sampler,
  target,
  type Effect,
  type Gpu,
  type Surface,
  type Target,
} from "vgpu";

import type { PaintSegment } from "./pointer-input";
import jfaInitWgsl from "./jfa-init.wgsl";
import jfaPassWgsl from "./jfa-pass.wgsl";
import paintEmitterWgsl from "./paint-emitter.wgsl";
import presentWgsl from "./present.wgsl";
import radianceCascadeWgsl from "./radiance-cascade.wgsl";
import sdfFinalizeWgsl from "./sdf-finalize.wgsl";

type Output = Surface | Target;
type Vec2 = readonly [number, number];

export type RadianceView =
  | "final"
  | "emitters"
  | "sdf"
  | `cascade-${0 | 1 | 2 | 3 | 4 | 5}`;

const HDR_FORMAT: GPUTextureFormat = "rgba16float";
// Seeds store absolute pixel coordinates, which need f32 precision past 2048.
const SEED_FORMAT: GPUTextureFormat = "rgba32float";
const RC_INTERVAL0 = 2;
const TRIANGLE_SCALE = 0.11;

function resolveView(view: RadianceView, cascadeCount: number) {
  if (view === "emitters") return { mode: 1, stopAt: 0 } as const;
  if (view === "sdf") return { mode: 2, stopAt: 0 } as const;
  if (view.startsWith("cascade-")) {
    return {
      mode: 3,
      stopAt: Math.min(Number(view.slice(8)), cascadeCount - 1),
    } as const;
  }
  return { mode: 0, stopAt: 0 } as const;
}

function strokeRadiance(index: number): readonly [number, number, number] {
  const hue = (index * 0.381966) % 1;
  const channel = (offset: number) => {
    const value = Math.abs(((hue + offset) % 1) * 6 - 3) - 1;
    return (0.25 + 0.75 * Math.min(1, Math.max(0, value))) * 2.7;
  };
  return [channel(0), channel(2 / 3), channel(1 / 3)];
}

export function createScene(gpu: Gpu, requestedSize: Vec2) {
  const width = Math.max(1, Math.floor(requestedSize[0]));
  const height = Math.max(1, Math.floor(requestedSize[1]));
  const size: Vec2 = [width, height];
  const cascadeCount = Math.min(
    6,
    Math.max(
      5,
      Math.ceil(
        Math.log(1 + (3 * Math.hypot(width, height)) / RC_INTERVAL0) /
          Math.log(4)
      )
    )
  );
  const spacing = 2 ** (cascadeCount - 1);
  const atlas: Vec2 = [
    Math.ceil(width / spacing) * spacing * 2,
    Math.ceil(height / spacing) * spacing * 2,
  ];
  const jumpCount = Math.ceil(Math.log2(Math.max(width, height, 2)));
  const jumps = [
    ...Array.from({ length: jumpCount }, (_, index) =>
      Math.max(1, 2 ** (jumpCount - index - 1))
    ),
    1,
    1,
  ];
  const created: Target[] = [];
  const own = (resource: Target) => {
    created.push(resource);
    return resource;
  };

  try {
    const emitter: [Target, Target] = [
      own(target(gpu, { size, format: HDR_FORMAT })),
      own(target(gpu, { size, format: HDR_FORMAT })),
    ];
    const jfa: [Target, Target] = [
      own(target(gpu, { size, format: SEED_FORMAT })),
      own(target(gpu, { size, format: SEED_FORMAT })),
    ];
    const sdf = own(target(gpu, { size, format: HDR_FORMAT }));
    // Two atlases are recycled from the top of the hierarchy down.
    const cascades: [Target, Target] = [
      own(target(gpu, { size: atlas, format: HDR_FORMAT })),
      own(target(gpu, { size: atlas, format: HDR_FORMAT })),
    ];
    return {
      gpu,
      size,
      atlas,
      cascadeCount,
      jumps,
      emitter,
      jfa,
      sdf,
      cascades,
      effects: {
        paint: effect(gpu, paintEmitterWgsl),
        jfaInit: effect(gpu, jfaInitWgsl),
        // Uniforms are uploaded immediately, so every encoded pass needs its own effect.
        jfaSteps: jumps.map(() => effect(gpu, jfaPassWgsl)),
        sdfFinalize: effect(gpu, sdfFinalizeWgsl),
        cascade: Array.from({ length: cascadeCount }, () =>
          effect(gpu, radianceCascadeWgsl)
        ),
        present: effect(gpu, presentWgsl),
      },
      sampler: sampler(gpu, {
        minFilter: "linear",
        magFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      }),
    };
  } catch (error) {
    try {
      destroyTargets(created);
    } catch {
      // Preserve the allocation error after best-effort rollback.
    }
    throw error;
  }
}

export type RadianceScene = ReturnType<typeof createScene>;

export async function prepareScene(
  scene: RadianceScene,
  outputFormat: GPUTextureFormat
): Promise<void> {
  await Promise.all([
    scene.effects.paint.compile({ colors: [HDR_FORMAT] }),
    scene.effects.jfaInit.compile({ colors: [SEED_FORMAT] }),
    ...scene.effects.jfaSteps.map((shader) =>
      shader.compile({ colors: [SEED_FORMAT] })
    ),
    scene.effects.sdfFinalize.compile({ colors: [HDR_FORMAT] }),
    ...scene.effects.cascade.map((shader) =>
      shader.compile({ colors: [HDR_FORMAT] })
    ),
    scene.effects.present.compile({ colors: [outputFormat] }),
  ]);
}

export function destroyScene(scene: RadianceScene): void {
  destroyTargets([
    ...scene.emitter,
    ...scene.jfa,
    scene.sdf,
    ...scene.cascades,
  ]);
}

function destroyTargets(targets: readonly Target[]): void {
  let firstError: unknown;
  for (let index = targets.length - 1; index >= 0; index--) {
    try {
      (targets[index] as Target & { destroy?: () => void }).destroy?.();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

export interface ChainOptions {
  readonly segment?: PaintSegment;
  readonly keepPrevious?: boolean;
  readonly view?: RadianceView;
}

function buildChain(scene: RadianceScene, options: ChainOptions) {
  const { size, effects } = scene;
  const stopAt = resolveView(
    options.view ?? "final",
    scene.cascadeCount
  ).stopAt;
  const segment = options.segment;
  const passes: { readonly target: Target; readonly effect: Effect }[] = [];

  const [emitterRead, emitterWrite] = scene.emitter;
  const color = strokeRadiance(segment?.stroke ?? 0);
  effects.paint.set({
    paint: {
      stroke_from: segment
        ? [segment.from[0] * size[0], segment.from[1] * size[1]]
        : [0, 0],
      stroke_to: segment
        ? [segment.to[0] * size[0], segment.to[1] * size[1]]
        : [0, 0],
      color: [color[0], color[1], color[2], segment ? 1 : 0],
      flags: [
        options.keepPrevious ?? true ? 1 : 0,
        Math.min(size[0], size[1]) * TRIANGLE_SCALE,
        0,
        0,
      ],
    },
    previous: emitterRead,
  });
  passes.push({ target: emitterWrite, effect: effects.paint });
  scene.emitter = [emitterWrite, emitterRead];

  effects.jfaInit.set({ emitter: emitterWrite });
  passes.push({ target: scene.jfa[0], effect: effects.jfaInit });

  let seedRead = scene.jfa[0];
  let seedWrite = scene.jfa[1];
  scene.jumps.forEach((jump, index) => {
    const shader = effects.jfaSteps[index]!;
    shader.set({
      jfa: { jump: [jump, 0, 0, 0] },
      seeds: seedRead,
    });
    passes.push({ target: seedWrite, effect: shader });
    [seedRead, seedWrite] = [seedWrite, seedRead];
  });
  scene.jfa = [seedRead, seedWrite];

  effects.sdfFinalize.set({ seeds: seedRead });
  passes.push({ target: scene.sdf, effect: effects.sdfFinalize });

  let atlasWrite = scene.cascades[0];
  let atlasRead = scene.cascades[1];
  for (let cascade = scene.cascadeCount - 1; cascade >= stopAt; cascade--) {
    const shader = effects.cascade[cascade]!;
    shader.set({
      rc: {
        state: [cascade, cascade < scene.cascadeCount - 1 ? 1 : 0, 0, 0],
      },
      sdf_tex: scene.sdf,
      sdf_samp: scene.sampler,
      emitter_tex: emitterWrite,
      emitter_samp: scene.sampler,
      upper_tex: atlasRead,
    });
    passes.push({ target: atlasWrite, effect: shader });
    [atlasRead, atlasWrite] = [atlasWrite, atlasRead];
  }
  scene.cascades = [atlasRead, atlasWrite];
  return passes;
}

export function runChain(
  scene: RadianceScene,
  options: ChainOptions = {}
): void {
  const passes = buildChain(scene, options);
  frame(scene.gpu, (currentFrame) => {
    for (const pass of passes) {
      currentFrame.pass(
        { target: pass.target, clear: [0, 0, 0, 0] },
        (encoder) => encoder.draw(pass.effect)
      );
    }
  });
}

export function presentScene(
  scene: RadianceScene,
  output: Output,
  view: RadianceView
): void {
  scene.effects.present.set({
    present: {
      view: [resolveView(view, scene.cascadeCount).mode, 0, 0, 0],
    },
    cascade_tex: scene.cascades[0],
    emitter_tex: scene.emitter[0],
    sdf_tex: scene.sdf,
  });
  frame(scene.gpu, (currentFrame) => {
    currentFrame.pass({ target: output, clear: [0, 0, 0, 1] }, (encoder) =>
      encoder.draw(scene.effects.present)
    );
  });
}
