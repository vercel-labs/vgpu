import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { exampleComponentLoaders } from './example-components';
import type { ExampleRenderer, RenderSize } from './example-renderer';
import { exampleSlugs } from './example-slugs';
import { exampleSources } from './examples-source.generated';
import { exampleMetadataBySlug } from './examples-metadata';

function sorted(values: readonly string[]) {
  return [...values].sort();
}

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('canonical, metadata, generated source, and component registries cover exactly the same slugs', () => {
  const canonical = sorted(exampleSlugs);
  expect(sorted(Object.keys(exampleMetadataBySlug))).toEqual(canonical);
  expect(sorted(Object.keys(exampleSources))).toEqual(canonical);
  expect(sorted(Object.keys(exampleComponentLoaders))).toEqual(canonical);
});

test('React component loaders resolve the migrated example modules', async () => {
  for (const [slug, load] of Object.entries(exampleComponentLoaders)) {
    const module = await load();
    expect(module.Example, `${slug} loader has no Example export`).toBeTypeOf('function');
  }
});

test('generated metadata and files preserve the canonical and explicit order', () => {
  expect(Object.keys(exampleSources)).toEqual([...exampleSlugs]);
  for (const slug of exampleSlugs) {
    const generated = exampleSources[slug];
    const metadata = exampleMetadataBySlug[slug];
    expect(generated.slug).toBe(slug);
    expect(generated.title).toBe(metadata.title);
    expect(generated.description).toBe(metadata.description);
    expect(generated.tags).toEqual(metadata.tags);
    expect(generated.capabilities).toEqual(metadata.capabilities);
    expect(generated.files.map((file) => file.path)).toEqual(metadata.files);
    for (const file of generated.files) {
      expect(file.content.endsWith('\n')).toBe(true);
      expect(file.content).not.toContain('\r');
    }
  }
});

test('all thumbnail entries satisfy the internal contract and stay out of public source', async () => {
  expect(exampleSlugs).toHaveLength(23);
  const latest = JSON.parse(
    await readFile(
      path.join(docsDir, 'generated/examples-api/examples/v1/latest.json'),
      'utf8'
    )
  ) as { revision: string };

  for (const slug of exampleSlugs) {
    const directory = path.join(docsDir, 'examples', slug);
    const [entrySource, rendererSource, manifestSource] = await Promise.all([
      readFile(path.join(directory, 'render-thumbnail.ts'), 'utf8'),
      readFile(path.join(directory, 'renderer.ts'), 'utf8'),
      readFile(
        path.join(
          docsDir,
          'generated/examples-api/examples/v1/revisions',
          latest.revision,
          'examples',
          slug,
          'manifest.json'
        ),
        'utf8'
      ),
    ]);
    const sourceFile = ts.createSourceFile(
      `${slug}/render-thumbnail.ts`,
      entrySource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const declaration = sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === 'renderThumbnail'
    );
    const modifierKinds = declaration?.modifiers?.map(({ kind }) => kind) ?? [];
    expect(declaration, `${slug} has no named renderThumbnail function`).toBeDefined();
    expect(modifierKinds, `${slug} renderThumbnail is not exported`).toContain(
      ts.SyntaxKind.ExportKeyword
    );
    expect(modifierKinds, `${slug} renderThumbnail is not async`).toContain(
      ts.SyntaxKind.AsyncKeyword
    );
    expect(rendererSource, `${slug}/renderer.ts retains renderThumbnail`).not.toMatch(
      /\brenderThumbnail\b/
    );
    expect(exampleMetadataBySlug[slug].files).not.toContain('render-thumbnail.ts');
    expect(exampleSources[slug].files.map(({ path: file }) => file)).not.toContain(
      'render-thumbnail.ts'
    );
    const manifest = JSON.parse(manifestSource) as {
      files: Array<{ path: string }>;
    };
    expect(manifest.files.map(({ path: file }) => file)).not.toContain(
      'render-thumbnail.ts'
    );
  }
});

interface MockStats {
  initialized: number;
  disposed: number;
  frames: number;
  listeners: number;
  observers: number;
  resizeCalls: RenderSize[];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createMockRenderer(init: Promise<void>, stats: MockStats): ExampleRenderer {
  let disposed = false;
  let raf = 0;
  let resizeRaf = 0;
  let pendingSize: RenderSize | undefined;

  const ready = (async () => {
    await init;
    if (disposed) return;
    stats.initialized++;
    stats.listeners++;
    stats.observers++;
    raf = requestAnimationFrame(() => { if (!disposed) stats.frames++; });
  })();

  return {
    ready,
    invalidate() {},
    resize(size) {
      if (disposed || size.width <= 0 || size.height <= 0) return;
      pendingSize = size;
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (!disposed && pendingSize) stats.resizeCalls.push(pendingSize);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      stats.listeners = 0;
      stats.observers = 0;
      stats.disposed++;
    },
  };
}

let callbacks = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

function flushFrames() {
  const current = [...callbacks.values()];
  callbacks.clear();
  current.forEach((callback) => callback(16));
}

afterEach(() => vi.unstubAllGlobals());

test('StrictMode late init cancellation leaves only the remount alive and dispose is idempotent', async () => {
  callbacks = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));

  const stats: MockStats = { initialized: 0, disposed: 0, frames: 0, listeners: 0, observers: 0, resizeCalls: [] };
  const firstInit = deferred();
  const first = createMockRenderer(firstInit.promise, stats);
  first.dispose();
  first.dispose();
  firstInit.resolve();
  await first.ready;

  const secondInit = deferred();
  const second = createMockRenderer(secondInit.promise, stats);
  secondInit.resolve();
  await second.ready;
  flushFrames();

  expect(stats).toMatchObject({ initialized: 1, disposed: 1, frames: 1, listeners: 1, observers: 1 });
  second.dispose();
  expect(stats).toMatchObject({ disposed: 2, listeners: 0, observers: 0 });
  expect(callbacks.size).toBe(0);
});

test('resize ignores zero size, coalesces bursts, and cancels pending work on dispose', async () => {
  callbacks = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  const stats: MockStats = { initialized: 0, disposed: 0, frames: 0, listeners: 0, observers: 0, resizeCalls: [] };
  const renderer = createMockRenderer(Promise.resolve(), stats);
  await renderer.ready;
  renderer.resize({ width: 0, height: 90, dpr: 1 });
  renderer.resize({ width: 100, height: 90, dpr: 1 });
  renderer.resize({ width: 200, height: 100, dpr: 2 });
  flushFrames();
  expect(stats.resizeCalls).toEqual([{ width: 200, height: 100, dpr: 2 }]);
  renderer.resize({ width: 300, height: 200, dpr: 2 });
  renderer.dispose();
  flushFrames();
  expect(stats.resizeCalls).toHaveLength(1);
});
