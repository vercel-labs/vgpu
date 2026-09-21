import { describe, expect, test } from "vitest";

import { DEFAULT_PRISM_CONTROLS } from "../../types";
import { formatPrismControlChanges } from "./copy-controls";

describe("Prism control clipboard changes", () => {
  test("returns no payload when controls have not changed", () => {
    expect(
      formatPrismControlChanges(
        DEFAULT_PRISM_CONTROLS,
        DEFAULT_PRISM_CONTROLS,
        "light"
      )
    ).toBeNull();
  });

  test("copies only changed shared and active-theme values", () => {
    const controls = {
      ...DEFAULT_PRISM_CONTROLS,
      cameraFov: 55,
      lightMode: {
        ...DEFAULT_PRISM_CONTROLS.lightMode,
        output: {
          ...DEFAULT_PRISM_CONTROLS.lightMode.output,
          exposure: 0.8,
        },
      },
      glass: {
        ...DEFAULT_PRISM_CONTROLS.glass,
        transmission: {
          ...DEFAULT_PRISM_CONTROLS.glass.transmission,
          light: { ior: 1.8, absorption: [0.1, 0.2, 0.3] as const },
          dark: { ior: 2, absorption: [0.9, 0.9, 0.9] as const },
        },
      },
    };
    const text = formatPrismControlChanges(
      controls,
      DEFAULT_PRISM_CONTROLS,
      "light"
    );
    const snapshot = parseSnapshot(text);

    expect(snapshot).toEqual({
      theme: "light",
      changes: {
        shared: { cameraFov: 55 },
        glass: {
          transmission: {
            ior: 1.8,
            absorption: [0.1, 0.2, 0.3],
          },
        },
        lightMode: { output: { exposure: 0.8 } },
      },
    });
  });

  test("includes only changed dark postprocess values", () => {
    const controls = {
      ...DEFAULT_PRISM_CONTROLS,
      postprocess: {
        ...DEFAULT_PRISM_CONTROLS.postprocess,
        bloomStrength: 1.75,
      },
    };
    const snapshot = parseSnapshot(
      formatPrismControlChanges(controls, DEFAULT_PRISM_CONTROLS, "dark")
    );

    expect(snapshot).toEqual({
      theme: "dark",
      changes: { postprocess: { bloomStrength: 1.75 } },
    });
  });

  test("accepts a theme-derived wall color as part of the baseline", () => {
    const baseline = { ...DEFAULT_PRISM_CONTROLS, wallColor: "#e5e1d9" };
    expect(formatPrismControlChanges(baseline, baseline, "light")).toBeNull();
  });
});

function parseSnapshot(text: string | null) {
  const json = text?.match(/```json\n([\s\S]+)\n```/)?.[1];
  if (!json) throw new Error("Missing JSON changes");
  return JSON.parse(json);
}
