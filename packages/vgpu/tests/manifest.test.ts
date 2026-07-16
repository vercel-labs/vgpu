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
    read: () => `# Effect\n\nFullscreen-fragment render unit created by \`gpu.effect()\`.\n\n\`\`\`ts\nconst effect = gpu.effect(shader);\n\`\`\`\n`,
  });

  expect(manifest.schemaVersion).toBe(3);
  expect(manifest.records[0]).toMatchObject({
    topic: "effect",
    topicTitle: "Effect",
    anchor: "effect",
    symbolKind: "type",
    summary: "Fullscreen-fragment render unit created by `gpu.effect()`.",
    snippet: "const effect = gpu.effect(shader);",
  });
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
