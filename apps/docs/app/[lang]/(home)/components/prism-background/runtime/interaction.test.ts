import { describe, expect, test, vi } from "vitest";

import {
  automaticPointerPosition,
  createPrismInteraction,
} from "./interaction";

describe("prism interaction", () => {
  test("moves the virtual mobile pointer around a slow centered circle", () => {
    expect(automaticPointerPosition(0)[0]).toBeCloseTo(0.84);
    expect(automaticPointerPosition(0)[1]).toBeCloseTo(0.5);
    expect(automaticPointerPosition(4.5)[0]).toBeCloseTo(0.5);
    expect(automaticPointerPosition(4.5)[1]).toBeCloseTo(0.84);
    expect(automaticPointerPosition(9)[0]).toBeCloseTo(0.16);
    expect(automaticPointerPosition(9)[1]).toBeCloseTo(0.5);
    expect(automaticPointerPosition(18)[0]).toBeCloseTo(0.84);
    expect(automaticPointerPosition(18)[1]).toBeCloseTo(0.5);
  });

  test("feeds automatic positions through the same eased aim and orbit path", () => {
    const invalidate = vi.fn();
    const canvas = {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
      }),
    } as HTMLCanvasElement;
    const interaction = createPrismInteraction(canvas, invalidate);

    interaction.setNormalizedPointer([0.84, 0.5]);

    expect(interaction.stepAim()).toEqual([0.5, 0.5408]);
    expect(interaction.stepOrbit()).toEqual([0.0544, 0]);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
