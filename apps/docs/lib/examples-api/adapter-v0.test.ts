import { describe, expect, it } from 'vitest';
import { adaptLegacySources } from './adapter-v0';

const source = { repository: 'https://github.com/vgpu/vgpu', gitCommit: '75cd72b10d1cd8e629391f9fc6276c50e3553d26' };

describe('legacy byte graph adapter', () => {
  it('preserves historical transport bytes, order, and controlled metadata', () => {
    const graph = adaptLegacySources(
      { gradient: [
        { name: 'example.ts', code: 'export const value = 1;\n' },
        { name: 'shader.wgsl', code: '@fragment fn main() {}\n' },
      ] },
      [{ slug: 'gradient', title: 'Gradient', description: 'Legacy gradient' }],
      source,
    );

    expect(graph.examples[0]).toMatchObject({
      id: 'gradient',
      metadata: {
        title: 'Gradient',
        description: 'Legacy gradient',
        tags: ['gradient', 'rendering'],
        capabilities: [],
      },
    });
    expect(graph.examples[0]!.files.map(({ path, text, contentType }) => ({ path, text, contentType }))).toEqual([
      { path: 'example.ts', text: 'export const value = 1;\n', contentType: 'text/typescript' },
      { path: 'shader.wgsl', text: '@fragment fn main() {}\n', contentType: 'text/wgsl' },
    ]);
  });
});
