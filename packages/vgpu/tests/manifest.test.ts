import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { createManifest, parseAllowlist, serializeManifest, virtualPathFor } from "../lib/docs/generate/manifest.js";

const root = resolve(import.meta.dirname, "../../..");
const allowlist = readFileSync(resolve(root, "docs/allowlist.txt"), "utf8");

test("parses allowlist entries and maps virtual paths", () => {
  const entries = parseAllowlist("@vgpu/core Buffer packages/core/src/Buffer.docs.md\n");

  expect(entries).toEqual([{ package: "@vgpu/core", symbol: "Buffer", repoPath: "packages/core/src/Buffer.docs.md" }]);
  expect(virtualPathFor(entries[0])).toBe("/@vgpu/core/Buffer.docs.md");
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
  const manifest = createManifest("@vgpu/core Buffer packages/core/src/Buffer.docs.md", {
    exists: () => true,
    read: (path) => `content for ${path}`,
    guides: ["docs/topics/performance-model.docs.md"],
  });

  expect(manifest.records.find((record) => record.kind === "guide")).toEqual({
    package: "guides",
    symbol: "performance-model",
    repoPath: "docs/topics/performance-model.docs.md",
    virtualPath: "/guides/performance-model.docs.md",
    kind: "guide",
    content: "content for docs/topics/performance-model.docs.md",
  });
  expect(manifest.records.find((record) => record.symbol === "Buffer")?.kind).toBe("api");
});

test("fails on a missing guide doc", () => {
  expect(() => createManifest("", { exists: () => false, read: () => "", guides: ["docs/topics/nope.docs.md"] })).toThrow(
    "Missing docs file: docs/topics/nope.docs.md",
  );
});
