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

import agentDotsWgsl from "./agent-dots.wgsl";
import jfaInitWgsl from "./jfa-init.wgsl";
import jfaPassWgsl from "./jfa-pass.wgsl";
import presentWgsl from "./present.wgsl";
import radianceCascadeWgsl from "./radiance-cascade.wgsl";
import sdfFinalizeWgsl from "./sdf-finalize.wgsl";

type Output = Surface | Target;
type Vec2 = readonly [number, number];

export type AgentRadianceAnimation =
  | "center-out"
  | "edge-orbit"
  | "edge-then-center";
export type AgentRadianceView =
  | "final"
  | "emitters"
  | "jfa"
  | "sdf"
  | `cascade-${0 | 1 | 2 | 3 | 4 | 5}`;

const HDR_FORMAT: GPUTextureFormat = "rgba16float";
// Seeds store absolute pixel coordinates, which need f32 precision past 2048.
const SEED_FORMAT: GPUTextureFormat = "rgba32float";
const RC_INTERVAL0 = 2;
const DOT_SPACING = 0.105;
const DOT_RADIUS = 0.0295;
const ANIMATION_MODE: Record<AgentRadianceAnimation, number> = {
  "center-out": 0,
  "edge-orbit": 1,
  "edge-then-center": 2,
};

export function scaledSize(
  width: number,
  height: number,
  requestedScale: number,
  maxEdge: number
): Vec2 {
  const scale = Math.min(requestedScale, maxEdge / Math.max(width, height, 1));
  return [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  ];
}

function resolveView(view: AgentRadianceView, cascadeCount: number) {
  if (view === "emitters") return { mode: 1, stage: 0, stopAt: cascadeCount };
  if (view === "jfa") return { mode: 4, stage: 1, stopAt: cascadeCount };
  if (view === "sdf") return { mode: 2, stage: 2, stopAt: cascadeCount };
  if (view.startsWith("cascade-")) {
    return {
      mode: 3,
      stage: 3,
      stopAt: Math.min(Number(view.slice(8)), cascadeCount - 1),
    };
  }
  return { mode: 0, stage: 3, stopAt: 0 };
}

export function createScene(gpu: Gpu, requestedSize: Vec2, directionBase = 2) {
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
  const coarsest = 2 ** (cascadeCount - 1);
  const atlas: Vec2 = [
    Math.ceil(width / coarsest) * coarsest * directionBase,
    Math.ceil(height / coarsest) * coarsest * directionBase,
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
    const emitter = own(target(gpu, { size, format: HDR_FORMAT }));
    const jfa: [Target, Target] = [
      own(target(gpu, { size, format: SEED_FORMAT })),
      own(target(gpu, { size, format: SEED_FORMAT })),
    ];
    const sdf = own(target(gpu, { size, format: HDR_FORMAT }));
    const cascades: [Target, Target] = [
      own(target(gpu, { size: atlas, format: HDR_FORMAT })),
      own(target(gpu, { size: atlas, format: HDR_FORMAT })),
    ];
    return {
      gpu,
      size,
      atlas,
      directionBase,
      cascadeCount,
      jumps,
      emitter,
      jfa,
      sdf,
      cascades,
      effects: {
        dots: effect(gpu, agentDotsWgsl),
        jfaInit: effect(gpu, jfaInitWgsl),
        // Uniforms upload immediately, so each encoded pass needs its own effect.
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

export type AgentRadianceScene = ReturnType<typeof createScene>;

export async function prepareScene(
  scene: AgentRadianceScene,
  outputFormat: GPUTextureFormat
): Promise<void> {
  await Promise.all([
    scene.effects.dots.compile({ colors: [HDR_FORMAT] }),
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

export function destroyScene(scene: AgentRadianceScene): void {
  destroyTargets([scene.emitter, ...scene.jfa, scene.sdf, ...scene.cascades]);
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

function buildChain(
  scene: AgentRadianceScene,
  time: number,
  view: AgentRadianceView,
  animation: AgentRadianceAnimation
) {
  const { size, effects } = scene;
  const resolved = resolveView(view, scene.cascadeCount);
  const passes: { readonly target: Target; readonly effect: Effect }[] = [];

  effects.dots.set({
    agent: {
      size: [size[0], size[1]],
      time,
      spacing: Math.min(size[0], size[1]) * DOT_SPACING,
      radius: Math.min(size[0], size[1]) * DOT_RADIUS,
      animation_mode: ANIMATION_MODE[animation],
    },
  });
  passes.push({ target: scene.emitter, effect: effects.dots });
  if (resolved.stage === 0) return passes;

  effects.jfaInit.set({ emitter: scene.emitter });
  passes.push({ target: scene.jfa[0], effect: effects.jfaInit });
  let seedRead = scene.jfa[0];
  let seedWrite = scene.jfa[1];
  scene.jumps.forEach((jump, index) => {
    const shader = effects.jfaSteps[index]!;
    shader.set({ jfa: { jump: [jump, 0, 0, 0] }, seeds: seedRead });
    passes.push({ target: seedWrite, effect: shader });
    [seedRead, seedWrite] = [seedWrite, seedRead];
  });
  scene.jfa = [seedRead, seedWrite];
  if (resolved.stage === 1) return passes;

  effects.sdfFinalize.set({ seeds: seedRead });
  passes.push({ target: scene.sdf, effect: effects.sdfFinalize });
  if (resolved.stage === 2) return passes;

  let atlasWrite = scene.cascades[0];
  let atlasRead = scene.cascades[1];
  for (
    let cascade = scene.cascadeCount - 1;
    cascade >= resolved.stopAt;
    cascade--
  ) {
    const shader = effects.cascade[cascade]!;
    shader.set({
      rc: {
        state: [
          cascade,
          cascade < scene.cascadeCount - 1 ? 1 : 0,
          scene.directionBase,
          0,
        ],
      },
      sdf_tex: scene.sdf,
      sdf_samp: scene.sampler,
      emitter_tex: scene.emitter,
      emitter_samp: scene.sampler,
      upper_tex: atlasRead,
    });
    passes.push({ target: atlasWrite, effect: shader });
    [atlasRead, atlasWrite] = [atlasWrite, atlasRead];
  }
  scene.cascades = [atlasRead, atlasWrite];
  return passes;
}

export function renderLighting(
  scene: AgentRadianceScene,
  time: number,
  view: AgentRadianceView,
  animation: AgentRadianceAnimation = "center-out"
): void {
  const passes = buildChain(scene, time, view, animation);
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
  scene: AgentRadianceScene,
  output: Output,
  view: AgentRadianceView
): void {
  scene.effects.present.set({
    present: {
      display: [
        0.92,
        resolveView(view, scene.cascadeCount).mode,
        48,
        scene.directionBase,
      ],
      lighting: [0.075, 0.004, 0, 0],
    },
    cascade_tex: scene.cascades[0],
    emitter_tex: scene.emitter,
    sdf_tex: scene.sdf,
    jfa_tex: scene.jfa[0],
    emitter_samp: scene.sampler,
  });
  frame(scene.gpu, (currentFrame) => {
    currentFrame.pass({ target: output, clear: [0, 0, 0, 1] }, (encoder) =>
      encoder.draw(scene.effects.present)
    );
  });
}
