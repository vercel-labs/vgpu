import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createManifest, parseAllowlist, serializeManifest, virtualPathFor } from "../src/docs/generate/manifest.ts";

const root = resolve(import.meta.dirname, "../../..");
const allowlist = readFileSync(resolve(root, "docs/allowlist.txt"), "utf8");

test("parses allowlist entries and virtual paths", () => {
  const entries = parseAllowlist("@vgpu/core Buffer packages/core/src/Buffer.docs.md\n");

  expect(entries).toEqual([{ package: "@vgpu/core", symbol: "Buffer", repoPath: "packages/core/src/Buffer.docs.md" }]);
  expect(virtualPathFor(entries[0])).toBe("/@vgpu/core/Buffer.docs.md");
});

test("generates stable manifest records with source metadata", () => {
  const manifest = createManifest(allowlist, {
    exists: (path) => true,
    read: (path) => `content for ${path}\r\n`,
  });
  const again = createManifest(allowlist, {
    exists: (path) => true,
    read: (path) => `content for ${path}\r\n`,
  });

  expect(serializeManifest(manifest)).toBe(serializeManifest(again));
  expect(manifest.records[0]).toMatchObject({ package: expect.any(String), symbol: expect.any(String), repoPath: expect.stringContaining(".docs.md") });
  expect(manifest.records.every((record) => record.content.endsWith("\n"))).toBe(true);
});

test("fails when an allowlisted docs file is missing", () => {
  expect(() =>
    createManifest("@vgpu/core Missing packages/core/src/Missing.docs.md\n", {
      exists: () => false,
      read: () => "",
    }),
  ).toThrow("Missing docs file: packages/core/src/Missing.docs.md");
});
