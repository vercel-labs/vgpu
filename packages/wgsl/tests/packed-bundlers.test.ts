import { createRequire } from "node:module";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareShader } from "@vgpu/wgsl/prepare";
import type { ShaderSource } from "@vgpu/wgsl";
import wgslVitePlugin from "@vgpu/wgsl/loader-vite";
import { decodePackedMetadata } from "../src/packed/decode.ts";
import { encodePackedMetadata } from "../src/packed/encode.ts";
import { PACKED_QUERY_MAX_BYTES } from "../src/loader-shared/packed-query.ts";
import { selectPackedReflection } from "../src/loader-shared/packed-selection.ts";
import { build as viteBuild, createServer, type InlineConfig, type ViteDevServer } from "vite";
import webpack, { type Compiler, type Configuration, type Stats, type Watching } from "webpack";
import type { RollupWatcher } from "rollup";
import { describe, expect, test } from "vitest";
import {
  createPackedBundlerFixture,
  type PackedBundlerFixture,
} from "./helpers/packed-bundler-fixture.ts";

const require = createRequire(import.meta.url);
const QUERY = /\?__vgpu_packed_v1=[A-Za-z0-9_-]+/gu;
const FORBIDDEN_BROWSER_MODULES = [
  "/packed/encode",
  "/loader-shared/packed-selection",
  "/loader-shared/packed-query",
  "/prepare",
  "/scanner",
  "/parser",
  "/reflection",
  "/resolver",
  "/runtime/",
  "/cli/",
  "/three/",
  "/native/",
] as const;

interface BuiltGraph {
  readonly eager: readonly [ShaderSource, ShaderSource];
  readonly loadCold: () => Promise<ShaderSource>;
  readonly moduleIds: readonly string[];
  readonly entryModuleIds: readonly string[];
  readonly lazyModuleIds: readonly string[];
  readonly queryIds: readonly string[];
  readonly reusedQuery: boolean;
  readonly entryText: string;
  readonly lazyText: string;
  readonly emittedText: string;
}

interface BundlerHarness {
  readonly name: "Vite" | "webpack";
  build(fixture: PackedBundlerFixture, options?: { readonly cache?: string; readonly entry?: string }): Promise<BuiltGraph>;
}

const harnesses: readonly BundlerHarness[] = [
  { name: "Vite", build: buildVite },
  { name: "webpack", build: buildWebpack },
];

describe.each(harnesses)("$name packed metadata graph", (harness) => {
  test("retains exact eager/lazy v2 artifacts and removes the unused shader", async () => {
    const fixture = await createPackedBundlerFixture();
    try {
      const graph = await harness.build(fixture);
      const [shaderA, shaderB] = graph.eager;

      expectExactLoaderArtifact(shaderA, join(fixture.root, "src/shader-a.wgsl"));
      expectExactLoaderArtifact(shaderB, join(fixture.root, "src/shader-b.wgsl"));
      expect(Buffer.byteLength(JSON.stringify(shaderA.reflection))).toBeGreaterThanOrEqual(32 * 1024);
      expect(Buffer.byteLength(JSON.stringify(shaderB.reflection))).toBeGreaterThanOrEqual(32 * 1024);
      expect(graph.queryIds.length).toBeGreaterThan(0);
      expect(graph.reusedQuery).toBe(true);
      expect(graph.emittedText).toContain("decodePackedMetadata");
      expect(graph.entryModuleIds.some((id) => id.includes("shader-c.wgsl"))).toBe(false);
      expect(graph.entryText).not.toContain("cold_main");
      expect(graph.entryText).not.toContain("ColdOnlyRecord");
      expect(graph.lazyText).toContain("cold_main");
      expect(graph.lazyText).toContain("ColdOnlyRecord");
      expect(graph.moduleIds.some((id) => id.includes("shader-d.wgsl"))).toBe(false);
      expect(graph.emittedText).not.toContain("DeadOnlyMarker");
      expect(graph.emittedText).not.toContain("dead_main");

      const aNames = shaderA.reflection.bindings.map((binding) => binding.name);
      const bNames = shaderB.reflection.bindings.map((binding) => binding.name);
      expect(aNames).toContain("uniqueA");
      expect(aNames).not.toContain("uniqueB");
      expect(bNames).toContain("uniqueB");
      expect(bNames).not.toContain("uniqueA");

      const beforeB = structuredClone(shaderB.reflection);
      const beforeAHost = structuredClone((shaderA.reflection as any).hostShareableLayouts[0]);
      (shaderA.reflection as any).bindings[0].layout.members[0].name = "mutated-a";
      expect(shaderB.reflection).toStrictEqual(beforeB);
      expect((shaderA.reflection as any).hostShareableLayouts[0]).toStrictEqual(beforeAHost);
      expect((shaderA.reflection as any).bindings[0].layout)
        .not.toBe((shaderA.reflection as any).hostShareableLayouts[0]);

      const cold = await graph.loadCold();
      expectExactLoaderArtifact(cold, join(fixture.root, "src/shader-c.wgsl"));
      expect(cold.reflection.structs.some((item) => item.name === "ColdOnlyRecord")).toBe(true);
      expect(cold.reflection).not.toBe(shaderA.reflection);
      expect(cold.reflection).not.toBe(shaderB.reflection);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  test("removes stale packed helpers when one eager shader becomes plain and restores them on recovery", async () => {
    const fixture = await createPackedBundlerFixture();
    const shaderAPath = join(fixture.root, "src/shader-a.wgsl");
    const shaderBPath = join(fixture.root, "src/shader-b.wgsl");
    const transitionEntry = join(fixture.root, "src/transition-entry.mjs");
    const cache = join(fixture.root, ".cache-transition", harness.name.toLowerCase());
    try {
      const originalA = await readFile(shaderAPath, "utf8");
      const original = await readFile(shaderBPath, "utf8");
      await writeFile(transitionEntry, `
import shaderA from "./shader-a.wgsl";
import shaderB from "./shader-b.wgsl";
export const eager = [shaderA, shaderB];
export async function loadCold() { return shaderA; }
`);
      const packed = await harness.build(fixture, { cache, entry: transitionEntry });
      expect(packed.queryIds.length).toBeGreaterThan(0);
      expect(packed.emittedText).toContain("decodePackedMetadata");
      expectExactLoaderArtifact(packed.eager[0], shaderAPath);
      expectExactLoaderArtifact(packed.eager[1], shaderBPath);
      expect(selectPackedReflection(packed.eager[0].reflection)).not.toBeNull();
      expect(selectPackedReflection(packed.eager[1].reflection)).not.toBeNull();

      await writeFile(shaderBPath, singleUniformFallbackShader("B"));
      const mixed = await harness.build(fixture, { cache, entry: transitionEntry });
      expectExactLoaderArtifact(mixed.eager[0], join(fixture.root, "src/shader-a.wgsl"));
      expectExactLoaderArtifact(mixed.eager[1], shaderBPath);
      expect(selectPackedReflection(mixed.eager[0].reflection)).not.toBeNull();
      expect(selectPackedReflection(mixed.eager[1].reflection)).toBeNull();
      expect(mixed.emittedText).toContain("decodePackedMetadata");
      expect(mixed.reusedQuery).toBe(false);

      await writeFile(shaderAPath, singleUniformFallbackShader("A"));
      const plain = await harness.build(fixture, { cache, entry: transitionEntry });
      expect(plain.queryIds).toEqual([]);
      expect(plain.emittedText).not.toContain("decodePackedMetadata");
      expectExactLoaderArtifact(plain.eager[0], shaderAPath);
      expectExactLoaderArtifact(plain.eager[1], shaderBPath);
      expect(selectPackedReflection(plain.eager[0].reflection)).toBeNull();
      expect(selectPackedReflection(plain.eager[1].reflection)).toBeNull();

      await Promise.all([
        writeFile(shaderAPath, originalA),
        writeFile(shaderBPath, original),
      ]);
      const recovered = await harness.build(fixture, { cache, entry: transitionEntry });
      expect(recovered.queryIds.length).toBeGreaterThan(0);
      expect(recovered.emittedText).toContain("decodePackedMetadata");
      expect(recovered.queryIds).toEqual(packed.queryIds);
      expect(recovered.eager).toStrictEqual(packed.eager);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  test("keeps identical rebuilds stable, invalidates transitive edits, and uses inline query-cap fallback", async () => {
    const fixture = await createPackedBundlerFixture();
    try {
      const cache = join(fixture.root, ".cache", harness.name.toLowerCase());
      const first = await harness.build(fixture, { cache });
      const warm = await harness.build(fixture, { cache });
      expect(warm.eager).toStrictEqual(first.eager);
      expect(warm.queryIds).toEqual(first.queryIds);

      await writeFile(fixture.transitive, `
export struct SharedHelper { value: vec4f, changed: mat4x4f }
export fn shared_color() -> vec4f { return vec4f(0.75, 0.5, 0.25, 1.0); }
`);
      const edited = await harness.build(fixture, { cache });
      expect(edited.eager[0].sourceChecksum).not.toBe(first.eager[0].sourceChecksum);
      expect(edited.eager[0].reflection).not.toStrictEqual(first.eager[0].reflection);
      expect(edited.eager[1]).toStrictEqual(first.eager[1]);

      const capEntry = join(fixture.root, "src/cap-entry.mjs");
      await writeFile(capEntry, 'import shader from "./cap-fallback.wgsl"; export const eager = [shader, shader]; export async function loadCold() { return shader; }\n');
      const capped = await harness.build(fixture, { cache: join(fixture.root, ".cache-cap"), entry: capEntry });
      const artifact = capped.eager[0];
      const capLayout = artifact.reflection.bindings.find((binding) => binding.name === "cap0")?.layout;
      if (capLayout === undefined) throw new Error("query-cap fixture lost cap0 layout");
      const candidateBytes = Buffer.byteLength(JSON.stringify(capLayout));
      const candidateTable = encodePackedMetadata(capLayout);
      if (candidateTable === null) throw new Error("query-cap fixture stopped being encodable");
      const uncappedQuery = `?__vgpu_packed_v1=${Buffer.from(JSON.stringify(candidateTable)).toString("base64url")}`;
      expect(candidateBytes).toBeGreaterThanOrEqual(256);
      expect(candidateBytes).toBeLessThanOrEqual(8192);
      expect(Buffer.byteLength(uncappedQuery, "ascii")).toBeGreaterThan(PACKED_QUERY_MAX_BYTES);
      expect(capped.emittedText).toContain("decodePackedMetadata");
      expect(capped.queryIds.some((query) => JSON.stringify(decodeQuery(query)).includes("sharedControl0"))).toBe(true);
      expect(capped.queryIds).not.toContain(uncappedQuery);
      expect(capped.queryIds.every((query) => Buffer.byteLength(query, "ascii") <= PACKED_QUERY_MAX_BYTES)).toBe(true);
      expectExactLoaderArtifact(artifact, join(fixture.root, "src/cap-fallback.wgsl"));
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  test("isolates simultaneous roots and keeps content-derived query identities", async () => {
    const [firstFixture, secondFixture] = await Promise.all([
      createPackedBundlerFixture(),
      createPackedBundlerFixture(),
    ]);
    try {
      const secondEntry = await readFile(secondFixture.entry, "utf8");
      await writeFile(secondFixture.entry, secondEntry
        .replace('import shaderA from "./shader-a.wgsl";\nimport shaderB from "./shader-b.wgsl";', 'import shaderB from "./shader-b.wgsl";\nimport shaderA from "./shader-a.wgsl";')
        .replace("[shaderA, shaderB]", "[shaderB, shaderA]"));
      const secondA = join(secondFixture.root, "src/shader-a.wgsl");
      await writeFile(secondA, (await readFile(secondA, "utf8")).replaceAll("uniqueA", "uniqueSecondRoot"));

      const [first, second] = await Promise.all([
        harness.build(firstFixture, { cache: join(firstFixture.root, ".cache") }),
        harness.build(secondFixture, { cache: join(secondFixture.root, ".cache") }),
      ]);

      expect(first.eager[0].wgsl).toContain("uniqueA");
      expect(first.emittedText).not.toContain("uniqueSecondRoot");
      expect(second.eager.some((shader) => shader.wgsl.includes("uniqueSecondRoot"))).toBe(true);
      expect(second.emittedText).not.toContain("DeadOnlyMarker");
      expect(first.queryIds.some((query) => second.queryIds.includes(query))).toBe(true);
    } finally {
      await Promise.all([firstFixture.dispose(), secondFixture.dispose()]);
    }
  }, 30_000);

  test("retained browser closure contains the decoder but no producer or parser", async () => {
    const fixture = await createPackedBundlerFixture();
    try {
      const graph = await harness.build(fixture);
      const normalized = graph.moduleIds.map(normalizeModuleId);
      expect(graph.emittedText).toContain("decodePackedMetadata");
      for (const forbidden of FORBIDDEN_BROWSER_MODULES) {
        expect(normalized.some((id) => id.includes(forbidden)), `unexpected retained module ${forbidden}`).toBe(false);
      }
      expect(graph.emittedText).not.toContain("prepareShader");
      expect(graph.emittedText).not.toContain("reflectSource");
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});

test("Vite detector retains preparation code for an explicit browser prepareShader import", async () => {
  const fixture = await createPackedBundlerFixture();
  try {
    const entry = join(fixture.root, "src/prepare-control.mjs");
    await writeFile(entry, `
import { prepareShader } from ${JSON.stringify(require.resolve("@vgpu/wgsl/prepare"))};
export default prepareShader("@compute @workgroup_size(1) fn main() {}");
`);
    const result = asViteOutputs(await viteBuild(viteConfig(fixture, entry)));
    const modules = result.flatMap((output) => output.output)
      .filter((item) => item.type === "chunk")
      .flatMap((chunk) => Object.keys(chunk.modules).map(normalizeModuleId));
    expect(modules.some((id) => id.includes("/prepare"))).toBe(true);
    expect(modules.some((id) => id.includes("/scanner") || id.includes("/parser") || id.includes("/reflection"))).toBe(true);
  } finally {
    await fixture.dispose();
  }
}, 30_000);

test("Vite dev graph stays exact across cache restart and a later transitive edit", async () => {
  const fixture = await createPackedBundlerFixture();
  const cacheDir = join(fixture.root, ".vite-dev-cache");
  let server: ViteDevServer | undefined;
  try {
    server = await createViteDevServer(fixture, cacheDir);
    const first = await loadViteDevEntry(server);
    expectExactLoaderArtifact(first.eager[0], join(fixture.root, "src/shader-a.wgsl"));
    const firstArtifact = structuredClone(first.eager[0]);
    const firstQueries = viteDevQueryUrls(server);
    expect(firstQueries.length).toBeGreaterThan(0);
    expect(firstQueries.some((url) => url.includes("/@fs/"))).toBe(true);

    await server.close();
    server = await createViteDevServer(fixture, cacheDir);
    const warm = await loadViteDevEntry(server);
    expect(warm.eager[0]).toStrictEqual(firstArtifact);
    expect(viteDevQueryUrls(server)).toEqual(firstQueries);

    const changed = waitForViteDevChange(server, fixture.transitive);
    await writeFile(fixture.transitive, `
export struct SharedHelper { value: vec4f, changedAfterRestart: mat4x4f }
export fn shared_color() -> vec4f { return vec4f(0.5, 0.75, 0.25, 1.0); }
`);
    await changed;
    const edited = await loadViteDevEntry(server);
    expect(edited.eager[0].sourceChecksum).not.toBe(firstArtifact.sourceChecksum);
    expect(edited.eager[0].wgsl).toContain("changedAfterRestart");
    expectExactLoaderArtifact(edited.eager[0], join(fixture.root, "src/shader-a.wgsl"));
  } finally {
    await server?.close();
    await fixture.dispose();
  }
}, 60_000);

test("Vite watch rebuilds edits, prunes removed imports, reports deletion, and recovers", async () => {
  const fixture = await createPackedBundlerFixture();
  const events = eventQueue<WatchEvent>((event) => event.error === undefined
    ? `successful build; watched ${event.watched.join(", ")}`
    : `build error: ${String(event.error)}; watched ${event.watched.join(", ")}`);
  const output = join(fixture.output, "vite-watch");
  let watcher: RollupWatcher | undefined;
  try {
    const config = viteConfig(fixture, fixture.entry);
    config.plugins = [
      ...(config.plugins ?? []),
      {
        name: "vgpu-packed-watch-receipt",
        buildEnd(error) {
          if (error) events.push({ error, watched: [...this.getWatchFiles()] });
        },
        writeBundle() {
          events.push({ watched: [...this.getWatchFiles()] });
        },
      },
    ];
    config.build = {
      ...config.build,
      outDir: output,
      watch: {
        clearScreen: false,
        chokidar: { usePolling: true, interval: 50 },
      },
    };
    const running = await viteBuild(config);
    if (!("on" in running)) throw new Error("Vite did not return a watcher");
    watcher = running;

    expect((await events.next()).error).toBeUndefined();
    const initial = await loadViteWatchEntry(output);
    const initialReflection = initial.eager[0].reflection;
    const initialChecksum = initial.eager[0].sourceChecksum;

    const editedTransitive = `
export struct SharedHelper { value: vec4f, changed: mat4x4f }
export fn shared_color() -> vec4f { return vec4f(0.75, 0.5, 0.25, 1.0); }
`;
    await writeFile(fixture.transitive, editedTransitive);
    expect((await events.next()).error).toBeUndefined();
    const edited = await loadViteWatchEntry(output);
    expect(edited.eager[0].sourceChecksum).not.toBe(initialChecksum);
    expect(edited.eager[0].reflection).not.toStrictEqual(initialReflection);

    const shaderAPath = join(fixture.root, "src/shader-a.wgsl");
    const importedA = await readFile(shaderAPath, "utf8");
    await writeFile(shaderAPath, withoutTransitiveImport(importedA));
    expect((await events.next()).error).toBeUndefined();
    const pruned = await loadViteWatchEntry(output);
    expect(pruned.eager[0].wgsl).not.toContain("SharedHelper");
    expect(hasStruct(pruned.eager[0], "SharedHelper")).toBe(false);
    expect(await currentViteClosureText(output)).not.toContain("SharedHelper");

    await writeFile(shaderAPath, importedA);
    expect((await events.next()).error).toBeUndefined();
    await unlink(fixture.transitive);
    const failed = await events.next();
    expect(failed.error).toBeDefined();
    expect(String(failed.error)).toContain("shared.wgsl");
    expect(failed.watched.map(normalizePath).some((path) => path.endsWith("/shared.wgsl"))).toBe(true);

    await writeFile(fixture.transitive, editedTransitive);
    expect((await events.next()).error).toBeUndefined();
    const recovered = await loadViteWatchEntry(output);
    expect(hasStruct(recovered.eager[0], "SharedHelper")).toBe(true);
    expect(recovered.eager[0].wgsl).toContain("changed");
  } finally {
    await watcher?.close();
    await fixture.dispose();
  }
}, 120_000);

test("webpack watch rebuilds edits, prunes removed imports, registers deletion, and recovers", async () => {
  const fixture = await createPackedBundlerFixture();
  const output = join(fixture.output, "webpack-watch");
  await mkdir(output, { recursive: true });
  const config = webpackConfig(fixture, fixture.entry, output);
  config.watchOptions = { poll: 50 };
  const compiler = webpack(config);
  const events = eventQueue<{ readonly error?: Error; readonly stats?: Stats }>((event) => {
    if (event.error) return event.error.stack ?? event.error.message;
    return event.stats?.toString({ all: false, errors: true, errorDetails: true }) ?? "no webpack stats";
  });
  const watching = compiler.watch({ poll: 50 }, (error, stats) => events.push({ error: error ?? undefined, stats }));
  try {
    const first = await successfulWebpackWatch(events);
    const initial = loadWebpackWatchEntry(output);
    const initialChecksum = initial.eager[0].sourceChecksum;
    const initialReflection = initial.eager[0].reflection;
    expect(first.compilation.fileDependencies.has(fixture.transitive)).toBe(true);

    const editedTransitive = `
export struct SharedHelper { value: vec4f, changed: mat4x4f }
export fn shared_color() -> vec4f { return vec4f(0.75, 0.5, 0.25, 1.0); }
`;
    await writeFile(fixture.transitive, editedTransitive);
    await successfulWebpackWatch(events, fixture.transitive);
    const edited = loadWebpackWatchEntry(output);
    expect(edited.eager[0].sourceChecksum).not.toBe(initialChecksum);
    expect(edited.eager[0].reflection).not.toStrictEqual(initialReflection);

    const shaderAPath = join(fixture.root, "src/shader-a.wgsl");
    const importedA = await readFile(shaderAPath, "utf8");
    await writeFile(shaderAPath, withoutTransitiveImport(importedA));
    await successfulWebpackWatch(events, shaderAPath);
    const pruned = loadWebpackWatchEntry(output);
    expect(pruned.eager[0].wgsl).not.toContain("SharedHelper");
    expect(hasStruct(pruned.eager[0], "SharedHelper")).toBe(false);
    expect(await readFile(join(output, "entry.cjs"), "utf8")).not.toContain("SharedHelper");

    await writeFile(shaderAPath, importedA);
    await successfulWebpackWatch(events, shaderAPath);
    await unlink(fixture.transitive);
    const failed = await nextWebpackWatchEvent(events, fixture.transitive);
    expect(failed.error).toBeUndefined();
    expect(failed.stats?.hasErrors()).toBe(true);
    expect(failed.stats?.toString({ all: false, errors: true, errorDetails: true })).toContain("shared.wgsl");
    expect([...failed.stats!.compilation.fileDependencies].map(normalizePath).some((path) => path.endsWith("/shared.wgsl"))).toBe(true);

    await writeFile(fixture.transitive, editedTransitive);
    await successfulWebpackWatch(events, fixture.transitive);
    const recovered = loadWebpackWatchEntry(output);
    expect(hasStruct(recovered.eager[0], "SharedHelper")).toBe(true);
    expect(recovered.eager[0].wgsl).toContain("changed");
  } finally {
    await closeWebpackWatch(watching, compiler);
    await fixture.dispose();
  }
}, 120_000);

async function buildVite(
  fixture: PackedBundlerFixture,
  options: { readonly cache?: string; readonly entry?: string } = {},
): Promise<BuiltGraph> {
  const entry = options.entry ?? fixture.entry;
  const queryImporterCounts = new Map<string, number>();
  const config = viteConfig(fixture, entry, options.cache);
  config.plugins = [
    ...(config.plugins ?? []),
    {
      name: "vgpu-packed-query-graph-receipt",
      generateBundle() {
        for (const id of this.getModuleIds()) {
          if (!id.includes("?__vgpu_packed_v1=")) continue;
          queryImporterCounts.set(id, this.getModuleInfo(id)?.importers.length ?? 0);
        }
      },
    },
  ];
  const result = asViteOutputs(await viteBuild(config));
  const chunks = result.flatMap((output) => output.output).filter((item) => item.type === "chunk");
  const entryChunk = chunks.find((chunk) => chunk.isEntry);
  if (!entryChunk) throw new Error("Vite emitted no entry chunk");
  const moduleIds = chunks.flatMap((chunk) => Object.keys(chunk.modules));
  const entryModuleIds = Object.keys(entryChunk.modules);
  const lazyModuleIds = chunks.filter((chunk) => chunk.isDynamicEntry).flatMap((chunk) => Object.keys(chunk.modules));
  const emittedText = chunks.map((chunk) => chunk.code).join("\n");
  const loaded = await import(`${pathToFileURL(join(fixture.output, entryChunk.fileName)).href}?v=${Date.now()}-${Math.random()}`) as {
    readonly eager: readonly [ShaderSource, ShaderSource];
    readonly loadCold: () => Promise<ShaderSource>;
  };
  return {
    eager: loaded.eager,
    loadCold: loaded.loadCold,
    moduleIds,
    entryModuleIds,
    lazyModuleIds,
    queryIds: queries(moduleIds),
    reusedQuery: [...queryImporterCounts.values()].some((count) => count >= 2),
    entryText: entryChunk.code,
    lazyText: chunks.filter((chunk) => chunk.isDynamicEntry).map((chunk) => chunk.code).join("\n"),
    emittedText,
  };
}

function viteConfig(fixture: PackedBundlerFixture, entry: string, cacheDir?: string): InlineConfig {
  return {
    root: fixture.root,
    cacheDir,
    logLevel: "silent",
    plugins: [wgslVitePlugin({ minify: { whitespace: true, identifiers: "none" } })],
    build: {
      outDir: fixture.output,
      emptyOutDir: true,
      minify: false,
      target: "esnext",
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          entryFileNames: "entry.mjs",
          chunkFileNames: "chunks/[name]-[hash].mjs",
        },
      },
    },
  };
}

function createViteDevServer(fixture: PackedBundlerFixture, cacheDir: string): Promise<ViteDevServer> {
  return createServer({
    root: fixture.root,
    cacheDir,
    logLevel: "silent",
    appType: "custom",
    plugins: [wgslVitePlugin({ minify: { whitespace: true, identifiers: "none" } })],
    server: {
      middlewareMode: true,
      watch: { usePolling: true, interval: 50 },
    },
  });
}

function loadViteDevEntry(server: ViteDevServer): Promise<{
  readonly eager: readonly [ShaderSource, ShaderSource];
  readonly loadCold: () => Promise<ShaderSource>;
}> {
  return server.ssrLoadModule("/src/entry.mjs") as Promise<{
    readonly eager: readonly [ShaderSource, ShaderSource];
    readonly loadCold: () => Promise<ShaderSource>;
  }>;
}

function viteDevQueryUrls(server: ViteDevServer): string[] {
  return [...server.moduleGraph.idToModuleMap.values()]
    .filter((module) => module.id?.includes("?__vgpu_packed_v1="))
    .map((module) => module.url)
    .sort();
}

function waitForViteDevChange(server: ViteDevServer, expectedPath: string): Promise<void> {
  return new Promise((resolveChange, reject) => {
    const timeout = setTimeout(() => {
      server.watcher.off("change", onChange);
      reject(new Error(`Vite dev transition exceeded 30 seconds for ${expectedPath}`));
    }, 30_000);
    const onChange = (changedPath: string) => {
      if (normalizePath(changedPath) !== normalizePath(expectedPath)) return;
      clearTimeout(timeout);
      server.watcher.off("change", onChange);
      resolveChange();
    };
    server.watcher.on("change", onChange);
  });
}

async function buildWebpack(
  fixture: PackedBundlerFixture,
  options: { readonly cache?: string; readonly entry?: string } = {},
): Promise<BuiltGraph> {
  const output = join(fixture.output, "webpack");
  await mkdir(output, { recursive: true });
  const stats = await runWebpack(webpackConfig(fixture, options.entry ?? fixture.entry, output, options.cache));
  const json = stats.toJson({
    all: false,
    assets: true,
    chunks: true,
    chunkModules: true,
    modules: true,
    cachedModules: true,
    nestedModules: true,
    reasons: true,
  });
  const chunks = json.chunks ?? [];
  const retained = chunks.flatMap((chunk) => flattenWebpackModules(chunk.modules ?? []));
  const allModules = flattenWebpackModules(json.modules ?? []);
  const moduleIds = retained.map((item) => String(item.identifier ?? item.name ?? ""));
  const allModuleIds = allModules.map((item) => String(item.identifier ?? item.name ?? ""));
  const entryModuleIds = chunks.filter((chunk) => chunk.initial)
    .flatMap((chunk) => flattenWebpackModules(chunk.modules ?? []))
    .map((item) => String(item.identifier ?? item.name ?? ""));
  const lazyModuleIds = chunks.filter((chunk) => !chunk.initial)
    .flatMap((chunk) => flattenWebpackModules(chunk.modules ?? []))
    .map((item) => String(item.identifier ?? item.name ?? ""));
  const assets = (json.assets ?? []).map((asset) => asset.name).filter((name): name is string => typeof name === "string");
  const emittedAssets = await Promise.all(assets.filter((name) => /\.(?:c?js|mjs)$/u.test(name)).map(async (name) => ({
    name,
    code: await readFile(join(output, name), "utf8"),
  })));
  const emittedText = emittedAssets.map((asset) => asset.code).join("\n");
  const entryPath = join(output, "entry.cjs");
  delete require.cache[entryPath];
  const loaded = require(entryPath) as {
    readonly eager: readonly [ShaderSource, ShaderSource];
    readonly loadCold: () => Promise<ShaderSource>;
  };
  return {
    eager: loaded.eager,
    loadCold: loaded.loadCold,
    moduleIds,
    entryModuleIds,
    lazyModuleIds,
    queryIds: queries(allModuleIds),
    reusedQuery: allModules.some((item) => {
      const id = String(item.identifier ?? item.name ?? "");
      if (!id.includes("?__vgpu_packed_v1=")) return false;
      const importers = new Set((item.reasons ?? []).map((reason: any) => reason.moduleIdentifier ?? reason.moduleName).filter(Boolean));
      return importers.size >= 2;
    }),
    entryText: emittedAssets.filter((asset) => asset.name === "entry.cjs").map((asset) => asset.code).join("\n"),
    lazyText: emittedAssets.filter((asset) => asset.name !== "entry.cjs").map((asset) => asset.code).join("\n"),
    emittedText,
  };
}

function webpackConfig(
  fixture: PackedBundlerFixture,
  entry: string,
  output: string,
  cacheDirectory?: string,
): Configuration {
  return {
    mode: "production",
    target: "node",
    context: fixture.root,
    entry,
    output: {
      path: output,
      filename: "entry.cjs",
      chunkFilename: "chunks/[name]-[contenthash].cjs",
      library: { type: "commonjs2" },
      clean: true,
    },
    module: {
      rules: [{
        test: /\.wgsl$/u,
        loader: require.resolve("@vgpu/wgsl/loader-webpack"),
        options: { minify: { whitespace: true, identifiers: "none" } },
      }],
    },
    optimization: { minimize: false },
    cache: cacheDirectory ? { type: "filesystem", cacheDirectory } : false,
  };
}

function runWebpack(config: Configuration): Promise<Stats> {
  return new Promise((resolve, reject) => {
    const compiler = webpack(config);
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error) return reject(error);
        if (closeError) return reject(closeError);
        if (!stats) return reject(new Error("webpack completed without stats"));
        if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true, errorDetails: true })));
        resolve(stats);
      });
    });
  });
}

function flattenWebpackModules(modules: readonly any[]): any[] {
  const result: any[] = [];
  for (const item of modules) {
    result.push(item);
    if (Array.isArray(item.modules)) result.push(...flattenWebpackModules(item.modules));
  }
  return result;
}

function queries(moduleIds: readonly string[]): string[] {
  return [...new Set(moduleIds.flatMap((id) => [...id.matchAll(QUERY)].map((match) => match[0]!)))].sort();
}

function decodeQuery(query: string): unknown {
  const equals = query.indexOf("=");
  if (equals < 0) throw new Error("packed query lost its payload");
  return decodePackedMetadata(JSON.parse(Buffer.from(query.slice(equals + 1), "base64url").toString("utf8")));
}

function expectExactLoaderArtifact(artifact: ShaderSource, originalDiagnosticPath: string): void {
  expect(artifact).toStrictEqual(prepareShader({
    wgsl: artifact.wgsl,
    functionExports: artifact.functionExports,
  }, originalDiagnosticPath));
  expect(Object.keys(artifact)).toEqual([
    "version",
    "wgsl",
    "reflection",
    "sourceChecksum",
    "producer",
    "functionExports",
  ]);
}

function singleUniformFallbackShader(marker: "A" | "B"): string {
  const members = Array.from({ length: 16 }, (_, index) => {
    const type = index % 3 === 0 ? "mat4x4f" : index % 3 === 1 ? "array<vec4f, 4>" : "vec4f";
    return `  plain${index}: ${type},`;
  }).join("\n");
  return `struct PlainOnlyRecord${marker} {\n${members}\n}
@group(0) @binding(0) var<uniform> plain${marker}: PlainOnlyRecord${marker};
@compute @workgroup_size(1) fn main_${marker}() { _ = plain${marker}.plain0; }`;
}

function normalizeModuleId(id: string): string {
  return relative(process.cwd(), id.split("?")[0]!.replaceAll("\\", "/")).replaceAll("\\", "/");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function asViteOutputs(result: Awaited<ReturnType<typeof viteBuild>>): readonly any[] {
  if ("on" in result) throw new Error("unexpected Vite watcher");
  return Array.isArray(result) ? result : [result];
}

interface WatchEvent {
  readonly error?: unknown;
  readonly watched: readonly string[];
}

function eventQueue<T>(describe: (value: T) => string = String): {
  push(value: T): void;
  next(): Promise<T>;
} {
  const values: T[] = [];
  const waiting: Array<(value: T) => void> = [];
  let lastEvent = "none";
  return {
    push(value) {
      lastEvent = describe(value);
      const resolveValue = waiting.shift();
      if (resolveValue) resolveValue(value);
      else values.push(value);
    },
    next() {
      const value = values.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise<T>((resolveValue, reject) => {
        const timeout = setTimeout(() => {
          const index = waiting.indexOf(complete);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error(`bundler watch transition exceeded 30 seconds; last event: ${lastEvent}`));
        }, 30_000);
        const complete = (nextValue: T) => {
          clearTimeout(timeout);
          resolveValue(nextValue);
        };
        waiting.push(complete);
      });
    },
  };
}

async function loadViteWatchEntry(output: string): Promise<{
  readonly eager: readonly [ShaderSource, ShaderSource];
  readonly loadCold: () => Promise<ShaderSource>;
}> {
  return import(`${pathToFileURL(join(output, "entry.mjs")).href}?watch=${Date.now()}-${Math.random()}`) as Promise<{
    readonly eager: readonly [ShaderSource, ShaderSource];
    readonly loadCold: () => Promise<ShaderSource>;
  }>;
}

function loadWebpackWatchEntry(output: string): {
  readonly eager: readonly [ShaderSource, ShaderSource];
  readonly loadCold: () => Promise<ShaderSource>;
} {
  const entry = join(output, "entry.cjs");
  for (const cached of Object.keys(require.cache)) {
    if (normalizePath(cached).startsWith(`${normalizePath(output)}/`)) delete require.cache[cached];
  }
  return require(entry) as {
    readonly eager: readonly [ShaderSource, ShaderSource];
    readonly loadCold: () => Promise<ShaderSource>;
  };
}

function hasStruct(shader: ShaderSource, authoredName: string): boolean {
  return shader.reflection.structs.some((item) => item.name === authoredName || item.name.endsWith(`__${authoredName}`));
}

function withoutTransitiveImport(source: string): string {
  return source
    .replace('import { SharedHelper, shared_color } from "./shared.wgsl";\n', "")
    .replace("@group(2) @binding(0) var<uniform> helperParams: SharedHelper;\n", "")
    .replace("  let color = shared_color();", "  let color = vec4f(0.0);")
    .replace("  let helperValue = helperParams.value;\n", "")
    .replace("  _ = helperValue;\n", "");
}

async function currentViteClosureText(output: string): Promise<string> {
  const visited = new Set<string>();
  const pending = [join(output, "entry.mjs")];
  const contents: string[] = [];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const code = await readFile(path, "utf8");
    contents.push(code);
    for (const match of code.matchAll(/(?:from\s*|import\()\s*["'](\.\.?\/[^"']+)["']/gu)) {
      const specifier = match[1]!;
      pending.push(resolveModulePath(path, specifier));
    }
  }
  return contents.join("\n");
}

function resolveModulePath(importer: string, specifier: string): string {
  return new URL(specifier, pathToFileURL(importer)).pathname;
}

async function successfulWebpackWatch(
  events: ReturnType<typeof eventQueue<{ readonly error?: Error; readonly stats?: Stats }>>,
  changedPath?: string,
): Promise<Stats> {
  const event = await nextWebpackWatchEvent(events, changedPath);
  if (event.error) throw event.error;
  if (!event.stats) throw new Error("webpack watch completed without stats");
  if (event.stats.hasErrors()) {
    throw new Error(event.stats.toString({ all: false, errors: true, errorDetails: true }));
  }
  return event.stats;
}

async function nextWebpackWatchEvent(
  events: ReturnType<typeof eventQueue<{ readonly error?: Error; readonly stats?: Stats }>>,
  changedPath?: string,
): Promise<{ readonly error?: Error; readonly stats?: Stats }> {
  for (;;) {
    const event = await events.next();
    if (changedPath === undefined || event.stats === undefined || webpackEventTouches(event.stats, changedPath)) {
      return event;
    }
  }
}

function webpackEventTouches(stats: Stats, changedPath: string): boolean {
  const compiler = stats.compilation.compiler;
  const changed = [...(compiler.modifiedFiles ?? []), ...(compiler.removedFiles ?? [])];
  return changed.some((path) => normalizePath(path) === normalizePath(changedPath));
}

function closeWebpackWatch(
  watching: Watching,
  compiler: Compiler,
): Promise<void> {
  return new Promise((resolveClose, reject) => {
    watching.close((watchError) => {
      if (watchError) return reject(watchError);
      compiler.close((compilerError) => compilerError ? reject(compilerError) : resolveClose());
    });
  });
}
