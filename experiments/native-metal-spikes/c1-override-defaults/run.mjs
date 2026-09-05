#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const canaryDirectory = join(fixtureDirectory, "canaries");
const prototypeSource = join(fixtureDirectory, "prototype", "main.cc");
const materializerDirectory = join(
  fixtureDirectory,
  "..",
  "c1-compiler-protocol",
  "prototype"
);
const materializerSource = join(
  materializerDirectory,
  "override-materializer.cc"
);
const apiGateSource = join(fixtureDirectory, "prototype", "api-gate.cc");
const tintRevision = "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca";
const prototypeContract = "vgpu-native-override-defaults-spike/v1";
const runnerContract = "vgpu-native-override-defaults-runner/v1";

function fail(message) {
  throw new Error(`C1 override defaults: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function same(left, right, message) {
  assert(JSON.stringify(left) === JSON.stringify(right), message);
}

function parseArguments(argv) {
  const options = {
    releaseRoot: process.env.C1_OVERRIDE_DEFAULTS_TINT_RELEASE_ROOT,
    compatInclude: process.env.C1_OVERRIDE_DEFAULTS_TINT_COMPAT_INCLUDE,
    requireTint: process.env.C1_OVERRIDE_DEFAULTS_REQUIRE_TINT === "1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: node run.mjs [--release-root <Dawn release>] " +
          "[--compat-include <header overlay>] [--require-tint]\n"
      );
      process.exit(0);
    }
    if (argument === "--require-tint") {
      options.requireTint = true;
      continue;
    }
    if (argument === "--release-root" || argument === "--compat-include") {
      const value = argv[++index];
      if (!value) fail(`${argument} requires a value`);
      options[argument === "--release-root" ? "releaseRoot" : "compatInclude"] =
        resolve(value);
      continue;
    }
    fail(`unknown argument ${argument}`);
  }
  if (options.releaseRoot) options.releaseRoot = resolve(options.releaseRoot);
  if (options.compatInclude) {
    options.compatInclude = resolve(options.compatInclude);
  }
  return options;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
    ...options,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function regularFileTree(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push({ path, relativePath: relative(root, path) });
      } else {
        fail(`dependency tree contains non-regular entry ${entry.name}`);
      }
    }
  };
  visit(root);
  files.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath, "utf8"),
      Buffer.from(right.relativePath, "utf8")
    )
  );
  return files;
}

function sha256FileTree(root) {
  const files = regularFileTree(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath.split(sep).join("/"), "utf8");
    hash.update("\0", "utf8");
    hash.update(sha256File(file.path), "utf8");
    hash.update("\n", "utf8");
  }
  return { files: files.length, sha256: hash.digest("hex") };
}

function verifyPinnedRelease(releaseRoot, compatInclude) {
  const provenancePath = join(
    fixtureDirectory,
    "..",
    "c1-tint-standalone",
    "provenance",
    "releases.json"
  );
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  const release = provenance.releases?.find(
    (candidate) => candidate.commit === tintRevision
  );
  const expectedLibrary = release?.files?.["lib/libwebgpu_dawn.a"];
  const expectedIncludeTree = release?.includeTree;
  const supplemental = provenance.supplementalSource;
  assert(release, `provenance omits pinned Dawn ${tintRevision}`);
  assert(
    expectedIncludeTree?.algorithm ===
      "relative-path-nul-file-sha256-lines-v1" &&
      Number.isSafeInteger(expectedIncludeTree.files) &&
      /^[a-f0-9]{64}$/u.test(expectedIncludeTree.sha256 ?? ""),
    "pinned include-tree provenance is incomplete"
  );
  assert(
    Number.isSafeInteger(expectedLibrary?.bytes) &&
      /^[a-f0-9]{64}$/u.test(expectedLibrary?.sha256 ?? ""),
    "pinned library provenance is incomplete"
  );
  assert(
    supplemental?.commit === tintRevision &&
      supplemental?.path === "src/utils/compiler.h" &&
      /^[a-f0-9]{64}$/u.test(supplemental?.sha256 ?? ""),
    "pinned compatibility-header provenance is incomplete"
  );

  const includeRoot = join(releaseRoot, "include");
  const tintInclude = join(includeRoot, "src", "tint");
  const library = join(releaseRoot, "lib", "libwebgpu_dawn.a");
  assert(
    existsSync(tintInclude) && existsSync(library),
    "release root lacks Tint headers or libwebgpu_dawn.a"
  );
  assert(
    statSync(library).size === expectedLibrary.bytes &&
      sha256File(library) === expectedLibrary.sha256,
    `libwebgpu_dawn.a does not match pinned Dawn ${tintRevision}`
  );
  same(
    sha256FileTree(includeRoot),
    { files: expectedIncludeTree.files, sha256: expectedIncludeTree.sha256 },
    `include tree does not match pinned Dawn ${tintRevision}`
  );

  const compilerHeader = compatInclude
    ? join(compatInclude, "src", "utils", "compiler.h")
    : join(includeRoot, "src", "utils", "compiler.h");
  assert(
    existsSync(compilerHeader),
    "pinned archive requires its exact --compat-include overlay"
  );
  assert(
    sha256File(compilerHeader) === supplemental.sha256,
    `compiler.h does not match pinned Dawn ${tintRevision}`
  );
  if (compatInclude) {
    const files = regularFileTree(compatInclude).map(({ relativePath }) =>
      relativePath.split(sep).join("/")
    );
    same(
      files,
      ["src/utils/compiler.h"],
      "--compat-include must contain only src/utils/compiler.h"
    );
  }
  return { includeRoot, tintInclude, library };
}

function compilePrototype({ releaseRoot, compatInclude, scratch }) {
  const dependency = verifyPinnedRelease(releaseRoot, compatInclude);
  const executable = join(scratch, "vgpu-override-defaults-prototype");
  const args = [
    "clang++",
    "-std=c++20",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-Werror",
    prototypeSource,
    materializerSource,
    `-I${materializerDirectory}`,
    ...(compatInclude ? [`-I${compatInclude}`] : []),
    `-I${dependency.tintInclude}`,
    `-I${dependency.includeRoot}`,
    `-L${join(releaseRoot, "lib")}`,
    "-lwebgpu_dawn",
    "-framework",
    "CoreGraphics",
    "-framework",
    "Foundation",
    "-framework",
    "Metal",
    "-framework",
    "Cocoa",
    "-framework",
    "IOKit",
    "-framework",
    "IOSurface",
    "-framework",
    "QuartzCore",
    "-o",
    executable,
  ];
  const compilation = runCommand("xcrun", args);
  if (compilation.error || compilation.signal || compilation.status !== 0) {
    fail(`prototype compilation failed: ${compilation.stderr.trim()}`);
  }
  return { executable, sha256: sha256File(executable) };
}

function compileApiGate({ releaseRoot, compatInclude, scratch }) {
  const dependency = verifyPinnedRelease(releaseRoot, compatInclude);
  const executable = join(scratch, "vgpu-override-materializer-api-gate");
  const args = [
    "clang++",
    "-std=c++20",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-Werror",
    apiGateSource,
    materializerSource,
    `-I${materializerDirectory}`,
    ...(compatInclude ? [`-I${compatInclude}`] : []),
    `-I${dependency.tintInclude}`,
    `-I${dependency.includeRoot}`,
    `-L${join(releaseRoot, "lib")}`,
    "-lwebgpu_dawn",
    "-framework",
    "CoreGraphics",
    "-framework",
    "Foundation",
    "-framework",
    "Metal",
    "-framework",
    "Cocoa",
    "-framework",
    "IOKit",
    "-framework",
    "IOSurface",
    "-framework",
    "QuartzCore",
    "-o",
    executable,
  ];
  const compilation = runCommand("xcrun", args);
  if (compilation.error || compilation.signal || compilation.status !== 0) {
    fail(`API gate compilation failed: ${compilation.stderr.trim()}`);
  }
  return executable;
}

function runStaticGate() {
  const source = `${readFileSync(prototypeSource, "utf8")}\n${readFileSync(
    materializerSource,
    "utf8"
  )}`;
  for (const token of [
    "inspector.Overrides()",
    "inspector.GetEntryPoint(selected.name)",
    "ProgramToLoweredIR(program)",
    "constant::Eval evaluator",
    "AddOverrideProbes",
    "ReferencedModuleDecls",
    "SingleEntryPoint",
    "SubstituteOverrides",
    "WorkgroupSizeAsConst",
  ]) {
    assert(
      source.includes(token),
      `prototype omits required Tint API ${token}`
    );
  }
  const materializeStart = source.indexOf("Result Materialize(");
  const entryLoop = source.indexOf(
    "for (const auto &planned_entry : plan.entries)",
    materializeStart
  );
  assert(
    materializeStart >= 0 && entryLoop > materializeStart,
    "materializer omits its program-wide Plan boundary"
  );
  for (const token of [
    "BuildPlan(program",
    "ResolveConfiguration(plan",
    "NormalizeConfiguration(program",
    "MaterializeStaticUnion(program",
    "EvaluateDefaults(program",
  ]) {
    const position = source.indexOf(token, materializeStart);
    assert(
      position >= materializeStart && position < entryLoop,
      `${token} is not completed before the per-entry loop`
    );
  }
  assert(
    !source.includes("CollectOverrideDependencies") &&
      !source.includes("TintSubstitutionValue"),
    "materializer retains recursive traversal or typed-bits-to-double code"
  );
  const fixtureExpectations = {
    "all-scalars.wgsl": [
      "enable f16",
      "override BASE: u32 = THREE + 1u",
      "override DEP: u32 = BASE * 2u",
      "@id(17) override EXPLICIT: f32",
      "override F16_SUB: f16 = 0x1p-24h",
    ],
    "required-and-subsets.wgsl": [
      "override REQUIRED: u32;",
      "override DEP: u32 = REQUIRED + 1u",
      "fn needs_required()",
      "fn first()",
      "fn second()",
    ],
    "workgroup-expression.wgsl": [
      "override UNUSED: u32",
      "@compute @workgroup_size(X + Y)",
    ],
    "forward-reference.wgsl": [
      "override A: u32 = B + 1u",
      "override B: u32 = 2u",
    ],
    "invalid-initializer.wgsl": [
      "override X: u32 = 0u",
      "override A: u32 = 4u / X",
    ],
    "short-circuit.wgsl": [
      "override REQUIRED: bool;",
      "override FOLDED: bool = false && REQUIRED",
      "fn main()",
    ],
    "select-evaluation.wgsl": [
      "override A: bool = false",
      "override N: u32 = select(2u, 4u, A)",
      "@compute @workgroup_size(N)",
    ],
    "configured-condition.wgsl": [
      "override CONDITION: bool = false",
      "override REQUIRED: bool;",
      "override RESULT: bool = CONDITION && REQUIRED",
      "fn main()",
    ],
    "multi-entry-union.wgsl": [
      "override SHARED: u32 = 2u",
      "override FIRST: u32 = SHARED + 1u",
      "override SECOND: u32 = SHARED + 2u",
      "fn first()",
      "fn second()",
    ],
  };
  for (const [file, tokens] of Object.entries(fixtureExpectations)) {
    const text = readFileSync(join(canaryDirectory, file), "utf8");
    for (const token of tokens) {
      assert(text.includes(token), `${file} omits canary ${token}`);
    }
  }
  return {
    status: "passed",
    prototype: "direct-tint-api",
    canaries: Object.keys(fixtureExpectations).length,
  };
}

function assertNoPhysicalPath(text, physicalPaths, id) {
  for (const path of physicalPaths) {
    if (path && text.includes(path)) {
      fail(`${id} leaked physical path ${path}`);
    }
  }
  assert(
    !/(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\\\)/u.test(
      text
    ),
    `${id} leaked an absolute host path`
  );
}

function invokeOnce({
  executable,
  sourcePath,
  sourceName,
  entryPoint,
  feature,
  config,
}) {
  const args = [
    "--source",
    sourcePath,
    "--source-name",
    sourceName,
    "--entry-point",
    entryPoint,
  ];
  if (feature) args.push("--feature", feature);
  for (const item of config) {
    args.push("--identifier", String(item.key), item.kind, item.payload);
  }
  return runCommand(executable, args);
}

function runCase({
  executable,
  scratch,
  id,
  source,
  sourcePath = join(canaryDirectory, source),
  sourceName = `fixtures/${source}`,
  entryPoint,
  feature,
  config = [],
  physicalPaths,
}) {
  const request = {
    executable,
    sourcePath,
    sourceName,
    entryPoint,
    feature,
    config,
  };
  const attempts = [invokeOnce(request), invokeOnce(request)];
  same(attempts[0], attempts[1], `${id} process result is not deterministic`);
  const attempt = attempts[0];
  assert(!attempt.error, `${id} failed to launch: ${attempt.error?.message}`);
  assert(!attempt.signal, `${id} terminated with signal ${attempt.signal}`);
  assert(attempt.stderr === "", `${id} wrote unexpected stderr`);
  assert(attempt.stdout.endsWith("\n"), `${id} omitted its terminal newline`);
  assertNoPhysicalPath(
    attempt.stdout,
    [...physicalPaths, scratch, fixtureDirectory, sourcePath],
    id
  );
  let result;
  try {
    result = JSON.parse(attempt.stdout);
  } catch (error) {
    fail(`${id} did not return exactly one JSON value: ${error.message}`);
  }
  assert(result?.schemaVersion === 1, `${id} has wrong schemaVersion`);
  assert(
    result?.contractId === prototypeContract,
    `${id} has wrong contractId`
  );
  assert(result?.upstreamRevision === tintRevision, `${id} has wrong Tint pin`);
  assert(
    (result.ok === true && attempt.status === 0) ||
      (result.ok === false && attempt.status === 1),
    `${id} status disagrees with result.ok`
  );
  if (result.ok === true) {
    assert(
      result.sourceName === sourceName &&
        result.sourceSha256 === sha256File(sourcePath),
      `${id} result is not bound to its exact source bytes`
    );
  }
  return { result, stdout: attempt.stdout, invocations: attempts.length };
}

function byName(result, name) {
  const item = result.overrides.find((candidate) => candidate.name === name);
  assert(item, `result omits override ${name}`);
  return item;
}

function staticByName(result, name) {
  const item = result.staticOverrides.find(
    (candidate) => candidate.name === name
  );
  assert(item, `result omits static override ${name}`);
  return item;
}

function assertNames(result, expected, id) {
  same(
    result.overrides.map(({ name }) => name),
    expected,
    `${id} override closure or canonical ordering is wrong`
  );
}

function assertStaticNames(result, expected, id) {
  same(
    result.staticOverrides.map(({ name }) => name),
    expected,
    `${id} static override interface or canonical ordering is wrong`
  );
}

function assertSuccess(run, id) {
  assert(run.result.ok === true, `${id} unexpectedly failed`);
  assert(
    Array.isArray(run.result.staticOverrides) &&
      Array.isArray(run.result.overrides),
    `${id} omitted an override view`
  );
  assert(
    run.result.verification?.singleEntryPoint === true &&
      run.result.verification?.substituteOverrides === true &&
      run.result.verification?.fullActiveMapAccepted === true &&
      run.result.verification?.exactStaticOverrideCount ===
        run.result.staticOverrides.length &&
      run.result.verification?.verifiedOverrideCount ===
        run.result.overrides.length,
    `${id} omitted full-map substitution evidence`
  );
  const staticNames = run.result.staticOverrides.map(({ name }) => name);
  same(
    staticNames,
    [...staticNames].sort(),
    `${id} static override order is not canonical`
  );
  assert(
    new Set(staticNames).size === staticNames.length,
    `${id} static override names are not unique`
  );
  for (const item of run.result.overrides) {
    same(
      staticByName(run.result, item.name),
      item,
      `${id} effective override differs from its static value`
    );
  }
  return run.result;
}

function expectError(run, id, code, phase) {
  const result = run.result;
  assert(result.ok === false, `${id} unexpectedly succeeded`);
  assert(result.diagnostics?.length === 1, `${id} diagnostics are not bounded`);
  assert(
    result.diagnostics[0].code === code,
    `${id} returned wrong error code`
  );
  assert(result.diagnostics[0].phase === phase, `${id} returned wrong phase`);
}

function assertWorkgroup(result, values, dependencies, id) {
  same(
    result.verification.workgroupSize,
    values,
    `${id} resolved workgroup drift`
  );
  same(
    result.verification.workgroupSizeAxes.map((axis) => axis.overrides),
    dependencies,
    `${id} workgroup override dependency evidence drift`
  );
}

function identifierConfig(key, kind, payload) {
  return { key, kind, payload };
}

function runTintGate(options, scratch) {
  if (!options.releaseRoot) {
    if (options.requireTint) fail("Tint gate requires --release-root");
    return { status: "skipped", reason: "release-root-not-provided" };
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    if (options.requireTint) {
      fail("pinned feasibility archive requires a Darwin arm64 host");
    }
    return { status: "skipped", reason: "requires-darwin-arm64" };
  }

  const builds = ["build-a", "build-b"].map((name) => {
    const directory = join(scratch, name);
    mkdirSync(directory);
    return compilePrototype({
      releaseRoot: options.releaseRoot,
      compatInclude: options.compatInclude,
      scratch: directory,
    });
  });
  assert(
    builds[0].sha256 === builds[1].sha256,
    "prototype build is not byte deterministic"
  );
  const executable = builds[0].executable;
  const apiGateExecutable = compileApiGate({
    releaseRoot: options.releaseRoot,
    compatInclude: options.compatInclude,
    scratch,
  });
  const wideDependencyPath = join(scratch, "wide-dependencies.wgsl");
  const wideDependencyNames = Array.from(
    { length: 128 },
    (_, index) => `O${String(index).padStart(3, "0")}`
  );
  writeFileSync(
    wideDependencyPath,
    `${wideDependencyNames
      .map((name) => `override ${name}: u32 = 1u;`)
      .join("\n")}\n` +
      `@compute @workgroup_size(${wideDependencyNames.join(" + ")})\n` +
      "fn sum() {}\n"
  );
  const apiGateAttempts = [
    runCommand(apiGateExecutable, [
      join(canaryDirectory, "multi-entry-union.wgsl"),
      wideDependencyPath,
    ]),
    runCommand(apiGateExecutable, [
      join(canaryDirectory, "multi-entry-union.wgsl"),
      wideDependencyPath,
    ]),
  ];
  same(
    apiGateAttempts[0],
    apiGateAttempts[1],
    "multi-entry API gate is not deterministic"
  );
  assert(
    apiGateAttempts[0].status === 0 &&
      apiGateAttempts[0].signal === null &&
      apiGateAttempts[0].stderr === "" &&
      apiGateAttempts[0].stdout === "passed\n",
    `multi-entry API gate failed: ${apiGateAttempts[0].stderr.trim()}`
  );
  const physicalPaths = [options.releaseRoot, options.compatInclude];
  let logicalCases = 0;
  let invocations = 0;
  const execute = (input) => {
    logicalCases += 1;
    const run = runCase({
      executable,
      scratch,
      physicalPaths,
      ...input,
    });
    invocations += run.invocations;
    return run;
  };

  const defaultsRun = execute({
    id: "all-scalars/defaults",
    source: "all-scalars.wgsl",
    entryPoint: "main",
    feature: "f16",
  });
  const defaults = assertSuccess(defaultsRun, "all-scalars/defaults");
  const allNames = [
    "BASE",
    "DEP",
    "EXPLICIT",
    "F16_HALF",
    "F16_MAX",
    "F16_SUB",
    "F32_MAX",
    "F32_SUB",
    "FLAG",
    "SIGNED",
  ];
  assertNames(defaults, allNames, "all-scalars/defaults");
  assertStaticNames(defaults, allNames, "all-scalars/defaults");
  const expectedTypes = {
    BASE: "u32",
    DEP: "u32",
    EXPLICIT: "f32",
    F16_HALF: "f16",
    F16_MAX: "f16",
    F16_SUB: "f16",
    F32_MAX: "f32",
    F32_SUB: "f32",
    FLAG: "bool",
    SIGNED: "i32",
  };
  for (const [name, type] of Object.entries(expectedTypes)) {
    assert(
      byName(defaults, name).type === type &&
        byName(defaults, name).initializer === "present" &&
        byName(defaults, name).defaultEvaluation.status === "value",
      `${name} reflected wrong type`
    );
  }
  assert(
    byName(defaults, "EXPLICIT").id.kind === "explicit" &&
      byName(defaults, "EXPLICIT").id.value === 17,
    "explicit override ID was not preserved"
  );
  for (const name of allNames.filter((name) => name !== "EXPLICIT")) {
    assert(byName(defaults, name).id.kind === "auto", `${name} ID is not auto`);
  }
  same(
    new Set(defaults.overrides.map((item) => item.id.value)).size,
    defaults.overrides.length,
    "reflected override IDs are not unique"
  );
  assert(
    byName(defaults, "BASE").defaultEvaluation.value.value === 4 &&
      byName(defaults, "BASE").selected.value === 4,
    "BASE default drift"
  );
  assert(
    byName(defaults, "DEP").defaultEvaluation.value.value === 8 &&
      byName(defaults, "DEP").selected.value === 8,
    "DEP default drift"
  );
  assert(
    byName(defaults, "FLAG").defaultEvaluation.value.value === true &&
      byName(defaults, "FLAG").selected.value === true,
    "bool default drift"
  );
  assert(
    byName(defaults, "SIGNED").defaultEvaluation.value.value === -7 &&
      byName(defaults, "SIGNED").selected.value === -7,
    "i32 default drift"
  );
  const defaultBits = {
    EXPLICIT: "3fc00000",
    F32_SUB: "00000001",
    F32_MAX: "7f7fffff",
    F16_HALF: "3800",
    F16_SUB: "0001",
    F16_MAX: "7bff",
  };
  for (const [name, bits] of Object.entries(defaultBits)) {
    assert(
      byName(defaults, name).defaultEvaluation.value.bits === bits &&
        byName(defaults, name).selected.bits === bits,
      `${name} finite bit pattern drift`
    );
  }
  assertWorkgroup(
    defaults,
    [8, 1, 1],
    [["BASE", "DEP"], [], []],
    "all-scalars/defaults"
  );

  const partial = assertSuccess(
    execute({
      id: "dependent/partial-base",
      source: "all-scalars.wgsl",
      entryPoint: "main",
      feature: "f16",
      config: [identifierConfig("BASE", "number", "5")],
    }),
    "dependent/partial-base"
  );
  assert(
    byName(partial, "DEP").defaultEvaluation.value.value === 8 &&
      byName(partial, "DEP").selected.value === 10,
    "partial BASE selection did not recompute DEP from 8 to 10"
  );
  assertWorkgroup(
    partial,
    [10, 1, 1],
    [["BASE", "DEP"], [], []],
    "dependent/partial-base"
  );

  const explicitDefault = execute({
    id: "dependent/explicit-default",
    source: "all-scalars.wgsl",
    entryPoint: "main",
    feature: "f16",
    config: [identifierConfig("BASE", "number", "4")],
  });
  assertSuccess(explicitDefault, "dependent/explicit-default");
  assert(
    explicitDefault.stdout === defaultsRun.stdout,
    "explicit default selection changed canonical output"
  );

  const orderedConfig = [
    identifierConfig("BASE", "number", "5"),
    identifierConfig("FLAG", "bool", "false"),
    identifierConfig(17, "number", "2.5"),
  ];
  const orderA = execute({
    id: "determinism/config-order-a",
    source: "all-scalars.wgsl",
    entryPoint: "main",
    feature: "f16",
    config: orderedConfig,
  });
  const orderB = execute({
    id: "determinism/config-order-b",
    source: "all-scalars.wgsl",
    entryPoint: "main",
    feature: "f16",
    config: [...orderedConfig].reverse(),
  });
  assertSuccess(orderA, "determinism/config-order-a");
  assertSuccess(orderB, "determinism/config-order-b");
  assert(
    orderA.stdout === orderB.stdout,
    "config order changed canonical output"
  );
  assert(
    byName(orderA.result, "EXPLICIT").selected.bits === "40200000" &&
      byName(orderA.result, "FLAG").selected.value === false,
    "explicit-ID or boolean selection drift"
  );

  const relocatedA = join(scratch, "relocated-a.wgsl");
  const relocatedB = join(scratch, "relocated-b.wgsl");
  const allScalarText = readFileSync(
    join(canaryDirectory, "all-scalars.wgsl"),
    "utf8"
  );
  writeFileSync(relocatedA, allScalarText);
  writeFileSync(relocatedB, allScalarText);
  const relocationA = execute({
    id: "determinism/source-relocation-a",
    source: "all-scalars.wgsl",
    sourcePath: relocatedA,
    sourceName: "fixtures/all-scalars.wgsl",
    entryPoint: "main",
    feature: "f16",
  });
  const relocationB = execute({
    id: "determinism/source-relocation-b",
    source: "all-scalars.wgsl",
    sourcePath: relocatedB,
    sourceName: "fixtures/all-scalars.wgsl",
    entryPoint: "main",
    feature: "f16",
  });
  assert(
    relocationA.stdout === relocationB.stdout &&
      relocationA.stdout === defaultsRun.stdout,
    "physical source relocation changed canonical output"
  );

  const required = assertSuccess(
    execute({
      id: "required/active",
      source: "required-and-subsets.wgsl",
      entryPoint: "needs_required",
      config: [identifierConfig("REQUIRED", "number", "4")],
    }),
    "required/active"
  );
  assertNames(required, ["DEP", "REQUIRED"], "required/active");
  assertStaticNames(required, ["DEP", "REQUIRED"], "required/active");
  assert(
    byName(required, "DEP").defaultEvaluation.status === "unavailable" &&
      byName(required, "DEP").defaultEvaluation.reason ===
        "requires-configuration" &&
      byName(required, "DEP").selected.value === 5,
    "required-dependent override did not materialize contextually"
  );
  assert(
    byName(required, "REQUIRED").initializer === "absent" &&
      byName(required, "REQUIRED").defaultEvaluation.status === "absent" &&
      byName(required, "REQUIRED").selected.value === 4,
    "required override evidence drift"
  );
  assertWorkgroup(
    required,
    [5, 1, 1],
    [["DEP", "REQUIRED"], [], []],
    "required/active"
  );

  const configuredDependentWithoutRequired = execute({
    id: "required/configured-dependent-still-requires-upstream",
    source: "required-and-subsets.wgsl",
    entryPoint: "needs_required",
    config: [identifierConfig("DEP", "number", "9")],
  });
  expectError(
    configuredDependentWithoutRequired,
    "required/configured-dependent-still-requires-upstream",
    "VGPU-C1-OVERRIDE-MISSING-REQUIRED",
    "materialize"
  );

  const configuredDependent = assertSuccess(
    execute({
      id: "required/configured-dependent-with-required",
      source: "required-and-subsets.wgsl",
      entryPoint: "needs_required",
      config: [
        identifierConfig("DEP", "number", "9"),
        identifierConfig("REQUIRED", "number", "4"),
      ],
    }),
    "required/configured-dependent-with-required"
  );
  assertNames(
    configuredDependent,
    ["DEP"],
    "required/configured-dependent-with-required"
  );
  assertStaticNames(
    configuredDependent,
    ["DEP", "REQUIRED"],
    "required/configured-dependent-with-required"
  );
  assert(
    byName(configuredDependent, "DEP").defaultEvaluation.status ===
      "unavailable" &&
      byName(configuredDependent, "DEP").selected.value === 9 &&
      staticByName(configuredDependent, "REQUIRED").selected.value === 4,
    "direct DEP selection did not bypass only its own initializer"
  );
  assertWorkgroup(
    configuredDependent,
    [9, 1, 1],
    [["DEP"], [], []],
    "required/configured-dependent-with-required"
  );
  const redundantRequired = assertSuccess(
    execute({
      id: "required/redundant-upstream-config",
      source: "required-and-subsets.wgsl",
      entryPoint: "needs_required",
      config: [
        identifierConfig("REQUIRED", "number", "7"),
        identifierConfig("DEP", "number", "9"),
      ],
    }),
    "required/redundant-upstream-config"
  );
  same(
    redundantRequired.overrides,
    configuredDependent.overrides,
    "redundant upstream configuration changed effective evidence"
  );
  assert(
    staticByName(redundantRequired, "REQUIRED").selected.value === 7 &&
      staticByName(configuredDependent, "REQUIRED").selected.value === 4,
    "distinct static selections were incorrectly canonicalized"
  );

  for (const [entryPoint, name, value] of [
    ["first", "FIRST", 2],
    ["second", "SECOND", 3],
  ]) {
    const subset = assertSuccess(
      execute({
        id: `required/inactive-${entryPoint}`,
        source: "required-and-subsets.wgsl",
        entryPoint,
      }),
      `required/inactive-${entryPoint}`
    );
    assertNames(subset, [name], `required/inactive-${entryPoint}`);
    assertStaticNames(subset, [name], `required/inactive-${entryPoint}`);
    assert(
      byName(subset, name).selected.value === value,
      `${name} default drift`
    );
    assertWorkgroup(
      subset,
      [value, 1, 1],
      [[name], [], []],
      `required/inactive-${entryPoint}`
    );
  }

  const inactiveBaseline = assertSuccess(
    execute({
      id: "config/inactive-baseline",
      source: "required-and-subsets.wgsl",
      entryPoint: "first",
    }),
    "config/inactive-baseline"
  );
  const inactiveConfigured = assertSuccess(
    execute({
      id: "config/inactive-accepted",
      source: "required-and-subsets.wgsl",
      entryPoint: "first",
      config: [identifierConfig("SECOND", "number", "7")],
    }),
    "config/inactive-accepted"
  );
  same(
    inactiveConfigured,
    inactiveBaseline,
    "entry-inactive configuration changed effective evidence"
  );

  const expression = assertSuccess(
    execute({
      id: "workgroup/expression",
      source: "workgroup-expression.wgsl",
      entryPoint: "sum",
    }),
    "workgroup/expression"
  );
  assertNames(expression, ["X", "Y"], "workgroup/expression");
  assertWorkgroup(
    expression,
    [5, 1, 1],
    [["X", "Y"], [], []],
    "workgroup/expression"
  );
  assert(
    expression.verification.workgroupSizeAxes[0].kind === "override-expression",
    "multi-override workgroup axis lost expression evidence"
  );

  const shortCircuitMissingRequired = execute({
    id: "folding/short-circuit-still-requires-static-value",
    source: "short-circuit.wgsl",
    entryPoint: "main",
  });
  expectError(
    shortCircuitMissingRequired,
    "folding/short-circuit-still-requires-static-value",
    "VGPU-C1-OVERRIDE-MISSING-REQUIRED",
    "materialize"
  );
  const shortCircuit = assertSuccess(
    execute({
      id: "folding/short-circuit-configured-required",
      source: "short-circuit.wgsl",
      entryPoint: "main",
      config: [identifierConfig("REQUIRED", "bool", "true")],
    }),
    "folding/short-circuit-configured-required"
  );
  assertNames(
    shortCircuit,
    ["FOLDED"],
    "folding/short-circuit-configured-required"
  );
  assertStaticNames(
    shortCircuit,
    ["FOLDED", "REQUIRED"],
    "folding/short-circuit-configured-required"
  );
  assert(
    byName(shortCircuit, "FOLDED").defaultEvaluation.value.value === false &&
      byName(shortCircuit, "FOLDED").selected.value === false,
    "short-circuited required dependency changed the folded value"
  );
  assertWorkgroup(
    shortCircuit,
    [1, 1, 1],
    [[], [], []],
    "folding/short-circuit-configured-required"
  );
  const alternativeShortCircuitRequired = assertSuccess(
    execute({
      id: "folding/short-circuit-alternative-required",
      source: "short-circuit.wgsl",
      entryPoint: "main",
      config: [identifierConfig("REQUIRED", "bool", "false")],
    }),
    "folding/short-circuit-alternative-required"
  );
  same(
    alternativeShortCircuitRequired.overrides,
    shortCircuit.overrides,
    "folded required value changed effective evidence"
  );
  assert(
    staticByName(alternativeShortCircuitRequired, "REQUIRED").selected.value ===
      false && staticByName(shortCircuit, "REQUIRED").selected.value === true,
    "folded static selections were incorrectly canonicalized"
  );

  const configuredConditionMissingRequired = execute({
    id: "required/configured-condition-still-requires-value",
    source: "configured-condition.wgsl",
    entryPoint: "main",
    config: [identifierConfig("CONDITION", "bool", "false")],
  });
  expectError(
    configuredConditionMissingRequired,
    "required/configured-condition-still-requires-value",
    "VGPU-C1-OVERRIDE-MISSING-REQUIRED",
    "materialize"
  );
  const configuredCondition = assertSuccess(
    execute({
      id: "required/configured-condition-with-required",
      source: "configured-condition.wgsl",
      entryPoint: "main",
      config: [
        identifierConfig("CONDITION", "bool", "false"),
        identifierConfig("REQUIRED", "bool", "true"),
      ],
    }),
    "required/configured-condition-with-required"
  );
  assertNames(
    configuredCondition,
    ["CONDITION", "REQUIRED", "RESULT"],
    "required/configured-condition-with-required"
  );
  assert(
    byName(configuredCondition, "CONDITION").selected.value === false &&
      byName(configuredCondition, "REQUIRED").selected.value === true &&
      byName(configuredCondition, "RESULT").selected.value === false &&
      byName(configuredCondition, "RESULT").defaultEvaluation.status ===
        "unavailable" &&
      byName(configuredCondition, "RESULT").defaultEvaluation.reason ===
        "requires-configuration",
    "configured condition selected/default evidence drift"
  );

  const selectedBuiltinDefault = assertSuccess(
    execute({
      id: "evaluation/select-default",
      source: "select-evaluation.wgsl",
      entryPoint: "main",
    }),
    "evaluation/select-default"
  );
  assertNames(selectedBuiltinDefault, ["A", "N"], "evaluation/select-default");
  assert(
    byName(selectedBuiltinDefault, "A").selected.value === false &&
      byName(selectedBuiltinDefault, "N").defaultEvaluation.value.value === 2 &&
      byName(selectedBuiltinDefault, "N").selected.value === 2,
    "lowered select default did not materialize to 2"
  );
  assertWorkgroup(
    selectedBuiltinDefault,
    [2, 1, 1],
    [["A", "N"], [], []],
    "evaluation/select-default"
  );
  const selectedBuiltinPartial = assertSuccess(
    execute({
      id: "evaluation/select-partial",
      source: "select-evaluation.wgsl",
      entryPoint: "main",
      config: [identifierConfig("A", "bool", "true")],
    }),
    "evaluation/select-partial"
  );
  assert(
    byName(selectedBuiltinPartial, "A").selected.value === true &&
      byName(selectedBuiltinPartial, "N").defaultEvaluation.value.value === 2 &&
      byName(selectedBuiltinPartial, "N").selected.value === 4,
    "lowered select did not reevaluate after partial configuration"
  );
  assertWorkgroup(
    selectedBuiltinPartial,
    [4, 1, 1],
    [["A", "N"], [], []],
    "evaluation/select-partial"
  );
  const selectedBuiltinDirect = assertSuccess(
    execute({
      id: "evaluation/select-direct",
      source: "select-evaluation.wgsl",
      entryPoint: "main",
      config: [identifierConfig("N", "number", "3")],
    }),
    "evaluation/select-direct"
  );
  assertNames(selectedBuiltinDirect, ["N"], "evaluation/select-direct");
  assertStaticNames(
    selectedBuiltinDirect,
    ["A", "N"],
    "evaluation/select-direct"
  );
  assert(
    byName(selectedBuiltinDirect, "N").defaultEvaluation.value.value === 2 &&
      byName(selectedBuiltinDirect, "N").selected.value === 3,
    "direct select override lost its independent default"
  );
  assertWorkgroup(
    selectedBuiltinDirect,
    [3, 1, 1],
    [["N"], [], []],
    "evaluation/select-direct"
  );

  const forward = assertSuccess(
    execute({
      id: "dependency/forward-default",
      source: "forward-reference.wgsl",
      entryPoint: "main",
    }),
    "dependency/forward-default"
  );
  assertNames(forward, ["A", "B"], "dependency/forward-default");
  assert(
    byName(forward, "A").selected.value === 3 &&
      byName(forward, "B").selected.value === 2,
    "forward reference did not evaluate recursively"
  );
  assertWorkgroup(
    forward,
    [3, 1, 1],
    [["A", "B"], [], []],
    "dependency/forward-default"
  );
  const forwardPartial = assertSuccess(
    execute({
      id: "dependency/forward-partial",
      source: "forward-reference.wgsl",
      entryPoint: "main",
      config: [identifierConfig("B", "number", "4")],
    }),
    "dependency/forward-partial"
  );
  assert(
    byName(forwardPartial, "A").selected.value === 5,
    "forward reference ignored the explicit B selection"
  );

  for (const [id, name, input, bits] of [
    ["conversion/f32-negative-zero", "EXPLICIT", "-0", "00000000"],
    ["conversion/f16-negative-zero", "F16_HALF", "-0", "0000"],
    ["conversion/f16-truncation", "F16_HALF", "1.0007", "3c00"],
    ["conversion/f16-next", "F16_HALF", "1.0009765625", "3c01"],
    ["conversion/f16-subnormal", "F16_HALF", "5.960464477539063e-8", "0001"],
    ["conversion/f16-max", "F16_HALF", "65504", "7bff"],
  ]) {
    const converted = assertSuccess(
      execute({
        id,
        source: "all-scalars.wgsl",
        entryPoint: "main",
        feature: "f16",
        config: [
          identifierConfig(name === "EXPLICIT" ? "17" : name, "number", input),
        ],
      }),
      id
    );
    assert(
      byName(converted, name).selected.bits === bits,
      `${id} selected the wrong post-Tint bits`
    );
  }

  const signedMinimum = assertSuccess(
    execute({
      id: "conversion/i32-minimum",
      source: "all-scalars.wgsl",
      entryPoint: "main",
      feature: "f16",
      config: [identifierConfig("SIGNED", "number", "-2147483648")],
    }),
    "conversion/i32-minimum"
  );
  assert(
    byName(signedMinimum, "SIGNED").defaultEvaluation.value.value === -7 &&
      byName(signedMinimum, "SIGNED").selected.value === -2147483648,
    "i32 selection did not preserve its exact boundary value"
  );

  const repairedInitializer = assertSuccess(
    execute({
      id: "initializer/repaired-by-dependency-config",
      source: "invalid-initializer.wgsl",
      entryPoint: "main",
      config: [identifierConfig("X", "number", "2")],
    }),
    "initializer/repaired-by-dependency-config"
  );
  assertNames(
    repairedInitializer,
    ["A", "X"],
    "initializer/repaired-by-dependency-config"
  );
  assert(
    byName(repairedInitializer, "A").defaultEvaluation.status ===
      "unavailable" &&
      byName(repairedInitializer, "A").defaultEvaluation.reason ===
        "requires-configuration" &&
      byName(repairedInitializer, "A").selected.value === 2 &&
      byName(repairedInitializer, "X").defaultEvaluation.value.value === 0 &&
      byName(repairedInitializer, "X").selected.value === 2,
    "configured dependency did not repair its selected initializer"
  );
  assertWorkgroup(
    repairedInitializer,
    [2, 1, 1],
    [["A", "X"], [], []],
    "initializer/repaired-by-dependency-config"
  );

  const bypassedInitializer = assertSuccess(
    execute({
      id: "initializer/direct-selection-cuts-initializer",
      source: "invalid-initializer.wgsl",
      entryPoint: "main",
      config: [identifierConfig("A", "number", "7")],
    }),
    "initializer/direct-selection-cuts-initializer"
  );
  assertNames(
    bypassedInitializer,
    ["A"],
    "initializer/direct-selection-cuts-initializer"
  );
  assertStaticNames(
    bypassedInitializer,
    ["A", "X"],
    "initializer/direct-selection-cuts-initializer"
  );
  assert(
    byName(bypassedInitializer, "A").defaultEvaluation.status ===
      "unavailable" &&
      byName(bypassedInitializer, "A").defaultEvaluation.reason ===
        "requires-configuration" &&
      byName(bypassedInitializer, "A").selected.value === 7 &&
      staticByName(bypassedInitializer, "X").selected.value === 0,
    "direct A selection did not bypass its invalid initializer"
  );
  assertWorkgroup(
    bypassedInitializer,
    [7, 1, 1],
    [["A"], [], []],
    "initializer/direct-selection-cuts-initializer"
  );
  const redundantUpstream = assertSuccess(
    execute({
      id: "initializer/redundant-upstream-config",
      source: "invalid-initializer.wgsl",
      entryPoint: "main",
      config: [
        identifierConfig("X", "number", "2"),
        identifierConfig("A", "number", "7"),
      ],
    }),
    "initializer/redundant-upstream-config"
  );
  same(
    redundantUpstream.overrides,
    bypassedInitializer.overrides,
    "redundant initializer dependency changed effective evidence"
  );
  assert(
    staticByName(redundantUpstream, "X").selected.value === 2 &&
      staticByName(bypassedInitializer, "X").selected.value === 0,
    "initializer dependency selections were lost from the static interface"
  );

  const negativeCases = [
    [
      "error/unknown-name",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig("MISSING", "number", "1")],
      "VGPU-C1-OVERRIDE-UNKNOWN",
      "config",
    ],
    [
      "error/unknown-auto-id",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig(0, "number", "4")],
      "VGPU-C1-OVERRIDE-UNKNOWN",
      "config",
    ],
    [
      "error/duplicate-config",
      "all-scalars.wgsl",
      "main",
      "f16",
      [
        identifierConfig("BASE", "number", "5"),
        identifierConfig("BASE", "number", "5"),
      ],
      "VGPU-C1-OVERRIDE-DUPLICATE-CONFIG",
      "config",
    ],
    [
      "error/noncanonical-id",
      "all-scalars.wgsl",
      "main",
      "f16",
      [
        identifierConfig("017", "number", "2.5"),
        identifierConfig("17", "number", "2.5"),
      ],
      "VGPU-C1-OVERRIDE-UNKNOWN",
      "config",
    ],
    [
      "error/explicit-id-authored-name",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig("EXPLICIT", "number", "2.5")],
      "VGPU-C1-OVERRIDE-UNKNOWN",
      "config",
    ],
    [
      "error/wrong-type",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig("BASE", "bool", "true")],
      "VGPU-C1-OVERRIDE-WRONG-TYPE",
      "config",
    ],
    [
      "error/nonintegral-integer",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig("BASE", "number", "1.5")],
      "VGPU-C1-OVERRIDE-WRONG-TYPE",
      "config",
    ],
    [
      "error/nonfinite",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig(17, "number", "nan")],
      "VGPU-C1-OVERRIDE-NONFINITE",
      "config",
    ],
    [
      "error/u32-out-of-range",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig("BASE", "number", "4294967296")],
      "VGPU-C1-OVERRIDE-OUT-OF-RANGE",
      "config",
    ],
    [
      "error/i32-out-of-range",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig("SIGNED", "number", "-2147483649")],
      "VGPU-C1-OVERRIDE-OUT-OF-RANGE",
      "config",
    ],
    [
      "error/f32-out-of-range",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig(17, "number", "3.5e38")],
      "VGPU-C1-OVERRIDE-OUT-OF-RANGE",
      "config",
    ],
    [
      "error/f32-rounded-boundary-positive",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig(17, "number", "3.402823466385289e38")],
      "VGPU-C1-OVERRIDE-OUT-OF-RANGE",
      "config",
    ],
    [
      "error/f32-rounded-boundary-negative",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig(17, "number", "-3.402823466385289e38")],
      "VGPU-C1-OVERRIDE-OUT-OF-RANGE",
      "config",
    ],
    [
      "error/f32-adjacent-overflow-positive",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig(17, "number", "3.4028235e38")],
      "VGPU-C1-OVERRIDE-OUT-OF-RANGE",
      "config",
    ],
    [
      "error/f32-adjacent-overflow-negative",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig(17, "number", "-3.4028235e38")],
      "VGPU-C1-OVERRIDE-OUT-OF-RANGE",
      "config",
    ],
    [
      "error/f16-overflow",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig("F16_HALF", "number", "70000")],
      "VGPU-C1-OVERRIDE-OUT-OF-RANGE",
      "config",
    ],
    [
      "error/f16-rounded-boundary-positive",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig("F16_HALF", "number", "65504.00000000001")],
      "VGPU-C1-OVERRIDE-OUT-OF-RANGE",
      "config",
    ],
    [
      "error/f16-rounded-boundary-negative",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig("F16_HALF", "number", "-65504.00000000001")],
      "VGPU-C1-OVERRIDE-OUT-OF-RANGE",
      "config",
    ],
    [
      "error/f16-adjacent-overflow-positive",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig("F16_HALF", "number", "65504.0000001")],
      "VGPU-C1-OVERRIDE-OUT-OF-RANGE",
      "config",
    ],
    [
      "error/f16-adjacent-overflow-negative",
      "all-scalars.wgsl",
      "main",
      "f16",
      [identifierConfig("F16_HALF", "number", "-65504.0000001")],
      "VGPU-C1-OVERRIDE-OUT-OF-RANGE",
      "config",
    ],
    [
      "error/missing-required",
      "required-and-subsets.wgsl",
      "needs_required",
      undefined,
      [],
      "VGPU-C1-OVERRIDE-MISSING-REQUIRED",
      "materialize",
    ],
    [
      "error/invalid-initializer-omitted",
      "invalid-initializer.wgsl",
      "main",
      undefined,
      [],
      "VGPU-C1-OVERRIDE-INVALID-INITIALIZER",
      "materialize",
    ],
  ];
  for (const [
    id,
    source,
    entryPoint,
    feature,
    config,
    code,
    phase,
  ] of negativeCases) {
    expectError(
      execute({ id, source, entryPoint, feature, config }),
      id,
      code,
      phase
    );
  }

  const conflictConfig = [
    identifierConfig("EXPLICIT", "bool", "true"),
    identifierConfig("17", "number", "2.5"),
  ];
  const conflictA = execute({
    id: "determinism/invalid-config-order-a",
    source: "all-scalars.wgsl",
    entryPoint: "main",
    feature: "f16",
    config: conflictConfig,
  });
  const conflictB = execute({
    id: "determinism/invalid-config-order-b",
    source: "all-scalars.wgsl",
    entryPoint: "main",
    feature: "f16",
    config: [...conflictConfig].reverse(),
  });
  expectError(
    conflictA,
    "determinism/invalid-config-order-a",
    "VGPU-C1-OVERRIDE-UNKNOWN",
    "config"
  );
  expectError(
    conflictB,
    "determinism/invalid-config-order-b",
    "VGPU-C1-OVERRIDE-UNKNOWN",
    "config"
  );
  assert(
    conflictA.stdout === conflictB.stdout,
    "invalid config order changed the canonical diagnostic"
  );

  return {
    status: "passed",
    dawnCommit: tintRevision,
    verifiedHashes: [
      "include/**",
      "lib/libwebgpu_dawn.a",
      "src/utils/compiler.h",
    ],
    compilerExecutableSha256: builds[0].sha256,
    deterministicBuilds: builds.length,
    logicalCases,
    deterministicInvocations: invocations,
    multiEntryApiInvocations: apiGateAttempts.length,
    canonicalProgramUnion: ["FIRST", "SECOND", "SHARED"],
    iterativeDependencyCount: wideDependencyNames.length,
    scalarTypes: ["bool", "i32", "u32", "f16", "f32"],
    dependentDefault: { allDefaults: 8, partialSelection: 10 },
    workgroupExpressionClosure: ["X", "Y"],
    structuredNegativeCases: negativeCases.length,
  };
}

const options = parseArguments(process.argv.slice(2));
const scratch = mkdtempSync(join(tmpdir(), "vgpu-c1-override-defaults-"));

try {
  const result = {
    schemaVersion: 1,
    contractId: runnerContract,
    static: runStaticGate(),
    tint: runTintGate(options, scratch),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
