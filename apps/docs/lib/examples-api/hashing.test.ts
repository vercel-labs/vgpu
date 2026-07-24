import { describe, expect, it } from 'vitest';
import { buildByteGraph, canonicalExampleBytes, canonicalRevisionBytes, sha256 } from './hashing';

const input = [{
  id: 'raymarched-fractal',
  metadata: { title: 'Fractal', description: 'Raymarching.', tags: ['raymarching'], capabilities: ['compute'] },
  files: [{ path: 'renderer.ts', text: 'export const x = 1;\n', contentType: 'text/typescript' as const }],
}];

describe('ExampleByteGraph hashing', () => {
  it('builds stable, independently recomputable file, aggregate, and revision hashes', () => {
    const graph = buildByteGraph(input, { repository: 'https://github.com/vgpu/vgpu', gitCommit: 'abc123' });
    const example = graph.examples[0]!;
    expect(example.files[0]!.sha256).toBe(sha256(Buffer.from(example.files[0]!.text)));
    expect(example.aggregateSha256).toBe(sha256(canonicalExampleBytes(example)));
    expect(graph.revision).toBe(sha256(canonicalRevisionBytes(graph)));
    expect(buildByteGraph(input, graph.source)).toEqual(graph);
  });

  it.each([
    ['CRLF', 'bad\r\n'], ['missing final LF', 'bad'], ['NUL', 'bad\0value'],
  ])('rejects invalid %s source bytes', (_name, text) => {
    expect(() => buildByteGraph([{ ...input[0]!, files: [{ ...input[0]!.files[0]!, text }] }], { repository: 'repo', gitCommit: 'abc' })).toThrow();
  });

  it('rejects unsafe, duplicate, or unordered identities and paths', () => {
    const source = { repository: 'repo', gitCommit: 'abc' };
    expect(() => buildByteGraph([{ ...input[0]!, files: [{ ...input[0]!.files[0]!, path: '../x.ts' }] }], source)).toThrow(/path/i);
    expect(() => buildByteGraph([input[0]!, input[0]!], source)).toThrow(/duplicate/i);
  });
});
