import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "../..");
const fixture = packVgpu();

afterAll(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

test("the packed package declares Three as an optional peer", () => {
  const manifest = readJson(join(fixture.packageRoot, "package.json"));

  expect(manifest.peerDependencies?.three).toBe(">=0.180.0 <0.200.0");
  expect(manifest.peerDependenciesMeta?.three).toEqual({ optional: true });
  expect(manifest.dependencies).not.toHaveProperty("three");

  expect(manifest.devDependencies?.["@types/three"]).toBe("^0.180.0");
  expect(manifest.dependencies).not.toHaveProperty("@types/three");
  expect(manifest.peerDependencies).not.toHaveProperty("@types/three");
});

test("the packed vgpu/three export creates a callable Three node", () => {
  attachThreePeer();
  attachWorkspaceDependencies();
  const consumer = join(fixture.root, "runtime-consumer.mjs");
  writeFileSync(
    consumer,
    [
      'import { tslExports } from "vgpu/three";',
      'const source = "fn doubleValue(value: f32) -> f32 { return value * 2.0; }";',
      'const { doubleValue } = tslExports(source)("doubleValue");',
      "if (doubleValue({ value: 2 }).isNode !== true) throw new Error(\"expected a Three node\");",
      'process.stdout.write("ok\\n");',
      "",
    ].join("\n"),
  );

  const output = execFileSync(process.execPath, [consumer], {
    cwd: fixture.root,
    encoding: "utf8",
  });
  expect(output).toBe("ok\n");
});

test("the packed vgpu root validates shader function export metadata", () => {
  attachRootDependencies();
  const consumer = join(fixture.root, "metadata-consumer.mjs");
  writeFileSync(
    consumer,
    [
      'import { isShaderFunctionExport } from "vgpu";',
      "const valid = { name: \"surfaceColor\", resolvedName: \"a\", parameterNames: [\"position\"] };",
      "const invalid = { ...valid, parameterNames: [\"position\", \"position\"] };",
      'if (!isShaderFunctionExport(valid)) throw new Error("expected valid metadata");',
      'if (isShaderFunctionExport(invalid)) throw new Error("expected invalid metadata");',
      'process.stdout.write("ok\\n");',
      "",
    ].join("\n"),
  );

  const output = execFileSync(process.execPath, [consumer], {
    cwd: fixture.root,
    encoding: "utf8",
  });
  expect(output).toBe("ok\n");
});

test("the packed types support the manual interface contract in NodeNext", () => {
  attachThreePeer();
  attachTypeDependencies();
  writeFileSync(
    join(fixture.root, "package.json"),
    `${JSON.stringify({ name: "vgpu-three-types-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    join(fixture.root, "types-consumer.ts"),
    [
      'import type { Node } from "three/webgpu";',
      'import { tslExports } from "vgpu/three";',
      "",
      "interface SurfaceExports {",
      "  surfaceColor: {",
      "    position: Node;",
      "    timeSeconds: Node | number;",
      "  };",
      "  surfaceRoughness: {",
      "    position: Node;",
      "  };",
      "}",
      "",
      "declare const position: Node;",
      'const source = "fn surfaceColor(position: vec3f, timeSeconds: f32) -> vec3f { return position * timeSeconds; }";',
      'const functions = tslExports<SurfaceExports>(source)("surfaceColor");',
      "const { surfaceColor } = functions;",
      "surfaceColor({ position, timeSeconds: 1 });",
      "",
      "// @ts-expect-error — timeSeconds is required by the manual contract.",
      "surfaceColor({ position });",
      "",
      "// @ts-expect-error — unselected contract keys are absent.",
      "functions.surfaceRoughness({ position });",
      "",
      "declare const selectedName: keyof SurfaceExports;",
      "const unionFunctions = tslExports<SurfaceExports>(source)(selectedName);",
      "// @ts-expect-error — a union-valued name cannot guarantee surfaceColor is present.",
      "unionFunctions.surfaceColor({ position, timeSeconds: 1 });",
      'if ("surfaceColor" in unionFunctions) unionFunctions.surfaceColor({ position, timeSeconds: 1 });',
      "",
      "declare const dynamicNames: Array<keyof SurfaceExports>;",
      "const dynamicFunctions = tslExports<SurfaceExports>(source)(...dynamicNames);",
      "// @ts-expect-error — widened selections cannot guarantee a key is present.",
      "dynamicFunctions.surfaceColor({ position, timeSeconds: 1 });",
      "dynamicFunctions.surfaceColor?.({ position, timeSeconds: 1 });",
      "",
    ].join("\n"),
  );
  const tsconfigPath = join(fixture.root, "tsconfig.json");
  writeFileSync(
    tsconfigPath,
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        lib: ["ES2022", "DOM"],
      },
      include: ["types-consumer.ts"],
    }, null, 2)}\n`,
  );

  const diagnostics = compileTsconfig(tsconfigPath);
  if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics));
  expect(diagnostics).toHaveLength(0);
});

test("the packed vgpu/three types expose stable error codes in NodeNext", () => {
  attachThreePeer();
  attachTypeDependencies();
  writeFileSync(
    join(fixture.root, "package.json"),
    `${JSON.stringify({ name: "vgpu-three-error-types-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    join(fixture.root, "error-types-consumer.ts"),
    [
      'import type { TslExportsErrorCode } from "vgpu/three";',
      "",
      'const knownCode: TslExportsErrorCode = "VGPU-THREE-TSL-SOURCE-INVALID";',
      "void knownCode;",
      "",
      "// @ts-expect-error — unrelated error codes are not part of the public union.",
      'const unknownCode: TslExportsErrorCode = "VGPU-OTHER-ERROR";',
      "void unknownCode;",
      "",
    ].join("\n"),
  );
  const tsconfigPath = join(fixture.root, "error-types-tsconfig.json");
  writeFileSync(
    tsconfigPath,
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        lib: ["ES2022", "DOM"],
      },
      include: ["error-types-consumer.ts"],
    }, null, 2)}\n`,
  );

  const diagnostics = compileTsconfig(tsconfigPath);
  if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics));
  expect(diagnostics).toHaveLength(0);
});

test("the packed vgpu root types narrow unknown metadata in NodeNext", () => {
  attachRootDependencies();
  writeFileSync(
    join(fixture.root, "package.json"),
    `${JSON.stringify({ name: "vgpu-metadata-types-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    join(fixture.root, "metadata-types-consumer.ts"),
    [
      'import { isShaderFunctionExport, type ShaderFunctionExport } from "vgpu";',
      "",
      "declare const metadata: unknown;",
      "if (isShaderFunctionExport(metadata)) {",
      "  const typedMetadata: ShaderFunctionExport = metadata;",
      "  void typedMetadata;",
      "}",
      "",
    ].join("\n"),
  );
  const tsconfigPath = join(fixture.root, "metadata-types-tsconfig.json");
  writeFileSync(
    tsconfigPath,
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        // Root `vgpu` reaches wgpu-matrix, whose declarations are not NodeNext-compatible yet.
        skipLibCheck: true,
        lib: ["ES2022", "DOM"],
      },
      include: ["metadata-types-consumer.ts"],
    }, null, 2)}\n`,
  );

  const diagnostics = compileTsconfig(tsconfigPath);
  if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics));
  expect(diagnostics).toHaveLength(0);
});

function packVgpu(): { readonly root: string; readonly packageRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "vgpu-three-package-"));
  try {
    const packageRoot = join(root, "node_modules", "vgpu");
    mkdirSync(packageRoot, { recursive: true });

    const output = execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { cwd: packageDir, encoding: "utf8" },
    );
    const [packed] = JSON.parse(output.slice(output.indexOf("["))) as [{ filename: string }];
    execFileSync(
      "tar",
      ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", packageRoot],
      { stdio: "pipe" },
    );

    return { root, packageRoot };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function attachThreePeer(): void {
  const target = resolve(packageDir, "node_modules/three");
  const link = join(fixture.root, "node_modules", "three");
  if (!existsSync(link)) symlinkSync(target, link, "dir");
}

function attachRootDependencies(): void {
  attachWorkspaceDependencies();
  const matrix = join(fixture.root, "node_modules", "wgpu-matrix");
  if (!existsSync(matrix)) {
    symlinkSync(resolve(packageDir, "node_modules/wgpu-matrix"), matrix, "dir");
  }
}

function attachTypeDependencies(): void {
  attachWorkspaceDependencies();

  const typesRoot = join(fixture.root, "node_modules", "@types");
  mkdirSync(typesRoot, { recursive: true });
  const threeTypes = join(typesRoot, "three");
  if (!existsSync(threeTypes)) {
    symlinkSync(resolve(packageDir, "node_modules/@types/three"), threeTypes, "dir");
  }
}

function attachWorkspaceDependencies(): void {
  const vgpuScope = join(fixture.root, "node_modules", "@vgpu");
  if (!existsSync(vgpuScope)) {
    symlinkSync(resolve(packageDir, "node_modules/@vgpu"), vgpuScope, "dir");
  }
}

function compileTsconfig(tsconfigPath: string): readonly ts.Diagnostic[] {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) return [configFile.error];
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, fixture.root);
  return ts.getPreEmitDiagnostics(ts.createProgram(config.fileNames, config.options));
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => fixture.root,
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => "\n",
  });
}
