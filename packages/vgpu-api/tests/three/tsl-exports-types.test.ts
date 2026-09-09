import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "fixtures/typing");
const tsconfigPath = resolve(fixtureRoot, "tsconfig.json");

test("types literal keys, manual contracts, and public shader metadata", () => {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) throw new Error(formatDiagnostics([configFile.error]));

  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, fixtureRoot);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(config.fileNames, config.options));
  if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics));

  expect(diagnostics).toHaveLength(0);
});

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => fixtureRoot,
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => "\n",
  });
}
