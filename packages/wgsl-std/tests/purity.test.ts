import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { expect, test } from "vitest";

const packageRoot = resolve("packages/wgsl-std");
const sourceRoot = join(packageRoot, "src");
const forbiddenPatterns: readonly RegExp[] = [
  /@\s*binding\b/u,
  /@\s*group\b/u,
  /@\s*(vertex|fragment|compute)\b/u,
  /\boverride\b/u,
  /\bvar\s*<\s*(uniform|storage|workgroup)\b/u,
];

test("exported wgsl-std snippets stay pure declaration modules", async () => {
  const files = await findWgslFiles(sourceRoot);

  expect(files.map((file) => relative(packageRoot, file).replace(/\\/gu, "/")).sort()).toEqual([
    "src/color/index.wgsl",
    "src/math/index.wgsl",
  ]);

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const withoutComments = stripComments(source);

    for (const pattern of forbiddenPatterns) {
      expect.soft(withoutComments, `${relative(packageRoot, file)} must not match ${pattern}`).not.toMatch(pattern);
    }

    for (const declaration of topLevelDeclarations(withoutComments)) {
      expect.soft(declaration, `${relative(packageRoot, file)} has only fn/const/struct/alias top-level declarations`).toMatch(/^(export\s+)?(fn|const|struct|alias)\b/u);
    }
  }
});

async function findWgslFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return findWgslFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".wgsl") ? [fullPath] : [];
  }));
  return nested.flat();
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/.*$/gmu, "");
}

function topLevelDeclarations(source: string): string[] {
  const declarations: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0 && (char === ";" || char === "}")) {
      const declaration = source.slice(start, index + 1).trim();
      if (declaration) declarations.push(declaration);
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) declarations.push(tail);
  return declarations;
}
