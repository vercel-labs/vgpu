import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";

test("WGSL emits independently while preserving the optional adapter's lazy literal import", () => {
  const project = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../tsconfig.json"
  );
  const config = ts.readConfigFile(project, ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(project),
    undefined,
    project
  );
  expect(parsed.errors).toEqual([]);

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  // Exercise the real emit checks without overwriting dist or another build's state.
  const output = new Map<string, string>();
  const emitted = program.emit(undefined, (path, text) =>
    output.set(resolve(path), text)
  );
  const diagnostics = [
    ...ts.getPreEmitDiagnostics(program),
    ...emitted.diagnostics,
  ].map(
    (diagnostic) =>
      `${diagnostic.code}: ${ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n"
      )}`
  );
  expect(diagnostics).toEqual([]);
  expect(emitted.emitSkipped).toBe(false);

  const devicePath = resolve(
    dirname(project),
    "dist/runtime/validation-device.js"
  );
  const deviceSource = output.get(devicePath);
  expect(deviceSource).toBeDefined();
  const device = ts.createSourceFile(
    devicePath,
    deviceSource!,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const adapterLoads: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = node.arguments[0];
      if (
        specifier &&
        ts.isStringLiteral(specifier) &&
        specifier.text === "@vgpu/adapter-node"
      ) {
        adapterLoads.push(node.getText(device));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(device);
  expect(adapterLoads).toEqual(['import("@vgpu/adapter-node")']);
  expect(
    device.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "@vgpu/adapter-node"
    )
  ).toBe(false);
});
