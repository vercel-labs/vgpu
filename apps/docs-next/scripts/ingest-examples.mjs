import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const defaultDocsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = process.env.VGPU_DOCS_DIR ? path.resolve(process.env.VGPU_DOCS_DIR) : defaultDocsDir;
const examplesDir = path.join(docsDir, 'examples');
const publicExamplesDir = path.join(docsDir, 'public', 'examples');
const sourcesOutFile = path.join(docsDir, 'lib', 'examples-source.generated.ts');
const thumbsOutFile = path.join(docsDir, 'lib', 'example-thumbs.generated.ts');
const slugsFile = path.join(docsDir, 'lib', 'example-slugs.ts');
const componentsFile = path.join(docsDir, 'lib', 'example-components.ts');

function normalizeLf(source) {
  const normalized = source.replace(/\r\n?/g, '\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function languageFor(file) {
  if (file.endsWith('.wgsl')) return 'wgsl';
  if (file.endsWith('.tsx')) return 'tsx';
  if (file.endsWith('.ts')) return 'typescript';
  if (file.endsWith('.json')) return 'json';
  return 'text';
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
}

function findObject(source, variableName, fileName) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName || !declaration.initializer) continue;
      let initializer = declaration.initializer;
      while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer)) {
        initializer = initializer.expression;
      }
      if (ts.isObjectLiteralExpression(initializer)) return initializer;
    }
  }
  throw new Error(`${fileName} must declare '${variableName}' as an object literal.`);
}

function objectProperties(object) {
  const result = new Map();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name) result.set(name, property.initializer);
  }
  return result;
}

function stringValue(node, label) {
  if (!node || !ts.isStringLiteralLike(node)) throw new Error(`${label} must be a string literal.`);
  return node.text;
}

function stringArray(node, label) {
  if (!node || !ts.isArrayLiteralExpression(node)) throw new Error(`${label} must be an explicit array literal.`);
  return node.elements.map((item, index) => stringValue(item, `${label}[${index}]`));
}

async function readMetadata(slug) {
  const fileName = path.join(examplesDir, slug, 'meta.ts');
  const source = normalizeLf(await readFile(fileName, 'utf8'));
  const properties = objectProperties(findObject(source, 'meta', fileName));
  const metadata = {
    slug: stringValue(properties.get('slug'), `${slug}/meta.ts slug`),
    title: stringValue(properties.get('title'), `${slug}/meta.ts title`),
    description: stringValue(properties.get('description'), `${slug}/meta.ts description`),
    tags: stringArray(properties.get('tags'), `${slug}/meta.ts tags`),
    capabilities: stringArray(properties.get('capabilities'), `${slug}/meta.ts capabilities`),
    files: stringArray(properties.get('files'), `${slug}/meta.ts files`),
  };
  if (metadata.slug !== slug) throw new Error(`${slug}/meta.ts declares mismatched slug '${metadata.slug}'.`);
  return metadata;
}

function assertSameSet(label, actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((item) => !actualSet.has(item));
  const extra = actual.filter((item) => !expectedSet.has(item));
  if (actualSet.size !== actual.length) throw new Error(`${label} contains duplicate entries.`);
  if (missing.length || extra.length) {
    throw new Error(`${label} slug mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}).`);
  }
}

async function canonicalSlugs() {
  const source = normalizeLf(await readFile(slugsFile, 'utf8'));
  const file = ts.createSourceFile(slugsFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'exampleSlugs' || !declaration.initializer) continue;
      let node = declaration.initializer;
      while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
      return stringArray(node, 'exampleSlugs');
    }
  }
  throw new Error('example-slugs.ts must contain an exampleSlugs tuple.');
}

async function registryKeys(fileName, variableName) {
  const source = normalizeLf(await readFile(fileName, 'utf8'));
  return [...objectProperties(findObject(source, variableName, fileName)).keys()];
}

async function validatedFiles(metadata) {
  const seen = new Set();
  const directory = path.join(examplesDir, metadata.slug);
  for (const name of metadata.files) {
    if (!name || path.isAbsolute(name) || name.includes('\\') || name.split('/').includes('..') || path.posix.normalize(name) !== name) {
      throw new Error(`${metadata.slug}/meta.ts contains unsafe file path '${name}'.`);
    }
    if (seen.has(name)) throw new Error(`${metadata.slug}/meta.ts contains duplicate file '${name}'.`);
    seen.add(name);
    const resolved = path.resolve(directory, name);
    if (resolved !== directory && !resolved.startsWith(`${directory}${path.sep}`)) throw new Error(`${metadata.slug}/${name} escapes its example directory.`);
    const info = await stat(resolved).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error(`${metadata.slug}/meta.ts lists missing file '${name}'.`);
      throw error;
    });
    if (!info.isFile()) throw new Error(`${metadata.slug}/meta.ts path '${name}' is not a file.`);
  }

  if (!seen.has('index.tsx') || !seen.has('renderer.ts')) {
    throw new Error(`${metadata.slug}/meta.ts must list both index.tsx and renderer.ts.`);
  }
  if (metadata.files[0] !== 'index.tsx') {
    throw new Error(`${metadata.slug}/meta.ts must list index.tsx first.`);
  }
  return metadata.files;
}

async function writeIfChanged(fileName, source) {
  const previous = await readFile(fileName, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (previous === source) return false;
  await mkdir(path.dirname(fileName), { recursive: true });
  await writeFile(fileName, source);
  return true;
}

async function writeSources(slugs, metadataBySlug) {
  const data = {};
  for (const slug of slugs) {
    const metadata = metadataBySlug.get(slug);
    const names = await validatedFiles(metadata);
    const files = [];
    for (const name of names) {
      const content = normalizeLf(await readFile(path.join(examplesDir, slug, name), 'utf8'));
      files.push({ path: name, language: languageFor(name), content });
    }
    data[slug] = { ...metadata, files };
  }

  const source = `// This file is generated by scripts/ingest-examples.mjs. Do not edit by hand.\nimport 'server-only';\n\nimport type { ExampleSlug } from './example-slugs';\n\nexport interface GeneratedExampleSourceFile {\n  readonly path: string;\n  readonly language: string;\n  readonly content: string;\n}\n\nexport interface GeneratedExampleSource {\n  readonly slug: ExampleSlug;\n  readonly title: string;\n  readonly description: string;\n  readonly tags: readonly string[];\n  readonly capabilities: readonly string[];\n  readonly files: readonly GeneratedExampleSourceFile[];\n}\n\nexport const exampleSources = ${JSON.stringify(data, null, 2)} as const satisfies Record<ExampleSlug, GeneratedExampleSource>;\n`;
  const changed = await writeIfChanged(sourcesOutFile, source);
  console.log(`${changed ? 'Wrote' : 'Unchanged'} ${path.relative(docsDir, sourcesOutFile)} for ${slugs.length} examples.`);
}

async function writeThumbs() {
  const entries = await readdir(publicExamplesDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const slugs = new Set();
  for (const name of files) {
    const match = name.match(/^(.+)\.(card|hero)\.png$/);
    if (match) slugs.add(match[1]);
  }
  const thumbs = {};
  for (const slug of [...slugs].sort()) {
    if (files.has(`${slug}.card.png`) && files.has(`${slug}.hero.png`)) {
      thumbs[slug] = { card: `/examples/${slug}.card.png`, hero: `/examples/${slug}.hero.png` };
    }
  }
  const source = `// This file is generated by scripts/ingest-examples.mjs. Do not edit by hand.\n\nexport interface ExampleThumbPresence {\n  readonly card: string;\n  readonly hero: string;\n}\n\nexport const exampleThumbs: Record<string, ExampleThumbPresence> = ${JSON.stringify(thumbs, null, 2)};\n`;
  const changed = await writeIfChanged(thumbsOutFile, source);
  console.log(`${changed ? 'Wrote' : 'Unchanged'} ${path.relative(docsDir, thumbsOutFile)} for ${Object.keys(thumbs).length} thumbnail sets.`);
}

const slugs = await canonicalSlugs();
const entries = await readdir(examplesDir, { withFileTypes: true });
const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
assertSameSet('example folders', folders, slugs);

const metadata = await Promise.all(slugs.map(readMetadata));
assertSameSet('metadata', metadata.map((item) => item.slug), slugs);
const loaderSlugs = await registryKeys(componentsFile, 'exampleComponentLoaders');
assertSameSet('React loaders', loaderSlugs, slugs);

await writeSources(slugs, new Map(metadata.map((item) => [item.slug, item])));
await writeThumbs();
