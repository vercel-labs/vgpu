import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplesDir = path.join(docsDir, 'examples');
const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx'];
const forbiddenPackages = new Set([
  'fs', 'node:fs', 'path', 'node:path', 'child_process', 'node:child_process',
  'worker_threads', 'node:worker_threads', 'vgpu/node', '@vgpu/adapter-node',
]);

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function resolveRelative(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  for (const suffix of extensions) {
    const candidate = `${base}${suffix}`;
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function checkGraph(entry, kind) {
  const pending = [entry];
  const visited = new Set();
  const failures = [];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, 'utf8');
    const imports = ts.preProcessFile(source, true, true).importedFiles.map(({ fileName }) => fileName);
    for (const specifier of imports) {
      if (forbiddenPackages.has(specifier) || specifier.startsWith('node:')) {
        failures.push(`${path.relative(docsDir, file)} imports forbidden module ${specifier}`);
        continue;
      }
      if (kind === 'component' && (
        specifier.includes('examples-source.generated') ||
        specifier.includes('examples-registry') ||
        specifier.includes('/scripts/')
      )) failures.push(`${path.relative(docsDir, file)} imports server/source module ${specifier}`);
      if (specifier.startsWith('.')) {
        const resolved = await resolveRelative(file, specifier);
        if (resolved) pending.push(resolved);
      }
    }
  }
  return failures;
}

const failures = [];
let migrated = 0;
for (const entry of await (await import('node:fs/promises')).readdir(examplesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const index = path.join(examplesDir, entry.name, 'index.tsx');
  if (!(await exists(index))) continue;
  migrated++;
  const renderer = path.join(examplesDir, entry.name, 'renderer.ts');
  if (!(await exists(renderer))) {
    failures.push(`${entry.name} has index.tsx but no renderer.ts`);
    continue;
  }
  failures.push(...await checkGraph(index, 'component'));
  failures.push(...await checkGraph(renderer, 'renderer'));
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Example import boundary check passed for ${migrated} migrated examples.`);
}
