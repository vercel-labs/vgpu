import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "../fixtures/typing");
const tsconfigPath = resolve(fixtureRoot, "tsconfig.json");

function compileFixture() {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.formatDiagnosticsWithColorAndContext([configFile.error], compilerHostFor(fixtureRoot)));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, fixtureRoot);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return diagnostics;
}

function compilerHostFor(cwd) {
  return {
    getCurrentDirectory: () => cwd,
    getCanonicalFileName: (file) => file,
    getNewLine: () => "\n",
  } satisfies ts.FormatDiagnosticsHost;
}

function formatDiagnostics(diags) {
  return ts.formatDiagnosticsWithColorAndContext(diags, compilerHostFor(fixtureRoot));
}

test("vgpu-env reference accepts .wgsl imports under tsc", () => {
  const diagnostics = compileFixture();
  if (diagnostics.length > 0) {
    throw new Error(`TypeScript reported diagnostics:\n${formatDiagnostics(diagnostics)}`);
  }
  expect(diagnostics).toHaveLength(0);
});
