import { useEffect, useRef } from "react";
import GUI, { type Controller } from "lil-gui";

import {
  DEFAULT_PRISM_CONTROLS,
  PRISM_BEAM_WIDTH_RANGE,
  PRISM_CAMERA_RANGES,
  PRISM_DISPERSION_LABELS,
  PRISM_DISPERSION_ORDER,
  PRISM_GLASS_RANGES,
  PRISM_POSTPROCESS_RANGES,
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
  cameraDistance: number;
  cameraFov: number;
  beamWidth: number;
  wallColor: string;
  wireframe: boolean;
  environmentDebug: boolean;
  ior: number;
  reflectionStrength: number;
  absorptionR: number;
  absorptionG: number;
  absorptionB: number;
  frostRadius: number;
  glassDispersion: number;
  iridescenceStrength: number;
  iridescenceFrequency: number;
  environmentExposure: number;
  bloomStrength: number;
  bloomThreshold: number;
  bloomRadius: number;
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
    // cross control-schema changes without rebuilding the renderer.
    const glass = initialValue.glass ?? DEFAULT_PRISM_CONTROLS.glass;
    const postprocess =
      initialValue.postprocess ?? DEFAULT_PRISM_CONTROLS.postprocess;
    const absorption =
      glass.absorption ?? DEFAULT_PRISM_CONTROLS.glass.absorption;
    const values: GuiValues = {
      dispersion: initialValue.dispersion ?? DEFAULT_PRISM_CONTROLS.dispersion,
      view: initialValue.view ?? DEFAULT_PRISM_CONTROLS.view,
      cameraDistance:
        initialValue.cameraDistance ?? DEFAULT_PRISM_CONTROLS.cameraDistance,
      cameraFov: initialValue.cameraFov ?? DEFAULT_PRISM_CONTROLS.cameraFov,
      beamWidth: initialValue.beamWidth ?? DEFAULT_PRISM_CONTROLS.beamWidth,
      wallColor: initialValue.wallColor ?? DEFAULT_PRISM_CONTROLS.wallColor,
      wireframe: initialValue.wireframe ?? DEFAULT_PRISM_CONTROLS.wireframe,
      environmentDebug:
        initialValue.environmentDebug ??
        DEFAULT_PRISM_CONTROLS.environmentDebug,
      ior: glass.ior ?? DEFAULT_PRISM_CONTROLS.glass.ior,
      reflectionStrength:
        glass.reflectionStrength ??
        DEFAULT_PRISM_CONTROLS.glass.reflectionStrength,
      absorptionR: absorption[0] ?? DEFAULT_PRISM_CONTROLS.glass.absorption[0],
      absorptionG: absorption[1] ?? DEFAULT_PRISM_CONTROLS.glass.absorption[1],
      absorptionB: absorption[2] ?? DEFAULT_PRISM_CONTROLS.glass.absorption[2],
      frostRadius:
        glass.frostRadius ?? DEFAULT_PRISM_CONTROLS.glass.frostRadius,
      glassDispersion:
        glass.dispersion ?? DEFAULT_PRISM_CONTROLS.glass.dispersion,
      iridescenceStrength:
        glass.iridescenceStrength ??
        DEFAULT_PRISM_CONTROLS.glass.iridescenceStrength,
      iridescenceFrequency:
        glass.iridescenceFrequency ??
        DEFAULT_PRISM_CONTROLS.glass.iridescenceFrequency,
      environmentExposure:
        glass.environmentExposure ??
        DEFAULT_PRISM_CONTROLS.glass.environmentExposure,
      bloomStrength:
        postprocess.bloomStrength ??
        DEFAULT_PRISM_CONTROLS.postprocess.bloomStrength,
      bloomThreshold:
        postprocess.bloomThreshold ??
        DEFAULT_PRISM_CONTROLS.postprocess.bloomThreshold,
      bloomRadius:
        postprocess.bloomRadius ??
        DEFAULT_PRISM_CONTROLS.postprocess.bloomRadius,
    };
    const gui = new GUI({ title: "Prism", container });
    Object.assign(gui.domElement.style, {
      position: "absolute",
      top: "8px",
      right: "8px",
      pointerEvents: "auto",
      maxHeight: "calc(100% - 16px)",
      overflowY: "auto",
    });

    const publish = () =>
      onChangeRef.current({
        dispersion: values.dispersion,
        view: values.view,
        cameraDistance: values.cameraDistance,
        cameraFov: values.cameraFov,
        beamWidth: values.beamWidth,
        wallColor: values.wallColor,
        wireframe: values.wireframe,
        environmentDebug: values.environmentDebug,
        glass: {
          ior: values.ior,
          reflectionStrength: values.reflectionStrength,
          absorption: [
            values.absorptionR,
            values.absorptionG,
            values.absorptionB,
          ],
          frostRadius: values.frostRadius,
          dispersion: values.glassDispersion,
          iridescenceStrength: values.iridescenceStrength,
          iridescenceFrequency: values.iridescenceFrequency,
          environmentExposure: values.environmentExposure,
        },
        postprocess: {
          bloomStrength: values.bloomStrength,
          bloomThreshold: values.bloomThreshold,
          bloomRadius: values.bloomRadius,
        },
      });

    const sceneFolder = gui.addFolder("Scene");
    const cameraFolder = gui.addFolder("Camera");
    const glassFolder = gui.addFolder("Glass");
    const transmissionFolder = glassFolder.addFolder("Transmission");
    const reflectionFolder = glassFolder.addFolder("Reflection");
    const postprocessFolder = gui.addFolder("Postprocessing");
    const debugFolder = gui.addFolder("Debug");
    const controllers: Controller[] = [
      sceneFolder
        .add(
          values,
          "dispersion",
          options(PRISM_DISPERSION_ORDER, PRISM_DISPERSION_LABELS)
        )
        .name("spectrum")
        .onChange(publish),
      sceneFolder
        .add(
          values,
          "beamWidth",
          PRISM_BEAM_WIDTH_RANGE.min,
          PRISM_BEAM_WIDTH_RANGE.max,
          PRISM_BEAM_WIDTH_RANGE.step
        )
        .name("beam width")
        .onChange(publish),
      sceneFolder
        .addColor(values, "wallColor")
        .name("wall color")
        .onChange(publish),
      cameraFolder
        .add(
          values,
          "cameraDistance",
          PRISM_CAMERA_RANGES.distance.min,
          PRISM_CAMERA_RANGES.distance.max,
          PRISM_CAMERA_RANGES.distance.step
        )
        .name("distance")
        .onChange(publish),
      cameraFolder
        .add(
          values,
          "cameraFov",
          PRISM_CAMERA_RANGES.fov.min,
          PRISM_CAMERA_RANGES.fov.max,
          PRISM_CAMERA_RANGES.fov.step
        )
        .name("FOV")
        .onChange(publish),
      transmissionFolder
        .add(
          values,
          "ior",
          PRISM_GLASS_RANGES.ior.min,
          PRISM_GLASS_RANGES.ior.max,
          PRISM_GLASS_RANGES.ior.step
        )
        .name("IOR")
        .onChange(publish),
      transmissionFolder
        .add(
          values,
          "absorptionR",
          PRISM_GLASS_RANGES.absorption.min,
          PRISM_GLASS_RANGES.absorption.max,
          PRISM_GLASS_RANGES.absorption.step
        )
        .name("absorption R")
        .onChange(publish),
      transmissionFolder
        .add(
          values,
          "absorptionG",
          PRISM_GLASS_RANGES.absorption.min,
          PRISM_GLASS_RANGES.absorption.max,
          PRISM_GLASS_RANGES.absorption.step
        )
        .name("absorption G")
        .onChange(publish),
      transmissionFolder
        .add(
          values,
          "absorptionB",
          PRISM_GLASS_RANGES.absorption.min,
          PRISM_GLASS_RANGES.absorption.max,
          PRISM_GLASS_RANGES.absorption.step
        )
        .name("absorption B")
        .onChange(publish),
      transmissionFolder
        .add(
          values,
          "frostRadius",
          PRISM_GLASS_RANGES.frostRadius.min,
          PRISM_GLASS_RANGES.frostRadius.max,
          PRISM_GLASS_RANGES.frostRadius.step
        )
        .name("frost px")
        .onChange(publish),
      transmissionFolder
        .add(
          values,
          "glassDispersion",
          PRISM_GLASS_RANGES.dispersion.min,
          PRISM_GLASS_RANGES.dispersion.max,
          PRISM_GLASS_RANGES.dispersion.step
        )
        .name("chromatic shift")
        .onChange(publish),
      reflectionFolder
        .add(
          values,
          "reflectionStrength",
          PRISM_GLASS_RANGES.reflectionStrength.min,
          PRISM_GLASS_RANGES.reflectionStrength.max,
          PRISM_GLASS_RANGES.reflectionStrength.step
        )
        .name("strength")
        .onChange(publish),
      reflectionFolder
        .add(
          values,
          "environmentExposure",
          PRISM_GLASS_RANGES.environmentExposure.min,
          PRISM_GLASS_RANGES.environmentExposure.max,
          PRISM_GLASS_RANGES.environmentExposure.step
        )
        .name("env exposure")
        .onChange(publish),
      reflectionFolder
        .add(
          values,
          "iridescenceStrength",
          PRISM_GLASS_RANGES.iridescenceStrength.min,
          PRISM_GLASS_RANGES.iridescenceStrength.max,
          PRISM_GLASS_RANGES.iridescenceStrength.step
        )
        .name("iridescence")
        .onChange(publish),
      reflectionFolder
        .add(
          values,
          "iridescenceFrequency",
          PRISM_GLASS_RANGES.iridescenceFrequency.min,
          PRISM_GLASS_RANGES.iridescenceFrequency.max,
          PRISM_GLASS_RANGES.iridescenceFrequency.step
        )
        .name("film frequency")
        .onChange(publish),
      postprocessFolder
        .add(
          values,
          "bloomStrength",
          PRISM_POSTPROCESS_RANGES.bloomStrength.min,
          PRISM_POSTPROCESS_RANGES.bloomStrength.max,
          PRISM_POSTPROCESS_RANGES.bloomStrength.step
        )
        .name("bloom strength")
        .onChange(publish),
      postprocessFolder
        .add(
          values,
          "bloomThreshold",
          PRISM_POSTPROCESS_RANGES.bloomThreshold.min,
          PRISM_POSTPROCESS_RANGES.bloomThreshold.max,
          PRISM_POSTPROCESS_RANGES.bloomThreshold.step
        )
        .name("threshold")
        .onChange(publish),
      postprocessFolder
        .add(
          values,
          "bloomRadius",
          PRISM_POSTPROCESS_RANGES.bloomRadius.min,
          PRISM_POSTPROCESS_RANGES.bloomRadius.max,
          PRISM_POSTPROCESS_RANGES.bloomRadius.step
        )
        .name("radius")
        .onChange(publish),
      debugFolder
        .add(values, "view", options(PRISM_VIEW_ORDER, PRISM_VIEW_LABELS))
        .name("show")
        .onChange(publish),
      debugFolder.add(values, "wireframe").name("wireframe").onChange(publish),
      debugFolder
        .add(values, "environmentDebug")
        .name("environment debug")
        .onChange(publish),
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
