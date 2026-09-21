import type { PrismDebugSource } from "../pipelines/types";

export type PrismDebugPreviewRegistration = {
  readonly canvas: HTMLCanvasElement;
  readonly source: PrismDebugSource;
};

export type PrismDebugPreviewDetach = () => void;

/**
 * Renderer-owned, imperative preview connection. Implementations may render
 * directly into the canvas, but must never send pixel data through React.
 */
export interface PrismDebugPreviewBridge {
  attachPreview(
    registration: PrismDebugPreviewRegistration
  ): PrismDebugPreviewDetach;
}

export interface PrismDebugPreviewRelay {
  /** Stable object passed to React while the GPU implementation loads lazily. */
  readonly bridge: PrismDebugPreviewBridge;
  setDelegate(delegate: PrismDebugPreviewBridge): void;
  dispose(): void;
}

const detachNoop = () => {};

/** Keeps the graph mountable before a GPU preview provider is available. */
export const NOOP_PRISM_DEBUG_PREVIEW_BRIDGE: PrismDebugPreviewBridge =
  Object.freeze({
    attachPreview: () => detachNoop,
  });

/**
 * Retains visible canvas registrations across an asynchronous provider swap.
 * This lets the graph mount immediately without importing or initializing its
 * WebGPU preview implementation on the normal homepage path.
 */
export function createPrismDebugPreviewRelay(): PrismDebugPreviewRelay {
  type Entry = {
    readonly registration: PrismDebugPreviewRegistration;
    detach: PrismDebugPreviewDetach;
  };
  const entries = new Map<HTMLCanvasElement, Entry>();
  let delegate = NOOP_PRISM_DEBUG_PREVIEW_BRIDGE;
  let disposed = false;

  const bridge: PrismDebugPreviewBridge = Object.freeze({
    attachPreview(registration: PrismDebugPreviewRegistration) {
      if (disposed) return detachNoop;
      const previous = entries.get(registration.canvas);
      previous?.detach();
      const entry: Entry = {
        registration,
        detach: delegate.attachPreview(registration),
      };
      entries.set(registration.canvas, entry);
      return () => {
        if (entries.get(registration.canvas) !== entry) return;
        entries.delete(registration.canvas);
        entry.detach();
      };
    },
  });

  return {
    bridge,
    setDelegate(next) {
      if (disposed || next === delegate) return;
      delegate = next;
      for (const entry of entries.values()) {
        entry.detach();
        entry.detach = delegate.attachPreview(entry.registration);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of entries.values()) entry.detach();
      entries.clear();
      delegate = NOOP_PRISM_DEBUG_PREVIEW_BRIDGE;
    },
  };
}
