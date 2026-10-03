import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";
import { expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const docsRoot = resolve(repoRoot, "apps/docs");
const examplesRoot = resolve(docsRoot, "examples");
const tsconfigPath = resolve(docsRoot, "tsconfig.examples.json");
const exampleSourcePattern = /\.(?:ts|tsx|mts)$/;
const ignoredSourceOnlyDirectories = new Set([
  ".git",
  ".next",
  ".source",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

type RunGit = (args: readonly string[]) => string;

interface ExampleSourceInventory {
  readonly files: readonly string[];
  readonly kind: "filesystem" | "git";
}

function parseExamplesConfig(
  update?: (config: Record<string, unknown>) => void,
): ts.ParsedCommandLine {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(
      [configFile.error],
      compilerHostFor(docsRoot),
    ));
  }

  const config = structuredClone(configFile.config) as Record<string, unknown>;
  update?.(config);
  const parsed = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    docsRoot,
    undefined,
    tsconfigPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(
      parsed.errors,
      compilerHostFor(docsRoot),
    ));
  }
  return parsed;
}

function compilerHostFor(cwd: string): ts.FormatDiagnosticsHost {
  return {
    getCurrentDirectory: () => cwd,
    getCanonicalFileName: (file: string) => file,
    getNewLine: () => "\n",
  };
}

function normalized(files: readonly string[]): string[] {
  return files.map((file) => resolve(file)).sort();
}

function defaultRunGit(args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function sourceOnlyGitFailure(error: unknown): boolean {
  const commandError = error as Error & {
    readonly code?: string;
    readonly stderr?: unknown;
  };
  const output = `${commandError.message ?? ""}\n${String(commandError.stderr ?? "")}`;
  return commandError.code === "ENOENT"
    || /not a git repository|not a git work tree/i.test(output);
}

function gitExampleSources(runGit: RunGit): string[] | undefined {
  let topLevel: string;
  try {
    topLevel = resolve(runGit(["rev-parse", "--show-toplevel"]).trim());
  } catch (error) {
    if (sourceOnlyGitFailure(error)) return undefined;
    throw error;
  }

  if (topLevel !== repoRoot) return undefined;

  const output = runGit([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "apps/docs/examples",
  ]);
  const deleted = new Set(runGit([
    "ls-files",
    "-z",
    "--deleted",
    "--",
    "apps/docs/examples",
  ]).split("\0"));
  return normalized(
    output
      .split("\0")
      .filter((file) => exampleSourcePattern.test(file) && !deleted.has(file))
      .map((file) => resolve(repoRoot, file)),
  );
}

function filesystemExampleSources(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredSourceOnlyDirectories.has(entry.name)) {
          visit(resolve(directory, entry.name));
        }
      } else if (entry.isFile() && exampleSourcePattern.test(entry.name)) {
        files.push(resolve(directory, entry.name));
      }
    }
  };
  visit(root);
  return normalized(files);
}

function exampleSourceInventory(
  root = examplesRoot,
  runGit: RunGit = defaultRunGit,
): ExampleSourceInventory {
  const gitSources = gitExampleSources(runGit);
  if (gitSources !== undefined) return { files: gitSources, kind: "git" };
  return { files: filesystemExampleSources(root), kind: "filesystem" };
}

function configuredExampleSources(parsed: ts.ParsedCommandLine): string[] {
  return normalized(parsed.fileNames.filter((file) => {
    const path = relative(examplesRoot, file);
    return path !== "" && !path.startsWith("..");
  }));
}

function assertExampleSourceCoverage(
  configuredSources: readonly string[],
  expectedSources: readonly string[],
): void {
  const configured = new Set(configuredSources);
  const expected = new Set(expectedSources);
  const missing = [...expected].filter((file) => !configured.has(file));
  const unexpected = [...configured].filter((file) => !expected.has(file));

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error([
      `Missing example sources:\n${missing.join("\n") || "(none)"}`,
      `Unexpected example roots:\n${unexpected.join("\n") || "(none)"}`,
    ].join("\n"));
  }
}

function assertCompleteExampleCoverage(parsed: ts.ParsedCommandLine): void {
  const configured = new Set(configuredExampleSources(parsed));
  assertExampleSourceCoverage([...configured], exampleSourceInventory().files);
}

function exampleProgram(parsed = parseExamplesConfig()): ts.Program {
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function runIsolatedTypecheck(sources: Readonly<Record<string, string>>): {
  output: string;
  status: number;
} {
  const root = mkdtempSync(join(tmpdir(), "vgpu-docs-examples-typecheck-"));
  try {
    const files = Object.entries(sources).map(([path, source]) => {
      const file = resolve(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
      return file;
    });
    const rootFiles = files.filter((file) => /\.(?:ts|tsx|mts)$/.test(file));
    const fixtureConfig = resolve(root, "tsconfig.json");
    writeFileSync(fixtureConfig, JSON.stringify({
      extends: tsconfigPath,
      compilerOptions: {
        incremental: false,
        plugins: [],
      },
      files: [
        ...rootFiles,
        resolve(docsRoot, "wgsl.d.ts"),
        resolve(docsRoot, "webgpu-types.d.ts"),
      ],
      include: [],
      exclude: [],
    }, null, 2));

    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "node_modules/typescript/bin/tsc"), "-p", fixtureConfig],
      { cwd: root, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status === null) {
      throw new Error(`TypeScript exited without a status: ${result.signal ?? "unknown signal"}`);
    }
    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("isolated config includes every TS, TSX, MTS, test, and tool example", () => {
  const parsed = parseExamplesConfig();
  const configured = configuredExampleSources(parsed);
  const inventory = exampleSourceInventory();

  expect(() => assertCompleteExampleCoverage(parsed)).not.toThrow();
  expect(configured).toEqual(inventory.files);
  expect(configured).toContain(resolve(examplesRoot, "glass-fractal/renderer.test.ts"));
  expect(configured).toContain(resolve(examplesRoot, "glass-fractal/tools/hero-fractal-preview.mts"));
  expect(configured).toContain(resolve(examplesRoot, "glass-fractal/tools/hero-fractal-vector-debug.mts"));
});

test("isolated program resolves source and declaration graph without Next output", () => {
  const parsed = parseExamplesConfig();
  const program = exampleProgram(parsed);
  const programSources = normalized(program.getSourceFiles().map((source) => source.fileName));
  expect(programSources).toEqual(expect.arrayContaining(
    exampleSourceInventory().files,
  ));
  expect(programSources).toEqual(expect.arrayContaining([
    resolve(docsRoot, "lib/example-components.ts"),
    resolve(docsRoot, "lib/examples-metadata.ts"),
    resolve(docsRoot, "test-support/mock-uniforms.ts"),
    resolve(docsRoot, "webgpu-types.d.ts"),
    resolve(docsRoot, "wgsl.d.ts"),
  ]));
  expect(programSources).toEqual(expect.arrayContaining([
    resolve(repoRoot, "packages/wgsl/src/wgsl-types.d.ts"),
    resolve(repoRoot, "packages/vgpu-api/dist/index.d.ts"),
    resolve(repoRoot, "packages/wgsl/dist/runtime/resolve-shader.d.ts"),
    ts.sys.realpath?.(resolve(
      repoRoot,
      "node_modules/@webgpu/types/dist/index.d.ts",
    )) ?? resolve(repoRoot, "node_modules/@webgpu/types/dist/index.d.ts"),
  ]));

  const generatedOrRouteSources = programSources
    .map((file) => relative(docsRoot, file))
    .filter((file) => (
      file === "next-env.d.ts"
      || file.startsWith(".next/")
      || file.startsWith(".source/")
      || file.startsWith("app/")
    ));
  expect(generatedOrRouteSources).toEqual([]);

  expect(parsed.options).toMatchObject({
    incremental: false,
    jsx: ts.JsxEmit.ReactJSX,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    plugins: [],
    strict: true,
  });
  expect(parsed.options.paths).toEqual({ "@/*": ["./*"] });
});

test("coverage control rejects a missing MTS include and TypeScript brace glob", () => {
  const withoutMts = parseExamplesConfig((config) => {
    config.include = (config.include as string[])
      .filter((pattern) => pattern !== "examples/**/*.mts");
  });
  expect(() => assertCompleteExampleCoverage(withoutMts)).toThrow(
    /glass-fractal\/tools\/hero-fractal-preview\.mts/,
  );

  const withBraceGlob = parseExamplesConfig((config) => {
    config.include = [
      "examples/**/*.{ts,tsx,mts}",
      ...(config.include as string[])
        .filter((pattern) => !pattern.startsWith("examples/")),
    ];
  });
  expect(() => assertCompleteExampleCoverage(withBraceGlob)).toThrow(
    /glass-fractal\/renderer\.test\.ts/,
  );
});

test("Git inventory includes new sources and excludes deleted indexed sources", () => {
  const tracked = "apps/docs/examples/inventory-control/tracked.ts";
  const untracked = "apps/docs/examples/inventory-control/new-tool.mts";
  const deleted = "apps/docs/examples/inventory-control/deleted.tsx";
  const runGit: RunGit = (args) => {
    if (args.join(" ") === "rev-parse --show-toplevel") return repoRoot;
    if (args.join(" ") === [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "apps/docs/examples",
    ].join(" ")) {
      return `${tracked}\0${untracked}\0${deleted}\0`;
    }
    if (args.join(" ") === [
      "ls-files",
      "-z",
      "--deleted",
      "--",
      "apps/docs/examples",
    ].join(" ")) {
      return `${deleted}\0`;
    }
    throw new Error(`Unexpected Git command: git ${args.join(" ")}`);
  };

  const inventory = exampleSourceInventory(examplesRoot, runGit);
  const expected = normalized([
    resolve(repoRoot, tracked),
    resolve(repoRoot, untracked),
  ]);

  expect(inventory).toEqual({ files: expected, kind: "git" });
  expect(() => assertExampleSourceCoverage(expected, inventory.files)).not.toThrow();
  expect(() => assertExampleSourceCoverage(
    [resolve(repoRoot, tracked)],
    inventory.files,
  )).toThrow(/new-tool\.mts/);
  expect(() => assertExampleSourceCoverage(
    [...expected, resolve(repoRoot, deleted)],
    inventory.files,
  )).toThrow(/deleted\.tsx/);
});

test("source-only inventory retains coverage without Git metadata or executable", () => {
  const root = mkdtempSync(join(tmpdir(), "vgpu-docs-source-only-"));
  try {
    const sourcePaths = [
      "component.tsx",
      "renderer.test.ts",
      "tools/tool.mts",
    ];
    const excludedPaths = [
      ".next/generated.ts",
      ".source/generated.tsx",
      "coverage/report.ts",
      "dist/output.mts",
      "node_modules/dependency.ts",
    ];
    for (const path of [...sourcePaths, ...excludedPaths, "readme.md"]) {
      const file = resolve(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "export {};\n");
    }
    const expected = normalized(sourcePaths.map((path) => resolve(root, path)));
    const noGitExecutable = Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
    });
    const noGitMetadata = Object.assign(new Error("git exited 128"), {
      stderr: "fatal: not a git repository",
    });

    for (const failure of [noGitExecutable, noGitMetadata]) {
      const inventory = exampleSourceInventory(root, () => {
        throw failure;
      });
      expect(inventory).toEqual({ files: expected, kind: "filesystem" });
      expect(() => assertExampleSourceCoverage(
        expected.filter((file) => !file.endsWith(".mts")),
        inventory.files,
      )).toThrow(/tools\/tool\.mts/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isolated compiler controls report TS, TSX, test, and MTS tool errors", () => {
  const result = runIsolatedTypecheck({
    "examples/typecheck-control/example.test.ts":
      'const value: number = "intentional .test.ts error";\nexport { value };\n',
    "examples/typecheck-control/component.tsx":
      'const value: number = "intentional .tsx error";\nexport { value };\n',
    "examples/typecheck-control/tools/tool.mts":
      'const value: number = "intentional .mts tool error";\nexport { value };\n',
  });

  expect(result.status).not.toBe(0);
  expect(result.output).toMatch(/example\.test\.ts.*TS2322/);
  expect(result.output).toMatch(/component\.tsx.*TS2322/);
  expect(result.output).toMatch(/tools\/tool\.mts.*TS2322/);
});

test("checked-in WGSL declaration accepts artifacts and rejects strings", () => {
  const valid = runIsolatedTypecheck({
    "examples/typecheck-control/shader.wgsl":
      "@compute @workgroup_size(1) fn main() {}\n",
    "examples/typecheck-control/valid.ts": [
      'import shader from "./shader.wgsl";',
      "const version: 2 = shader.version;",
      "const source: string = shader.wgsl;",
      "export { shader, source, version };",
      "",
    ].join("\n"),
  });
  expect(valid.status, valid.output).toBe(0);

  const invalid = runIsolatedTypecheck({
    "examples/typecheck-control/shader.wgsl":
      "@compute @workgroup_size(1) fn main() {}\n",
    "examples/typecheck-control/invalid.ts": [
      'import shader from "./shader.wgsl";',
      "const source: string = shader;",
      "export { source };",
      "",
    ].join("\n"),
  });
  expect(invalid.status).not.toBe(0);
  expect(invalid.output).toMatch(/invalid\.ts.*TS2322/);
  expect(invalid.output).toContain("ShaderSource");
});
