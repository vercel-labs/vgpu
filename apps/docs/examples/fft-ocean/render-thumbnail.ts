import { effect, frame, target, type Gpu, type Target } from "vgpu";

import { createGraph, destroyGraph, renderAt } from "./renderer";
import stagePreviewWgsl from "./stage-preview.wgsl";

interface ThumbnailOptions {
  readonly time?: number;
  readonly onVariantRendered?: (
    variant: "time-delta",
    pixels: Uint8Array,
    size: readonly [number, number]
  ) => void | Promise<void>;
  readonly onIntermediateRendered?: (
    kind: "displacement",
    pixels: Uint8Array,
    size: readonly [number, number]
  ) => void | Promise<void>;
}

interface Failure {
  readonly error: unknown;
}

const CLEAR = [0, 0, 0, 1] as const;

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {}
): Promise<void> {
  let graph: Awaited<ReturnType<typeof createGraph>> | undefined;
  let failure: Failure | undefined;
  try {
    graph = await createGraph(gpu, output, "fft-ocean-thumb");
    const time = options.time ?? 18;
    renderAt(gpu, graph, output, time);
    await gpu.gpu.queue.onSubmittedWorkDone();
    if (options.onIntermediateRendered) {
      await renderDisplacement(gpu, graph, options.onIntermediateRendered);
    }

    renderAt(gpu, graph, output, time + 5);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await options.onVariantRendered?.(
      "time-delta",
      await output.color.read({ mipLevel: 0, region: "all" }),
      output.size
    );

    renderAt(gpu, graph, output, time);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } catch (error) {
    failure = { error };
  }
  await releaseShared(gpu, graph ? [() => destroyGraph(graph)] : [], failure);
}

async function renderDisplacement(
  gpu: Gpu,
  graph: Awaited<ReturnType<typeof createGraph>>,
  onRendered: NonNullable<ThumbnailOptions["onIntermediateRendered"]>
): Promise<void> {
  const displacement = graph.ifft.at(-1)!.output;
  let previewTarget: Target | undefined;
  let failure: Failure | undefined;
  try {
    previewTarget = target(gpu, {
      size: displacement.size,
      format: "rgba8unorm",
      label: "fft-ocean-displacement-preview",
    });
    const preview = effect(gpu, stagePreviewWgsl, {
      label: "fft-ocean-displacement-preview",
    });
    preview.set({
      u: {
        gain: 16,
      },
      u_input: displacement,
    });
    await preview.compile(previewTarget);
    frame(gpu, (currentFrame) =>
      currentFrame.pass({ target: previewTarget!, clear: CLEAR }, (pass) =>
        pass.draw(preview)
      )
    );
    await gpu.gpu.queue.onSubmittedWorkDone();
    await onRendered(
      "displacement",
      await previewTarget.color.read({ mipLevel: 0, region: "all" }),
      previewTarget.size
    );
  } catch (error) {
    failure = { error };
  }
  await releaseShared(
    gpu,
    previewTarget ? [() => previewTarget.color.destroy()] : [],
    failure
  );
}

async function releaseShared(
  gpu: Gpu,
  cleanups: readonly (() => void)[],
  failure?: Failure
): Promise<void> {
  let first = failure;
  const barriers = await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ]);
  for (const result of barriers) {
    if (result.status === "rejected") first ??= { error: result.reason };
  }
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      first ??= { error };
    }
  }
  if (first) throw first.error;
}
