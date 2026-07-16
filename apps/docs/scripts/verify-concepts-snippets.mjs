#!/usr/bin/env node
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = join(process.cwd(), '..', '..');
const docs = process.cwd();
const contentDir = join(docs, 'content', 'concepts');
const files = readdirSync(contentDir).filter((file) => file.endsWith('.mdx'));
const out = mkdtempSync(join(repo, '.tmp-concept-snippets-'));
let snippets = 0;

try {
  mkdirSync(out, { recursive: true });

  for (const file of files) {
    const text = readFileSync(join(contentDir, file), 'utf8');
    let block = 0;
    for (const match of text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/gu)) {
      block += 1;
      const lang = match[1].trim().toLowerCase();
      if (lang !== 'ts' && lang !== 'typescript') continue;
      snippets += 1;
      const safe = file.replace(/[^A-Za-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
      const name = `${String(snippets).padStart(4, '0')}_${safe}_${block}.ts`;
      writeFileSync(join(out, name), `${match[2].trimEnd()}\n`);
    }
  }

  writeFileSync(join(out, 'tsconfig.json'), JSON.stringify({
    extends: join(repo, 'tsconfig.base.json'),
    compilerOptions: {
      composite: false,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      noEmit: true,
      allowImportingTsExtensions: true,
      types: ['node', '@webgpu/types'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      skipLibCheck: true,
      strict: true,
      baseUrl: repo,
      paths: {
        vgpu: ['packages/vgpu-api/src/index.ts'],
        'vgpu/mock': ['packages/vgpu-api/src/mock.ts'],
        'vgpu/node': ['packages/vgpu-api/src/node.ts'],
        'vgpu/scene': ['packages/vgpu-api/src/scene.ts'],
        'vgpu/core': ['packages/vgpu-api/src/core.ts'],
        '@vgpu/core': ['packages/core/src/index.ts'],
        '@vgpu/wgsl': ['packages/wgsl/src/index.ts']
      }
    },
    include: ['*.ts']
  }, null, 2));

  const tsc = spawnSync('pnpm', ['exec', 'tsc', '-p', join(out, 'tsconfig.json'), '--noEmit', '--pretty', 'false'], { cwd: repo, encoding: 'utf8' });
  if (tsc.status === 0) {
    console.log(`conceptSnippets=${snippets} tsc=OK`);
  } else {
    process.stdout.write(tsc.stdout);
    process.stderr.write(tsc.stderr);
    console.error(`conceptSnippets=${snippets} tsc=FAIL temp=${out}`);
    process.exit(tsc.status ?? 1);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
