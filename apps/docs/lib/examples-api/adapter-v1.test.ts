import { describe, expect, it } from 'vitest';
import { adaptCanonicalSourceExport } from './adapter-v1';

describe('adapter v1 React source contract', () => {
  it('preserves generated order and bytes while accepting normalized empty vocabularies', () => {
    const graph = adaptCanonicalSourceExport({
      alpha: {
        slug: 'alpha', title: 'Alpha', description: 'First', tags: [], capabilities: [],
        files: [
          { path: 'index.tsx', language: 'tsx', content: 'export default null;\n' },
          { path: 'renderer.ts', language: 'typescript', content: 'export const render = true;\n' },
          { path: 'shader.wgsl', language: 'wgsl', content: '@compute @workgroup_size(1) fn main() {}\n' },
        ],
      },
    }, { repository: 'https://github.com/vgpu/vgpu', gitCommit: '0c77a65' });

    expect(graph.examples[0]).toMatchObject({
      id: 'alpha', metadata: { title: 'Alpha', description: 'First', tags: [], capabilities: [] },
    });
    expect(graph.examples[0]!.files.map(({ path, text, contentType }) => ({ path, text, contentType }))).toEqual([
      { path: 'index.tsx', text: 'export default null;\n', contentType: 'text/typescript' },
      { path: 'renderer.ts', text: 'export const render = true;\n', contentType: 'text/typescript' },
      { path: 'shader.wgsl', text: '@compute @workgroup_size(1) fn main() {}\n', contentType: 'text/wgsl' },
    ]);
  });
});
