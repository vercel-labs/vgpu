import type { PrismControls, PrismTheme } from "../../types";

interface DebugControlBase {
  readonly id: string;
  readonly label: string;
}

export interface DebugRangeControl extends DebugControlBase {
  readonly kind: "range";
  readonly min: number;
  readonly max: number;
  readonly step: number;
  read(controls: PrismControls, mode: PrismTheme): number;
  write(
    controls: PrismControls,
    mode: PrismTheme,
    value: number
  ): PrismControls;
}

export interface DebugSelectControl extends DebugControlBase {
  readonly kind: "select";
  readonly options: readonly {
    readonly label: string;
    readonly value: string;
  }[];
  read(controls: PrismControls, mode: PrismTheme): string;
  write(
    controls: PrismControls,
    mode: PrismTheme,
    value: string
  ): PrismControls;
}

export interface DebugColorControl extends DebugControlBase {
  readonly kind: "color";
  read(controls: PrismControls, mode: PrismTheme): string;
  write(
    controls: PrismControls,
    mode: PrismTheme,
    value: string
  ): PrismControls;
}

export type DebugControl =
  | DebugRangeControl
  | DebugSelectControl
  | DebugColorControl;

export interface DebugControlGroup {
  readonly label: string;
  readonly controls: readonly DebugControl[];
  readonly themeScoped?: boolean;
  readonly preview?: "shadowCurve";
}
