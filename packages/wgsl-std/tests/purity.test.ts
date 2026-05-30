import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const packageRoot = resolve("packages/wgsl-std");
const sourceRoot = join(packageRoot, "src");
const allowedTopLevelDeclaration = /^(export\s+)?(fn|const|struct|alias)\b/u;
const forbiddenModulePatterns: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /@\s*binding\b/u, label: "resource binding attributes" },
  { pattern: /@\s*group\b/u, label: "resource group attributes" },
  { pattern: /@\s*(vertex|fragment|compute)\b/u, label: "entry point attributes" },
  { pattern: /\boverride\b/u, label: "pipeline overrides" },
  { pattern: /\bvar\s*<\s*(uniform|storage|workgroup)\b/u, label: "resource variables" },
];

test("exported wgsl-std snippets stay pure declaration modules", async () => {
  const files = await findWgslFiles(sourceRoot);

  expect(files.map((file) => relative(packageRoot, file).replace(/\\/gu, "/")).sort()).toEqual([
    "src/color/index.wgsl",
    "src/constants/index.wgsl",
    "src/math/index.wgsl",
    "src/sampling/index.wgsl",
  ]);

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const errors = purityErrors(source).map((error) => `${relative(packageRoot, file)}: ${error}`);

    expect.soft(errors).toEqual([]);
  }
});

describe("purity lint regressions", () => {
  test.each([
    ["top-level private var", "var hiddenCounter: u32;"],
    ["top-level explicit private var", "var<private> hiddenCounter: u32;"],
    ["exported top-level private var", "export var hiddenCounter: u32;"],
    ["resource var", "var<uniform> hiddenUniform: u32;"],
  ])("rejects %s", (_name, source) => {
    expect(purityErrors(source)).toEqual(expect.arrayContaining([
      expect.stringContaining("top-level declaration must be fn/const/struct/alias"),
    ]));
  });

  test("allows function-local vars", () => {
    expect(purityErrors(`export fn localOnly(value: u32) -> u32 {
  var hiddenCounter = value;
  return hiddenCounter;
}`)).toEqual([]);
  });
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

function purityErrors(source: string): string[] {
  const withoutComments = stripComments(source);
  const errors: string[] = [];

  for (const { pattern, label } of forbiddenModulePatterns) {
    if (pattern.test(withoutComments)) errors.push(`forbidden ${label}: ${pattern}`);
  }

  for (const declaration of topLevelDeclarations(withoutComments)) {
    if (!allowedTopLevelDeclaration.test(declaration)) {
      errors.push(`top-level declaration must be fn/const/struct/alias only: ${declaration}`);
    }
  }

  return errors;
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
