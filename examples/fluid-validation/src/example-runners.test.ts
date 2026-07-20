import { describe, expect, test } from 'vitest';
import { exampleRunnerSlugs } from '../../../apps/docs/lib/example-runner-slugs';
import { examples } from '../../../apps/docs/lib/examples-registry';

describe('docs gallery runner registry', () => {
  test('every registered example has an interactive browser runner', () => {
    const slugs = examples.map((example) => example.meta.slug).sort();
    expect([...exampleRunnerSlugs].sort()).toEqual(slugs);
  });
});
