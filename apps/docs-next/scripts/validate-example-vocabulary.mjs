import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, '../../..');
const TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRACTAL_TAGS = ['raymarching', 'raymarch', 'fractal', 'sierpinski', 'hdr', 'bloom'];

export function validateValues(kind, id, values, allowed) {
  const seen = new Set();
  for (const value of values) {
    if (!TOKEN.test(value)) throw new Error(`${id}: ${kind} must be lowercase kebab-case: ${value}`);
    if (seen.has(value)) throw new Error(`${id}: duplicate ${kind}: ${value}`);
    if (!allowed.has(value)) throw new Error(`${id}: unknown ${kind}: ${value}`);
    seen.add(value);
  }
}

function parseArray(source, field) {
  const match = source.match(new RegExp(`\\b${field}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
  if (!match) return undefined;
  const values = [];
  for (const item of match[1].matchAll(/(['"])(.*?)\1/g)) values.push(item[2]);
  return values;
}

export async function validateExampleVocabulary(root = defaultRoot) {
  const vocabularyDir = resolve(root, 'apps/docs/lib/examples-api/vocabulary');
  const tags = new Set(JSON.parse(await readFile(resolve(vocabularyDir, 'tags.json'), 'utf8')));
  const capabilities = new Set(JSON.parse(await readFile(resolve(vocabularyDir, 'capabilities.json'), 'utf8')));
  validateValues('tag', 'vocabulary', [...tags], tags);
  validateValues('capability', 'vocabulary', [...capabilities], capabilities);

  const fixture = JSON.parse(await readFile(resolve(root, 'apps/docs/lib/examples-api/fixtures/raymarched-fractal.json'), 'utf8'));
  validateValues('tag', fixture.id, fixture.metadata.tags, tags);
  validateValues('capability', fixture.id, fixture.metadata.capabilities, capabilities);
  for (const required of FRACTAL_TAGS) {
    if (!fixture.metadata.tags.includes(required)) throw new Error(`${fixture.id}: missing required tag: ${required}`);
  }

  const examplesDir = resolve(root, 'apps/docs/examples');
  for (const entry of await readdir(examplesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = await readFile(resolve(examplesDir, entry.name, 'meta.ts'), 'utf8');
    const authoredTags = parseArray(source, 'tags');
    const authoredCapabilities = parseArray(source, 'capabilities');
    if (authoredTags) validateValues('tag', entry.name, authoredTags, tags);
    if (authoredCapabilities) validateValues('capability', entry.name, authoredCapabilities, capabilities);
    if (entry.name === 'raymarched-fractal' && authoredTags) {
      for (const required of FRACTAL_TAGS) if (!authoredTags.includes(required)) throw new Error(`${entry.name}: missing required tag: ${required}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  validateExampleVocabulary().then(() => console.log('Example vocabulary is valid.')).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
