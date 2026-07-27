import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_ID,
  DEPTH_MODELS,
  depthByteLength,
  depthElementCount,
  getDepthModel,
  nearnessFor,
} from './model-contract';

describe('depth model contract', () => {
  it('declares input dims that match the declared frame size', () => {
    for (const model of DEPTH_MODELS) {
      expect(model.inputDims, model.id).toEqual([1, 3, model.height, model.width]);
    }
  });

  it('declares outputs holding exactly one scalar per pixel', () => {
    for (const model of DEPTH_MODELS) {
      const scalars = model.outputDims.reduce((total, dim) => total * dim, 1);
      expect(scalars, model.id).toBe(model.width * model.height);
      expect(depthElementCount(model), model.id).toBe(scalars);
      expect(depthByteLength(model), model.id).toBe(scalars * 4);
    }
  });

  it('feeds MiDaS plain rgb/255 because its graph normalizes internally', () => {
    // Regression guard: the ONNX graph opens with Sub(ImageNet mean) and
    // Div(ImageNet std). Normalizing again here would apply it twice and
    // silently degrade the depth map rather than fail.
    expect(getDepthModel('midas-v21-small-256').normalization).toBe('rgb255');
  });

  it('resolves the default model and rejects unknown ids', () => {
    expect(getDepthModel(DEFAULT_MODEL_ID).id).toBe(DEFAULT_MODEL_ID);
    // @ts-expect-error deliberately outside the union
    expect(() => getDepthModel('not-a-model')).toThrow(/Unknown depth model/);
  });

  it('inverts metric depth: nearer metres mean higher nearness', () => {
    const presentation = { mode: 'log-metric', nearMeters: 0.35, farMeters: 10 } as const;
    const near = nearnessFor(presentation, 0.5);
    const far = nearnessFor(presentation, 9);
    expect(near).toBeGreaterThan(far);
    expect(nearnessFor(presentation, 0.35)).toBeCloseTo(1, 5);
    expect(nearnessFor(presentation, 10)).toBeCloseTo(0, 5);
  });

  it('clamps metric depth outside the fixed range instead of wrapping', () => {
    const presentation = { mode: 'log-metric', nearMeters: 0.35, farMeters: 10 } as const;
    expect(nearnessFor(presentation, 0.01)).toBe(1);
    expect(nearnessFor(presentation, 1000)).toBe(0);
  });

  it('rescales relative depth against the frame range without inverting it', () => {
    const presentation = { mode: 'auto-range' } as const;
    const range = { min: 12, max: 60 };
    // Inverse depth already grows towards the camera, so the maximum is nearest.
    expect(nearnessFor(presentation, 60, range)).toBeCloseTo(1, 6);
    expect(nearnessFor(presentation, 12, range)).toBeCloseTo(0, 6);
    expect(nearnessFor(presentation, 36, range)).toBeCloseTo(0.5, 6);
  });

  it('survives a flat depth field rather than dividing by zero', () => {
    expect(nearnessFor({ mode: 'auto-range' }, 5, { min: 5, max: 5 })).toBe(0);
  });
});
