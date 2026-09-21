import type { Draw, Effect, Frame, Gpu } from "vgpu";

import type { PrismRuntime } from "../../runtime/types";
import type {
  PrismDebugTargetPreview,
  PrismPipeline,
} from "../../pipelines/types";
import type { PrismDebugPreviewBridge } from "../preview-bridge";
import type { PrismDebugSourceId } from "../sources";

export type PrismDebugDrawable = Draw | Effect;

export interface PrismDebugDrawSet {
  readonly sources: Readonly<
    Partial<Record<PrismDebugSourceId, PrismDebugDrawable>>
  >;
  readonly ranges?: Readonly<
    Partial<
      Record<
        PrismDebugSourceId,
        { readonly firstVertex: number; readonly vertices: number }
      >
    >
  >;
  /** Refreshes preview-only uniforms without rebuilding any draw. */
  bind?(): void;
}

export interface DebuggableTargetPipeline extends PrismPipeline {
  debugTarget(sourceId: string): PrismDebugTargetPreview | undefined;
}

export interface DebuggableLightPipeline extends DebuggableTargetPipeline {
  readonly mode: "light";
  createDebugDraws(): Promise<PrismDebugDrawSet>;
}

export interface PrismDebugPreviewHostOptions {
  readonly gpu: Gpu;
  readonly runtime: PrismRuntime;
  readonly getPipeline: () => PrismPipeline | undefined;
  /** Wakes the owning renderer after attach or asynchronous preview work. */
  readonly invalidate?: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface PrismDebugPreviewHost {
  readonly bridge: PrismDebugPreviewBridge;
  render(current: Frame, time: number): void;
  /** Marks runtime/target-dependent previews dirty. */
  invalidate(): void;
  dispose(): void;
}
