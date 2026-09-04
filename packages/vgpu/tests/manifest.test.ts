import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { buildIndex } from "../lib/docs/index.js";
import { resolveDocsTarget } from "../lib/docs/commands/resolve.js";
import { createManifest, parseAllowlist, serializeManifest, virtualPathFor } from "../lib/docs/generate/manifest.js";
import { docsManifest } from "../lib/generated/docs-manifest.generated.js";

const root = resolve(import.meta.dirname, "../../..");
const allowlist = readFileSync(resolve(root, "docs/allowlist.txt"), "utf8");
const gettingStartedSource = readFileSync(resolve(root, "docs/topics/getting-started.docs.md"), "utf8");

test("parses allowlist entries and maps virtual paths", () => {
  const entries = parseAllowlist("@vgpu/core Buffer packages/core/src/buffer.docs.md\n");

  expect(entries).toEqual([{ package: "@vgpu/core", symbol: "Buffer", repoPath: "packages/core/src/buffer.docs.md" }]);
  expect(virtualPathFor(entries[0])).toBe("/@vgpu/core/buffer.docs.md");
});

test("generates deterministic docs VFS artifact", () => {
  const options = { exists: () => true, read: (path) => `content for ${path}\r\n` };
  const first = serializeManifest(createManifest(allowlist, options));
  const second = serializeManifest(createManifest(allowlist, options));

  expect(first).toBe(second);
  expect(createHash("sha256").update(first).digest("hex")).toMatch(/^[a-f0-9]{64}$/u);
});

test("fails on missing allowlisted docs", () => {
  expect(() => createManifest("@vgpu/core Missing packages/core/src/Missing.docs.md", {
    exists: () => false,
    read: () => "",
  })).toThrow("Missing docs file: packages/core/src/Missing.docs.md");
});

test("includes guide docs as a first-class kind", () => {
  const manifest = createManifest("@vgpu/core Buffer packages/core/src/buffer.docs.md", {
    exists: () => true,
    read: (path) => `# ${path}\n\nSummary for ${path}.`,
    guides: ["docs/topics/performance-model.docs.md"],
  });

  expect(manifest.records.find((record) => record.kind === "guide")).toMatchObject({
    package: "guides",
    symbol: "performance-model",
    repoPath: "docs/topics/performance-model.docs.md",
    virtualPath: "/guides/performance-model.docs.md",
    kind: "guide",
    topic: "performance-model",
    anchor: "performance-model",
    summary: "Summary for docs/topics/performance-model.docs.md.",
  });
  expect(manifest.records.find((record) => record.symbol === "Buffer")?.kind).toBe("api");
});

test("extracts schema v3 topic metadata from symbol docs", () => {
  const manifest = createManifest("vgpu Effect packages/vgpu-api/src/effect.docs.md", {
    exists: () => true,
    read: () => `# Effect\n\nFullscreen-fragment render unit created by \`effect(gpu, source)\`.\n\n\`\`\`ts\nconst shading = effect(gpu, shader);\n\`\`\`\n`,
  });

  expect(manifest.schemaVersion).toBe(3);
  expect(manifest.records[0]).toMatchObject({
    topic: "effect",
    topicTitle: "Effect",
    anchor: "effect",
    symbolKind: "type",
    summary: "Fullscreen-fragment render unit created by `effect(gpu, source)`.",
    snippet: "const shading = effect(gpu, shader);",
  });
});

test("parses declared search keywords for guides", () => {
  const manifest = createManifest("", {
    exists: () => true,
    read: () => "---\ntitle: Using vgpu with Next.js\nkeywords: nextjs, Next.js, wgsl loader, declare module, , nextjs\n---\n\n# Using vgpu with Next.js\n\nBody.\n",
    guides: ["docs/topics/nextjs.docs.md"],
  });

  expect(manifest.records[0]).toMatchObject({
    symbol: "nextjs",
    topicTitle: "Using vgpu with Next.js",
    keywords: ["nextjs", "next.js", "wgsl loader", "declare module"],
  });
});

test("omits keywords when a doc declares none", () => {
  const manifest = createManifest("", {
    exists: () => true,
    read: () => "# Plain guide\n\nBody.\n",
    guides: ["docs/topics/plain.docs.md"],
  });

  expect(manifest.records[0]).not.toHaveProperty("keywords");
});

test("the shipped nextjs guide declares the queries agents type", () => {
  const record = docsManifest.records.find((item) => item.symbol === "nextjs");

  expect(record).toMatchObject({ package: "guides", kind: "guide", repoPath: "docs/topics/nextjs.docs.md" });
  expect(record?.keywords).toEqual(expect.arrayContaining(["nextjs", "next.js", "webpack", "turbopack", "vite", "bundler", "declare module"]));
});

test("fails on a missing guide doc", () => {
  expect(() => createManifest("", { exists: () => false, read: () => "", guides: ["docs/topics/nope.docs.md"] })).toThrow(
    "Missing docs file: docs/topics/nope.docs.md",
  );
});

test("manifest includes getting-started as a guide", () => {
  expect(docsManifest.records.find((record) => record.symbol === "getting-started")).toMatchObject({
    package: "guides",
    symbol: "getting-started",
    repoPath: "docs/topics/getting-started.docs.md",
    virtualPath: "/guides/getting-started.docs.md",
    kind: "guide",
  });
});

test("exports the CLI reference to the docs corpus", () => {
  expect(docsManifest.records.find((record) => record.symbol === "cli")).toMatchObject({
    package: "guides",
    symbol: "cli",
    repoPath: "docs/topics/cli.docs.md",
    virtualPath: "/guides/cli.docs.md",
    kind: "guide",
    topicTitle: "CLI",
    websitePath: "/cli",
  });
});

test("getting-started cat references resolve against the docs index", () => {
  const index = buildIndex(docsManifest);
  const refs = [...gettingStartedSource.matchAll(/vgpu docs cat\s+([^\s`|]+)/gu)]
    .map((match) => match[1])
    .filter((token) => !token.startsWith("<"));

  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) {
    const { resolved } = resolveDocsTarget(index, ref);
    expect(resolved, ref).toBeDefined();
    expect(Array.isArray(resolved), ref).toBe(false);
  }
});

test("concept guides preserve canonical title and numeric website order", () => {
  const slugs = ["context", "draws", "compilation", "effects", "passes", "frames", "render-bundles"];
  const guides = slugs.map((slug) => `docs/topics/concepts-${slug}.docs.md`);
  const manifest = createManifest("", {
    exists: () => true,
    read: (path) => readFileSync(resolve(root, path), "utf8"),
    guides,
  });

  expect(manifest.records.map((record) => ({
    symbol: record.symbol,
    repoPath: record.repoPath,
    virtualPath: record.virtualPath,
    topicTitle: record.topicTitle,
    order: record.order,
  }))).toEqual([
    ["compilation", "Compilation", 30],
    ["context", "Context", 10],
    ["draws", "Draws", 20],
    ["effects", "Effects", 40],
    ["frames", "Frames", 60],
    ["passes", "Passes", 50],
    ["render-bundles", "Render bundles", 70],
  ].map(([slug, title, order]) => ({
    symbol: `concepts-${slug}`,
    repoPath: `docs/topics/concepts-${slug}.docs.md`,
    virtualPath: `/guides/concepts-${slug}.docs.md`,
    topicTitle: title,
    order,
  })));
});

test("rejects a non-numeric guide order", () => {
  expect(() => createManifest("", {
    exists: () => true,
    read: () => "---\ntitle: Bad order\norder: first\n---\n\nBody.\n",
    guides: ["docs/topics/bad.docs.md"],
  })).toThrow("Invalid numeric order in docs/topics/bad.docs.md: first");
});
