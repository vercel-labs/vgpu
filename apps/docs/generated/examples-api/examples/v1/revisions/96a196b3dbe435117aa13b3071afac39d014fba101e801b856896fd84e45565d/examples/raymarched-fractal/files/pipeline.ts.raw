import { effect, sampler, target } from "vgpu";
import type { Frame, Gpu, Target } from "vgpu";

import blurWgsl from "./blur.wgsl";
import brightPassWgsl from "./bright-pass.wgsl";
import compositeWgsl from "./composite.wgsl";
import fractalWgsl from "./fractal.wgsl";
import { quietly, runAll } from "./lifecycle";

export interface Orbit {
  yaw: number;
  pitch: number;
}

type Effects = ReturnType<typeof createEffects>;
type Targets = ReturnType<typeof createTargets>;
export type FractalScene = ReturnType<typeof createScene>;

const HDR_FORMAT: GPUTextureFormat = "rgba16float";
const BLOOM_HEIGHT = 360;
const CLEAR: readonly [number, number, number, number] = [0, 0, 0, 1];

export const POSTER: Readonly<Orbit> = { yaw: 0.58, pitch: 0.24 };

export function createScene(gpu: Gpu, size: readonly [number, number]) {
  const effects = createEffects(gpu);
  const targets = createTargets(gpu, size);
  try {
    bindTargets(effects, targets);
    return { effects, targets };
  } catch (error) {
    quietly(() => destroyTargets(targets));
    throw error;
  }
}

function createEffects(gpu: Gpu) {
  const sharedSampler = sampler(gpu, {
    minFilter: "linear",
    magFilter: "linear",
  });
  const effects = {
    scene: effect(gpu, fractalWgsl),
    brightPass: effect(gpu, brightPassWgsl),
    blurH: effect(gpu, blurWgsl),
    blurV: effect(gpu, blurWgsl),
    composite: effect(gpu, compositeWgsl),
  };
  effects.scene.set({ params: { resolution: [1, 1], ...POSTER } });
  effects.brightPass.set({ samp: sharedSampler });
  effects.blurH.set({ samp: sharedSampler, blur: { direction: [1, 0] } });
  effects.blurV.set({ samp: sharedSampler, blur: { direction: [0, 1] } });
  effects.composite.set({
    samp: sharedSampler,
    composite: { bloomStrength: 0.65 },
  });
  return effects;
}

function createTargets(gpu: Gpu, size: readonly [number, number]) {
  const full: [number, number] = [
    Math.max(1, Math.floor(size[0])),
    Math.max(1, Math.floor(size[1])),
  ];
  const bloomHeight = Math.max(1, Math.min(BLOOM_HEIGHT, full[1]));
  const bloom: [number, number] = [
    Math.max(1, Math.round((bloomHeight * full[0]) / full[1])),
    bloomHeight,
  ];
  const created: Target[] = [];
  const own = (targetSize: readonly [number, number]) => {
    const value = target(gpu, {
      size: targetSize,
      format: HDR_FORMAT,
    });
    created.push(value);
    return value;
  };
  try {
    return {
      scene: own(full),
      bloomA: own(bloom),
      bloomB: own(bloom),
    };
  } catch (error) {
    quietly(() => destroyTargetList(created));
    throw error;
  }
}

function bindTargets(effects: Effects, targets: Targets): void {
  runAll([
    () => effects.scene.set({ params: { resolution: targets.scene.size } }),
    () => effects.brightPass.set({ src: targets.scene }),
    () =>
      effects.blurH.set({
        src: targets.bloomA,
        blur: { texelSize: targets.bloomA.texelSize },
      }),
    () =>
      effects.blurV.set({
        src: targets.bloomB,
        blur: { texelSize: targets.bloomB.texelSize },
      }),
    () =>
      effects.composite.set({ scene: targets.scene, bloom: targets.bloomA }),
  ]);
}

export async function compileScene(
  scene: FractalScene,
  output: Target
): Promise<void> {
  const { effects, targets } = scene;
  const results = await Promise.allSettled(
    [
      () => effects.scene.compile(targets.scene),
      () => effects.brightPass.compile(targets.bloomA),
      () => effects.blurH.compile(targets.bloomB),
      () => effects.blurV.compile(targets.bloomA),
      () => effects.composite.compile({ colors: [output.format] }),
    ].map((compile) => Promise.resolve().then(compile))
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failed) throw failed.reason;
}

export function renderScene(
  currentFrame: Frame,
  scene: FractalScene,
  output: Target,
  orbit: Readonly<Orbit>
): void {
  const { effects, targets } = scene;
  effects.scene.set({ params: orbit });
  currentFrame.pass({ target: targets.scene, clear: CLEAR }, (pass) =>
    pass.draw(effects.scene)
  );
  currentFrame.pass({ target: targets.bloomA, clear: CLEAR }, (pass) =>
    pass.draw(effects.brightPass)
  );
  currentFrame.pass({ target: targets.bloomB, clear: CLEAR }, (pass) =>
    pass.draw(effects.blurH)
  );
  currentFrame.pass({ target: targets.bloomA, clear: CLEAR }, (pass) =>
    pass.draw(effects.blurV)
  );
  currentFrame.pass({ target: output, clear: CLEAR }, (pass) =>
    pass.draw(effects.composite)
  );
}

export function replaceTargets(
  gpu: Gpu,
  scene: FractalScene,
  size: readonly [number, number]
): void {
  const previous = scene.targets;
  const next = createTargets(gpu, size);
  try {
    bindTargets(scene.effects, next);
  } catch (error) {
    quietly(() => bindTargets(scene.effects, previous));
    quietly(() => destroyTargets(next));
    throw error;
  }
  scene.targets = next;
  destroyTargets(previous);
}

export function destroyScene(scene: FractalScene): void {
  destroyTargets(scene.targets);
}

function destroyTargets(targets: Targets): void {
  destroyTargetList([targets.scene, targets.bloomA, targets.bloomB]);
}

function destroyTargetList(targets: readonly Target[]): void {
  runAll(targets.map((value) => () => value.color.destroy()));
}
