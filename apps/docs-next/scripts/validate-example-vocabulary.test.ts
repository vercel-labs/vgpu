import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateExampleVocabulary, validateValues } from './validate-example-vocabulary.mjs';

const acceptedAllTenTags = [
  'batch-rendering', 'black-hole', 'chromatic-aberration', 'color-grading', 'fxaa', 'indirect-rendering',
  'led', 'lighting', 'msaa', 'navier-stokes', 'performance', 'raycasting', 'render-bundles', 'shader',
  'simulation', 'ssaa', 'triangle',
];
const acceptedAllTenCapabilities = [
  'checkbox-controls', 'compute-shader', 'continuous-rendering', 'demand-rendering', 'fixed-timestep',
  'fragment-shader', 'instanced-rendering', 'offscreen-rendering', 'pointer-input', 'pointer-orbit',
  'render-targets', 'resize', 'responsive-canvas', 'select-control', 'webgpu',
];

describe('example vocabulary validation', () => {
  it('accepts the checked-in vocabularies, fixtures, and authored metadata', async () => {
    await expect(validateExampleVocabulary()).resolves.toBeUndefined();
  });

  it('controls every author-reviewed all-ten checkpoint term', async () => {
    const vocabularyDir = resolve(process.cwd(), 'apps/docs/lib/examples-api/vocabulary');
    const tags = new Set(JSON.parse(await readFile(resolve(vocabularyDir, 'tags.json'), 'utf8')) as string[]);
    const capabilities = new Set(
      JSON.parse(await readFile(resolve(vocabularyDir, 'capabilities.json'), 'utf8')) as string[],
    );

    expect(acceptedAllTenTags.filter((value) => !tags.has(value))).toEqual([]);
    expect(acceptedAllTenCapabilities.filter((value) => !capabilities.has(value))).toEqual([]);
  });

  it('rejects unknown, non-lowercase, and duplicate terms', () => {
    const allowed = new Set(['raymarching']);
    expect(() => validateValues('tag', 'x', ['unknown'], allowed)).toThrow(/unknown/);
    expect(() => validateValues('tag', 'x', ['Raymarching'], allowed)).toThrow(/lowercase/);
    expect(() => validateValues('tag', 'x', ['raymarching', 'raymarching'], allowed)).toThrow(/duplicate/);
  });
});
