import type { Frame } from "vgpu";

import type { PrismDebugSourceId } from "../sources";
import type { PreviewRegistration } from "./registrations";
import type { TargetPreviewRenderer } from "./target-preview";
import type {
  DebuggableTargetPipeline,
  PrismDebugDrawable,
  PrismDebugDrawSet,
} from "./types";

export function renderPreviewEntry(
  current: Frame,
  entry: PreviewRegistration,
  pipeline: DebuggableTargetPipeline,
  draws: PrismDebugDrawSet | undefined,
  targetPreview: TargetPreviewRenderer,
  compiled: (
    drawable: PrismDebugDrawable,
    output: PreviewRegistration["output"]
  ) => boolean,
  reportError: (error: unknown) => void
): boolean {
  try {
    const id = entry.source.id as PrismDebugSourceId;
    const target = pipeline.debugTarget(id);
    if (target) {
      if (!compiled(targetPreview.drawableFor(target), entry.output))
        return false;
      targetPreview.render(current, entry.output, target);
      return true;
    }
    const drawable = draws?.sources[id];
    if (!drawable || !compiled(drawable, entry.output)) return false;
    current.pass({ target: entry.output, clear: [0, 0, 0, 1] }, (pass) => {
      const range = draws?.ranges?.[id];
      if (range) {
        pass.draw(drawable, range);
      } else {
        pass.draw(drawable);
      }
    });
    return true;
  } catch (error) {
    reportError(error);
    return true;
  }
}

export function clearUnavailablePreviews(
  current: Frame,
  entries: IterableIterator<PreviewRegistration>
): void {
  for (const entry of entries) {
    if (entry.darkCleared) continue;
    current.pass({ target: entry.output, clear: [0, 0, 0, 0] }, () => {});
    entry.darkCleared = true;
  }
}

export function hasDirectRegistration(
  entries: IterableIterator<PreviewRegistration>,
  pipeline: DebuggableTargetPipeline
): boolean {
  for (const entry of entries) {
    if (!pipeline.debugTarget(entry.source.id)) return true;
  }
  return false;
}
