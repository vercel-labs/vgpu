export interface RenderSize {
  /** CSS pixels. */
  readonly width: number;
  /** CSS pixels. */
  readonly height: number;
  /** Clamped device pixel ratio. */
  readonly dpr: number;
}

export interface ExampleRenderer<Controls = never> {
  /** Settles after init + required prewarm; cancellation is not an error. */
  readonly ready: Promise<void>;
  setControls?: (next: Readonly<Controls>) => void;
  /** Coalesced request; no-op is valid for continuous renderers. */
  invalidate(): void;
  resize(size: RenderSize): void;
  /** Synchronous, idempotent cancellation/teardown. */
  dispose(): void;
}

export interface BrowserRendererOptions<Controls = never> {
  readonly canvas: HTMLCanvasElement;
  readonly initialControls?: Readonly<Controls>;
  readonly onError?: (error: unknown) => void;
}

export interface ThumbnailOptions {
  readonly warmupFrames?: number;
  readonly time?: number;
  readonly dt?: number;
  /** Absolute path to apps/docs/public for entries that load authored assets. */
  readonly publicAssetsRoot?: string;
}
