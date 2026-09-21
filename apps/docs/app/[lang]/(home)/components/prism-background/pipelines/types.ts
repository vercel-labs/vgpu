import type { Frame, Surface, Target, TimerSpan } from "vgpu";

import type { LightMeshLayout } from "../scene/light-mesh";
import type { PrismTheme } from "../types";

export type PrismOutput = Surface | Target;

export type PrismPipelineMode = PrismTheme;

/** User-facing theme choice; auto resolves against the site's active theme. */
export type PrismThemePreference = "auto" | PrismPipelineMode;

/** Render-budget tier selected independently from the visual theme. */
export type PrismPipelineQuality = "high" | "low";

/** User-facing quality choice; auto always begins at High for a new mount. */
export type PrismQualityPreference = "auto" | PrismPipelineQuality;

/** Why the currently effective quality tier was selected. */
export type PrismQualityReason =
  | "initial"
  | "forced"
  | "gpu-tier"
  | "battery"
  | "runtime";

/** Separates the user's preference from the pipeline that is on screen. */
export interface PrismQualityState {
  readonly preference: PrismQualityPreference;
  readonly effective: PrismPipelineQuality;
  readonly reason: PrismQualityReason;
}

export interface PrismPipelineRenderOptions {
  /** Skip retained scene/postprocess passes when only an overlay animates. */
  readonly updateScene?: boolean;
  /** Opt-in measurement hook. Omitted from every normal homepage frame. */
  readonly profile?: PrismPassProfile;
}

export interface PrismPipelineBindOptions {
  /** Skip scene-owned writes when only a retained overlay changes. */
  readonly updateScene?: boolean;
  /** Display-space reveal applied only by the final presentation layer. */
  readonly revealProgress?: number;
  /** Aperture applied to white, internal, and outgoing light ribbons. */
  readonly beamWidthReveal?: number;
}

export interface PrismPassProfile {
  /** Counts the pass and returns its optional timestamp-query span. */
  pass(name: string): TimerSpan | undefined;
}

export type PrismDebugSource = {
  readonly id: string;
  readonly label: string;
  readonly kind:
    | "asset"
    | "geometry"
    | "view"
    | "draw"
    | "pass"
    | "target"
    | "output"
    | "state"
    | "control";
  /** Static pipeline facts shown even when this node has no GPU preview. */
  readonly details?: readonly {
    readonly label: string;
    readonly value: string;
  }[];
  readonly inputs: readonly {
    readonly source: string;
    readonly operation: string;
  }[];
  readonly visualization:
    | "srgb"
    | "linear"
    | "hdr"
    | "scalar"
    | "normal"
    | "none";
};

/** Existing pipeline texture(s) exposed read-only to the opt-in preview host. */
export interface PrismDebugTargetPreview {
  readonly primary: Target;
  readonly secondary?: Target;
  readonly mode?: "tone" | "difference";
  readonly exposure?: number;
  /** Numeric light tone-mapper code; defaults to ACES for generic previews. */
  readonly toneMapping?: number;
  readonly differenceGain?: number;
}

/** Retained theme renderer. It observes, but never owns, shared runtime state. */
export interface PrismPipeline {
  readonly mode: PrismPipelineMode;
  /** Fixed spectral geometry layout owned by this quality tier. */
  readonly lightMeshLayout?: LightMeshLayout;
  prepare(output: PrismOutput): Promise<void>;
  resize(size: readonly [number, number]): void;
  bind(time: number, options?: PrismPipelineBindOptions): void;
  render(
    currentFrame: Frame,
    output: PrismOutput,
    options?: PrismPipelineRenderOptions
  ): void;
  debugSources?(): readonly PrismDebugSource[];
  /** Resolves retained production targets without allocating or re-rendering them. */
  debugTarget?(sourceId: string): PrismDebugTargetPreview | undefined;
  destroy(): void;
}
