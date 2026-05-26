import { expect, test } from "vitest";
import { buildIndex, resolveSymbol } from "../src/docs/index.ts";
import type { DocsManifest } from "../src/docs/model.ts";

const manifest: DocsManifest = {
  schemaVersion: 1,
  formatVersion: "1",
  records: [
    { package: "@pkg/a", symbol: "Buffer", repoPath: "a/Buffer.docs.md", virtualPath: "/@pkg/a/Buffer.docs.md", content: "Buffer docs" },
    { package: "@pkg/b", symbol: "Buffer", repoPath: "b/Buffer.docs.md", virtualPath: "/@pkg/b/Buffer.docs.md", content: "Other docs" },
    { package: "@pkg/a", symbol: "Queue", repoPath: "a/Queue.docs.md", virtualPath: "/@pkg/a/Queue.docs.md", content: "Queue docs" },
  ],
};

test("builds path, package, and symbol indexes", () => {
  const index = buildIndex(manifest);

  expect(index.packages).toEqual(["@pkg/a", "@pkg/b"]);
  expect(index.paths.get("/@pkg/a/Buffer.docs.md")?.[0]?.symbol).toBe("Buffer");
  expect(index.symbols.get("Buffer")?.length).toBe(2);
});

test("resolves unique symbols and preserves ambiguity", () => {
  const index = buildIndex(manifest);

  expect(resolveSymbol(index, "Queue")).toMatchObject({ virtualPath: "/@pkg/a/Queue.docs.md" });
  expect(resolveSymbol(index, "Buffer")).toHaveLength(2);
  expect(resolveSymbol(index, "Missing")).toBeUndefined();
});
