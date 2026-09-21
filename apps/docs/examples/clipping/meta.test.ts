import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";

import { meta } from "./meta";

const directory = path.resolve("apps/docs/examples/clipping");
const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

test("published files are the exact recursive live entry closure", () => {
  const closure = new Set<string>();
  const visit = (file: string) => {
    if (closure.has(file)) return;
    closure.add(file);
    const source = readFileSync(path.join(directory, file), "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      expect(specifier.startsWith("..")).toBe(false);
      const resolved = resolveLocal(file, specifier);
      if (resolved) visit(resolved);
    }
  };
  visit("index.tsx");

  expect([...meta.files].sort()).toEqual([...closure].sort());
  expect(closure.has("render-thumbnail.ts")).toBe(false);
});

test("production source has no parent contracts or invented controls", () => {
  const production = readdirSync(directory).filter(
    (file) => !file.includes(".test.") && /\.(?:ts|tsx)$/.test(file)
  );
  const source = production
    .map((file) => readFileSync(path.join(directory, file), "utf8"))
    .join("\n");

  expect(source).not.toMatch(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]\.\.\//);
  expect(source).not.toContain("lil-gui");
  expect(source).not.toMatch(/<(?:button|input|select|textarea)\b/i);
  expect(source).not.toMatch(/\.catch\(\(\)\s*=>\s*undefined\)/);
  expect(meta.capabilities).not.toContain("controls");
});

function resolveLocal(importer: string, specifier: string): string | undefined {
  const base = path.normalize(path.join(path.dirname(importer), specifier));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.wgsl`]) {
    try {
      readFileSync(path.join(directory, candidate));
      return candidate;
    } catch {
      // Try the next supported example-source extension.
    }
  }
  return undefined;
}
