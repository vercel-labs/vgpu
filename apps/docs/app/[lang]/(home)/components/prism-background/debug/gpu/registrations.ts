import type { Gpu, Surface } from "vgpu";
import { surface } from "vgpu";

import type {
  PrismDebugPreviewBridge,
  PrismDebugPreviewDetach,
  PrismDebugPreviewRegistration,
} from "../preview-bridge";
import { isStaticPreview } from "./source-policy";

export interface PreviewRegistration {
  readonly canvas: HTMLCanvasElement;
  readonly source: PrismDebugPreviewRegistration["source"];
  readonly output: Surface;
  readonly isStatic: boolean;
  dirty: boolean;
  rendered: boolean;
  darkCleared: boolean;
}

export interface PreviewRegistry {
  readonly bridge: PrismDebugPreviewBridge;
  readonly values: () => IterableIterator<PreviewRegistration>;
  markDynamicDirty(): void;
  markAllDirty(): void;
  dispose(): void;
}

export function createPreviewRegistry(
  gpu: Gpu,
  requestRender: () => void
): PreviewRegistry {
  const entries = new Map<HTMLCanvasElement, PreviewRegistration>();
  let disposed = false;

  const detachCurrent = (canvas: HTMLCanvasElement): void => {
    const entry = entries.get(canvas);
    if (!entry) return;
    entries.delete(canvas);
    entry.output.dispose();
  };
  const detachEntry = (entry: PreviewRegistration): void => {
    if (entries.get(entry.canvas) !== entry) return;
    entries.delete(entry.canvas);
    entry.output.dispose();
  };
  const bridge: PrismDebugPreviewBridge = Object.freeze({
    attachPreview(
      registration: PrismDebugPreviewRegistration
    ): PrismDebugPreviewDetach {
      if (disposed) return () => {};
      detachCurrent(registration.canvas);
      const output = surface(gpu, registration.canvas, {
        size: [256, 144],
        dpr: 1,
        autoResize: false,
        label: `prism.debug.${registration.source.id}`,
      });
      const entry: PreviewRegistration = {
        ...registration,
        output,
        isStatic: isStaticPreview(registration.source.id),
        dirty: true,
        rendered: false,
        darkCleared: false,
      };
      entries.set(registration.canvas, entry);
      requestRender();
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        detachEntry(entry);
      };
    },
  });

  return {
    bridge,
    values: () => entries.values(),
    markDynamicDirty() {
      for (const entry of entries.values()) {
        if (!entry.isStatic) entry.dirty = true;
      }
    },
    markAllDirty() {
      for (const entry of entries.values()) {
        entry.dirty = true;
        entry.darkCleared = false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of entries.values()) entry.output.dispose();
      entries.clear();
    },
  };
}
