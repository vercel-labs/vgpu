import { useEffect, useRef } from "react";
import GUI, { type Controller } from "lil-gui";

import {
  DEFAULT_PRISM_CONTROLS,
  PRISM_BEAM_WIDTH_RANGE,
  PRISM_DISPERSION_LABELS,
  PRISM_DISPERSION_ORDER,
  PRISM_VIEW_LABELS,
  PRISM_VIEW_ORDER,
  type PrismControls,
  type PrismDispersion,
  type PrismView,
} from "./types";

export interface ControlsProps {
  initialValue?: Readonly<PrismControls>;
  onChange(value: PrismControls): void;
  disabled?: boolean;
}

interface GuiValues {
  dispersion: PrismDispersion;
  view: PrismView;
  beamWidth: number;
  wallColor: string;
}

function options<T extends string>(
  order: readonly T[],
  labels: Readonly<Record<T, string>>
): Record<string, T> {
  return Object.fromEntries(order.map((value) => [labels[value], value]));
}

/** lil-gui owns its small mutable model; React only owns the mount point. */
export function Controls({
  initialValue = DEFAULT_PRISM_CONTROLS,
  onChange,
  disabled = false,
}: ControlsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Fall back per-field as well as per-object so Fast Refresh can safely
    // cross schema changes that introduced `wallColor` and `beamWidth`.
    const values: GuiValues = {
      dispersion: initialValue.dispersion ?? DEFAULT_PRISM_CONTROLS.dispersion,
      view: initialValue.view ?? DEFAULT_PRISM_CONTROLS.view,
      beamWidth: initialValue.beamWidth ?? DEFAULT_PRISM_CONTROLS.beamWidth,
      wallColor: initialValue.wallColor ?? DEFAULT_PRISM_CONTROLS.wallColor,
    };
    const gui = new GUI({ title: "Prism", container });
    Object.assign(gui.domElement.style, {
      position: "absolute",
      top: "8px",
      right: "8px",
      pointerEvents: "auto",
    });

    const publish = () =>
      onChangeRef.current({
        dispersion: values.dispersion,
        view: values.view,
        beamWidth: values.beamWidth,
        wallColor: values.wallColor,
      });
    const controllers: Controller[] = [
      gui
        .add(
          values,
          "dispersion",
          options(PRISM_DISPERSION_ORDER, PRISM_DISPERSION_LABELS)
        )
        .name("glass")
        .onChange(publish),
      gui
        .add(
          values,
          "beamWidth",
          PRISM_BEAM_WIDTH_RANGE.min,
          PRISM_BEAM_WIDTH_RANGE.max,
          PRISM_BEAM_WIDTH_RANGE.step,
        )
        .name("beam width")
        .onChange(publish),
      gui
        .add(values, "view", options(PRISM_VIEW_ORDER, PRISM_VIEW_LABELS))
        .name("show")
        .onChange(publish),
      gui.addColor(values, "wallColor").name("wall color").onChange(publish),
    ];
    if (disabled) controllers.forEach((controller) => controller.disable());

    return () => {
      gui.destroy();
    };
  }, [disabled, initialValue]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0 z-[2]"
    />
  );
}
