import GUI from "lil-gui";
import {
  clock,
  frameLoop,
  surface,
  target,
  type Effect,
  type Gpu,
  type Surface,
  type Target,
} from "vgpu";

import {
  createBlit,
  createScene,
  DEFAULT_INSTANCE_COUNT,
  INSTANCE_COUNT_OPTIONS,
  isInstanceCount,
  renderScene,
  type InstanceCount,
  type InstancedScene,
} from "./scene-pipeline";

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly container?: HTMLElement;
}

interface Generation {
  readonly colorTarget: Target;
  readonly blit: Effect;
  readonly scene: InstancedScene;
  readonly size: readonly [number, number];
  readonly count: InstanceCount;
}

export function createRenderer({
  canvas,
  container = canvas.parentElement ?? undefined,
}: RendererOptions) {
  let disposed = false;
  let failed = false;
  let revision = 0;
  let count = DEFAULT_INSTANCE_COUNT;
  let size: readonly [number, number] | undefined;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let active: Generation | undefined;
  let loop: { stop(): void } | undefined;
  let unsubscribeResize: (() => void) | undefined;
  let gui: GUI | undefined;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    revision++;
    for (const cleanup of [
      () => loop?.stop(),
      () => unsubscribeResize?.(),
      () => gui?.destroy(),
      () => gpu?.dispose(),
    ])
      bestEffort(cleanup);
  };

  const fail = (error: unknown): never => {
    failed = true;
    dispose();
    throw error;
  };

  const guard = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      return fail(error);
    }
  };

  const requestBuild = () => {
    if (
      !gpu ||
      !output ||
      !active ||
      !size ||
      (sameSize(size, active.size) && count === active.count)
    )
      return;
    const token = revision;
    return createGeneration(gpu, output, size, count).then(
      (next) => {
        if (disposed || token !== revision) {
          cleanupGeneration(next);
          return;
        }
        const previous = active;
        active = next;
        const retirementFailure = cleanupGeneration(previous);
        if (retirementFailure) fail(retirementFailure.reason);
      },
      (error: unknown) => {
        if (!disposed && token === revision) fail(error);
      }
    );
  };

  const setCount = (value: unknown) => {
    const next = Number(value);
    if (!isInstanceCount(next) || next === count) return;
    count = next;
    revision++;
    return requestBuild();
  };

  const setSize = (next: readonly [number, number]) => {
    if (next[0] <= 0 || next[1] <= 0) return;
    if (sameSize(next, size)) return;
    size = next;
    revision++;
    return requestBuild();
  };

  const initialize = async () => {
    const { init } = await import("vgpu");
    if (disposed) return;

    const nextGpu = await init();
    gpu = nextGpu;
    if (disposed) {
      bestEffort(() => nextGpu.dispose());
      return;
    }

    output = surface(gpu, canvas, { dpr: [1, 2] });
    size = output.size;
    const initial = await createGeneration(gpu, output, size, count);
    if (disposed) {
      cleanupGeneration(initial);
      return;
    }
    active = initial;

    gui = createGui(container, count, setCount);
    unsubscribeResize = output.onResize(({ width, height }) =>
      setSize([width, height])
    );
    const time = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) =>
      guard(() => {
        if (!disposed && active && output) {
          renderScene(
            currentFrame,
            active.scene,
            active.blit,
            active.colorTarget,
            output,
            time.time
          );
        }
      })
    );
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  return { ready, dispose };
}

function createGui(
  container: HTMLElement | undefined,
  count: InstanceCount,
  onChange: (value: unknown) => unknown
): GUI {
  if (!container) throw new Error("Instanced Rendering needs a GUI container");

  let gui: GUI | undefined;
  try {
    gui = new GUI({ title: "Instanced Rendering", container, width: 210 });
    Object.assign(gui.domElement.style, {
      position: "absolute",
      top: "16px",
      right: "16px",
      zIndex: "10",
    });
    gui
      .add({ count }, "count", INSTANCE_COUNT_OPTIONS)
      .name("Instances")
      .onChange(onChange);
    return gui;
  } catch (error) {
    bestEffort(() => gui?.destroy());
    throw error;
  }
}

async function createGeneration(
  gpu: Gpu,
  output: Surface,
  size: readonly [number, number],
  count: InstanceCount
): Promise<Generation> {
  const colorTarget = target(gpu, { size, format: "rgba8unorm", depth: true });
  let scene: InstancedScene | undefined;

  try {
    scene = await createScene(gpu, colorTarget, count);
    const blit = createBlit(gpu, colorTarget, output);

    return {
      colorTarget,
      blit,
      scene,
      size,
      count,
    };
  } catch (error) {
    if (scene) {
      const partialScene = scene;
      bestEffort(() => partialScene.geometry.destroy());
    }
    bestEffort(() => destroyTarget(colorTarget));
    throw error;
  }
}

function cleanupGeneration(
  generation: Generation | undefined
): { reason: unknown } | undefined {
  if (!generation) return;
  let failure: { reason: unknown } | undefined;
  for (const cleanup of [
    () => generation.scene.geometry.destroy(),
    () => destroyTarget(generation.colorTarget),
  ]) {
    try {
      cleanup();
    } catch (reason) {
      failure ??= { reason };
    }
  }
  return failure;
}

function destroyTarget(value: Target): void {
  (value as Target & { destroy(): void }).destroy();
}

function sameSize(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined
): boolean {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}

function bestEffort(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Cleanup must not replace the primary operation or failure.
  }
}
