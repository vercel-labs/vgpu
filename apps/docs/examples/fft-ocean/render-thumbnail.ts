import type { Gpu, Target } from 'vgpu';
import { effect, frame, target } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { createGraph, destroyGraph, renderAt } from './scene';
import stagePreviewWgsl from './stage-preview.wgsl';

interface ThumbOptions extends ThumbnailOptions {
  onVariantRendered?: (
    variant: 'time-delta',
    pixels: Uint8Array,
    size: readonly [number, number]
  ) => void | Promise<void>;
  onIntermediateRendered?: (
    kind: 'displacement',
    pixels: Uint8Array,
    size: readonly [number, number]
  ) => void | Promise<void>;
}
const CLEAR = [0, 0, 0, 1] as const;

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  opts: ThumbOptions = {}
): Promise<void> {
  const graph = await createGraph(gpu, output, 'fft-ocean-thumb');
  try {
    const time = opts.time ?? 18;
    renderAt(gpu, graph, output, time);
    await gpu.gpu.queue.onSubmittedWorkDone();
    if (opts.onIntermediateRendered) {
      const displacement = graph.ifft.at(-1)!.output;
      const previewTarget = target(gpu, {
        size: displacement.size,
        format: 'rgba8unorm',
        label: 'fft-ocean-displacement-preview',
      });
      try {
        const preview = effect(gpu, stagePreviewWgsl, { label: 'fft-ocean-displacement-preview' });
        preview.set({
          u: {
            outputWidth: displacement.size[0],
            outputHeight: displacement.size[1],
            stage: 1,
            gain: 16,
          },
          u_input: displacement,
        });
        await preview.compile(previewTarget);
        frame(gpu, (currentFrame) =>
          currentFrame.pass({ target: previewTarget, clear: CLEAR }, (pass) => pass.draw(preview))
        );
        await gpu.gpu.queue.onSubmittedWorkDone();
        await opts.onIntermediateRendered(
          'displacement',
          await previewTarget.read(),
          previewTarget.size
        );
      } finally {
        try {
          await gpu.gpu.queue.onSubmittedWorkDone();
        } finally {
          previewTarget.color.destroy();
        }
      }
    }
    renderAt(gpu, graph, output, time + 5);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await opts.onVariantRendered?.('time-delta', await output.read(), output.size);
    renderAt(gpu, graph, output, time);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    try {
      await gpu.gpu.queue.onSubmittedWorkDone();
    } finally {
      destroyGraph(graph);
    }
  }
}
