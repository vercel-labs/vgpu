import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../");
const fixtureRoot = resolve(here, "../fixtures/typing");
const tsconfigPath = resolve(fixtureRoot, "tsconfig.json");

function compileTsconfig(tsconfig: string, cwd: string) {
  const configFile = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.formatDiagnosticsWithColorAndContext([configFile.error], compilerHostFor(cwd)));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, cwd);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts.getPreEmitDiagnostics(program);
}

function compilerHostFor(cwd: string) {
  return {
    getCurrentDirectory: () => cwd,
    getCanonicalFileName: (file: string) => file,
    getNewLine: () => "\n",
  } satisfies ts.FormatDiagnosticsHost;
}

function formatDiagnostics(diags: readonly ts.Diagnostic[], cwd = fixtureRoot) {
  return ts.formatDiagnosticsWithColorAndContext(diags, compilerHostFor(cwd));
}

function createPublishedConsumerFixture() {
  const root = mkdtempSync(join(tmpdir(), "vgpu-client-types-"));
  const nodeModules = join(root, "node_modules");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(nodeModules, "@vgpu"), { recursive: true });
  mkdirSync(join(nodeModules, "@webgpu"), { recursive: true });
  mkdirSync(join(nodeModules, "vgpu"), { recursive: true });

  writeFileSync(join(root, "vgpu-env.d.ts"), "/// <reference types=\"vgpu/client\" />\n");
  writeFileSync(join(root, "src", "shader.wgsl"), "@compute @workgroup_size(1) fn main() {}\n");
  writeFileSync(
    join(root, "src", "index.ts"),
    [
      'import shaderSource from "./shader.wgsl";',
      'import type { VGPUClientEnvironment } from "vgpu/client";',
      "const env: VGPUClientEnvironment = {};",
      "const source: string = shaderSource;",
      "export { env, source };",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          lib: ["ES2022", "DOM"],
        },
        include: ["src/**/*", "vgpu-env.d.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(nodeModules, "vgpu", "package.json"),
    JSON.stringify({ name: "vgpu", type: "module", exports: { "./client": { types: "./client.d.ts" } } }, null, 2),
  );
  writeFileSync(join(nodeModules, "vgpu", "client.d.ts"), ts.sys.readFile(resolve(repoRoot, "packages/vgpu-api/client.d.ts")) ?? "");
  symlinkSync(resolve(repoRoot, "node_modules/@webgpu/types"), join(nodeModules, "@webgpu", "types"), "dir");
  symlinkSync(resolve(repoRoot, "packages/wgsl"), join(nodeModules, "@vgpu", "wgsl"), "dir");

  return root;
}

test("vgpu-env reference accepts .wgsl imports under tsc", () => {
  const diagnostics = compileTsconfig(tsconfigPath, fixtureRoot);
  if (diagnostics.length > 0) {
    throw new Error(`TypeScript reported diagnostics:\n${formatDiagnostics(diagnostics)}`);
  }
  expect(diagnostics).toHaveLength(0);
});

test("published vgpu/client types resolve WebGPU globals without monorepo tsconfig", () => {
  const root = createPublishedConsumerFixture();
  try {
    const diagnostics = compileTsconfig(join(root, "tsconfig.json"), root);
    if (diagnostics.length > 0) {
      throw new Error(`TypeScript reported diagnostics:\n${formatDiagnostics(diagnostics, root)}`);
    }
    expect(diagnostics).toHaveLength(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
