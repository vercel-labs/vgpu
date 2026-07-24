import { describe, expect, test } from 'vitest';
import { exampleComponentLoaders } from '../../../apps/docs/lib/example-components';
import { examples } from '../../../apps/docs/lib/examples-registry';

describe('docs gallery component registry', () => {
  test('every registered example has a React component loader', () => {
    const slugs = examples.map((example) => example.meta.slug).sort();
    expect(Object.keys(exampleComponentLoaders).sort()).toEqual(slugs);
  });
});
