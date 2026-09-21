import type { Effect, Frame, Gpu, Target } from "vgpu";
import { effect } from "vgpu";

import type { PrismDebugTargetPreview } from "../../pipelines/types";
import type { PrismRuntime } from "../../runtime/types";
import previewWgsl from "./preview.wgsl";

export interface TargetPreviewRenderer {
  drawableFor(preview: PrismDebugTargetPreview): Effect;
  render(
    current: Frame,
    output: Target,
    preview: PrismDebugTargetPreview
  ): void;
}

export function createTargetPreviewRenderer(
  gpu: Gpu,
  runtime: PrismRuntime
): TargetPreviewRenderer {
  const tone = effect(gpu, previewWgsl, {
    label: "prism.debug.target-preview.tone",
  });
  const difference = effect(gpu, previewWgsl, {
    label: "prism.debug.target-preview.difference",
  });
  return {
    drawableFor(preview) {
      return preview.mode === "difference" ? difference : tone;
    },
    render(current, output, preview) {
      const isDifference = preview.mode === "difference";
      const drawable = isDifference ? difference : tone;
      drawable.set({
        primaryTexture: preview.primary,
        secondaryTexture: preview.secondary ?? preview.primary,
        previewSampler: runtime.sceneSampler,
        params: {
          mode: isDifference ? 1 : 0,
          toneMapping: preview.toneMapping ?? 0,
          exposure: preview.exposure ?? 1,
          differenceGain: preview.differenceGain ?? (isDifference ? 5 : 1),
        },
      });
      current.pass({ target: output, clear: [0, 0, 0, 1] }, (pass) => {
        pass.draw(drawable);
      });
    },
  };
}
