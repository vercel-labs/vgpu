import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, DEPTH_MODELS, getDepthModel } from "./renderer";

describe("depth model contract", () => {
  it("declares outputs holding exactly one scalar per pixel", () => {
    for (const model of DEPTH_MODELS) {
      const scalars = model.outputDims.reduce<number>(
        (total, dim) => total * dim,
        1
      );
      expect(scalars, model.id).toBe(model.width * model.height);
    }
  });

  it("feeds MiDaS plain rgb/255 because its graph normalizes internally", () => {
    // Regression guard: the ONNX graph opens with Sub(ImageNet mean) and
    // Div(ImageNet std). Normalizing again here would apply it twice and
    // silently degrade the depth map rather than fail.
    expect(getDepthModel("midas-v21-small-256").normalization).toBe("rgb255");
  });

  it("resolves the default model and rejects unknown ids", () => {
    expect(getDepthModel(DEFAULT_MODEL_ID).id).toBe(DEFAULT_MODEL_ID);
    // @ts-expect-error deliberately outside the union
    expect(() => getDepthModel("not-a-model")).toThrow(/Unknown depth model/);
  });
});
