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
  renderScene,
  type BatchScene,
} from "./scene-pipeline";

type RenderState = Readonly<{ colorTarget: Target; blit: Effect }>;

export function createRenderer({
  canvas,
}: {
  readonly canvas: HTMLCanvasElement;
}) {
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let scene: BatchScene | undefined;
  let state: RenderState | undefined;
  let loop: { stop(): void } | undefined;
  let unsubscribeResize: (() => void) | undefined;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    runCleanups([
      () => loop?.stop(),
      () => unsubscribeResize?.(),
      () => gpu?.dispose(),
    ]);
  };

  const fail = (error: unknown): never => {
    failed = true;
    try {
      dispose();
    } catch {
      // Teardown must not replace the live or initialization failure.
    }
    throw error;
  };

  const guard = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      return fail(error);
    }
  };

  const replaceTarget = (size: readonly [number, number]) => {
    if (!gpu || !output || !state || sameSize(size, state.colorTarget.size))
      return;
    const previous = state;
    const colorTarget = target(gpu, {
      size,
      format: "rgba8unorm",
      depth: true,
    });
    try {
      const blit = createBlit(gpu, colorTarget, output);
      blit.compileSync({ colors: [output.format] });
      state = { colorTarget, blit };
    } catch (error) {
      try {
        destroyTarget(colorTarget);
      } catch {
        // Candidate cleanup must not replace the resize failure.
      }
      throw error;
    }
    destroyTarget(previous.colorTarget);
  };

  const initialize = async () => {
    const { init } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      try {
        nextGpu.dispose();
      } catch {
        // Intentional stale initialization is quiet.
      }
      return;
    }

    gpu = nextGpu;
    output = surface(gpu, canvas, { dpr: [1, 2] });
    const colorTarget = target(gpu, {
      size: output.size,
      format: "rgba8unorm",
      depth: true,
    });
    const blit = createBlit(gpu, colorTarget, output);
    const prepared = await Promise.allSettled([
      Promise.resolve().then(() => createScene(gpu!, colorTarget)),
      Promise.resolve().then(() => blit.compile({ colors: [output!.format] })),
    ]);
    if (prepared[0].status === "fulfilled") scene = prepared[0].value;
    const preparationFailure = prepared.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (preparationFailure) throw preparationFailure.reason;
    if (disposed) return;
    state = { colorTarget, blit };

    unsubscribeResize = output.onResize(({ width, height }) =>
      guard(() => replaceTarget([width, height]))
    );
    const time = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) =>
      guard(() => {
        if (disposed || !scene || !state || !output) return;
        renderScene(
          currentFrame,
          scene,
          state.blit,
          state.colorTarget,
          output,
          time.time
        );
      })
    );
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  return { ready, dispose };
}

function sameSize(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function destroyTarget(value: Target): void {
  (value as Target & { destroy(): void }).destroy();
}

function runCleanups(cleanups: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw errors[0];
}
