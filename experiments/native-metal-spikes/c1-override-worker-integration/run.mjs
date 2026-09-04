#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

import {
  compileTintPrototype,
  decodeTintWorkerResponse,
  invokeRawTintPrototype,
  runCommand,
} from "../c1-compiler-protocol/lib/native-compiler.mjs";
import {
  assertRequestSemantics,
  assertResponseSemantics,
  attachDiagnosticOrigins,
  COMPILER_CONTRACT,
  sha256Utf8,
  TINT_REVISION as WORKER_TINT_REVISION,
} from "../c1-compiler-protocol/lib/protocol.mjs";
import {
  assertMaterializerFailure,
  materializerToExactStaticRequest,
  MATERIALIZER_CONTRACT,
  OverrideIntegrationError,
  TINT_REVISION,
} from "./lib/materializer-contract.mjs";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const overrideFixtureDirectory = resolve(
  fixtureDirectory,
  "..",
  "c1-override-defaults"
);
const compilerFixtureDirectory = resolve(
  fixtureDirectory,
  "..",
  "c1-compiler-protocol"
);
const canaryDirectory = join(overrideFixtureDirectory, "canaries");
const materializerSource = join(
  overrideFixtureDirectory,
  "prototype",
  "main.cc"
);
const runnerContract = "vgpu-native-override-worker-integration-runner/v1";
const expectedInternalReservation = {
  role: "immediate-data",
  slots: [
    {
      mode: "direct",
      resourceClass: "buffer",
      component: "buffer",
      index: 30,
      count: 1,
    },
  ],
};

function fail(message) {
  throw new Error(`C1 override/worker integration: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function same(actual, expected, message) {
  assert(isDeepStrictEqual(actual, expected), message);
}

function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(
      "Usage: node run.mjs [--release-root <Dawn release>] " +
        "[--compat-include <header overlay>] " +
        "[--jsoncpp-root <JsonCpp checkout>] [--require-native]\n"
    );
    process.exit(0);
  }
  const options = {
    releaseRoot: process.env.C1_OVERRIDE_WORKER_INTEGRATION_TINT_RELEASE_ROOT,
    compatInclude:
      process.env.C1_OVERRIDE_WORKER_INTEGRATION_TINT_COMPAT_INCLUDE,
    jsoncppRoot: process.env.C1_OVERRIDE_WORKER_INTEGRATION_JSONCPP_ROOT,
    requireNative:
      process.env.C1_OVERRIDE_WORKER_INTEGRATION_REQUIRE_NATIVE === "1",
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-native") {
      if (seen.has(argument)) fail(`${argument} may appear only once`);
      seen.add(argument);
      options.requireNative = true;
      continue;
    }
    const key = {
      "--release-root": "releaseRoot",
      "--compat-include": "compatInclude",
      "--jsoncpp-root": "jsoncppRoot",
    }[argument];
    if (key) {
      if (seen.has(argument)) fail(`${argument} may appear only once`);
      seen.add(argument);
      const value = argv[++index];
      if (!value) fail(`${argument} requires a value`);
      options[key] = resolve(value);
      continue;
    }
    fail(`unknown argument ${argument}`);
  }
  for (const key of ["releaseRoot", "compatInclude", "jsoncppRoot"]) {
    if (options[key]) options[key] = resolve(options[key]);
  }
  const dependencyCount = [
    options.releaseRoot,
    options.compatInclude,
    options.jsoncppRoot,
  ].filter(Boolean).length;
  if (dependencyCount !== 0 && dependencyCount !== 3) {
    fail(
      "--release-root, --compat-include, and --jsoncpp-root must be provided together"
    );
  }
  if (options.requireNative && dependencyCount !== 3) {
    fail("--require-native requires all three dependency roots");
  }
  return options;
}

function expectIntegrationError(run, expectedCode, label) {
  try {
    run();
  } catch (error) {
    assert(
      error instanceof OverrideIntegrationError && error.code === expectedCode,
      `${label} returned ${String(error?.code)} instead of ${expectedCode}`
    );
    return;
  }
  fail(`${label} escaped its negative gate`);
}

function u32(name, value, id = value) {
  return {
    name,
    id: { value: id, kind: "auto" },
    type: "u32",
    initializer: "present",
    defaultEvaluation: { status: "value", value: { type: "u32", value } },
    selected: { type: "u32", value },
  };
}

function syntheticMaterialization() {
  const selectedA = {
    name: "A",
    id: { value: 1, kind: "auto" },
    type: "u32",
    initializer: "present",
    defaultEvaluation: {
      status: "unavailable",
      reason: "requires-configuration",
    },
    selected: { type: "u32", value: 7 },
  };
  return {
    schemaVersion: 1,
    contractId: MATERIALIZER_CONTRACT,
    ok: true,
    upstreamRevision: TINT_REVISION,
    sourceName: "resolved/invalid-initializer.wgsl",
    sourceSha256: "0".repeat(64),
    entryPoint: { name: "main", stage: "compute" },
    overrides: [structuredClone(selectedA)],
    staticOverrides: [selectedA, u32("X", 0, 0)],
    verification: {
      singleEntryPoint: true,
      substituteOverrides: true,
      fullActiveMapAccepted: true,
      verifiedOverrideCount: 1,
      exactStaticOverrideCount: 2,
      workgroupSize: [7, 1, 1],
      workgroupSizeAxes: [
        { resolved: 7, kind: "override-expression", overrides: ["A"] },
        { resolved: 1, kind: "literal", overrides: [] },
        { resolved: 1, kind: "literal", overrides: [] },
      ],
    },
  };
}

function runAdapterGate() {
  const expected = {
    sourceName: "resolved/invalid-initializer.wgsl",
    sourceSha256: "0".repeat(64),
    entryPoint: "main",
    stage: "compute",
  };
  const fixture = syntheticMaterialization();
  same(
    materializerToExactStaticRequest(fixture, expected),
    [
      { name: "A", value: { type: "u32", value: 7 } },
      { name: "X", value: { type: "u32", value: 0 } },
    ],
    "adapter did not project the exact static typed map"
  );

  const mutations = [
    [
      "missing-static-view",
      (value) => delete value.staticOverrides,
      "VGPU-C1-INTEGRATION-STATIC-OVERRIDES",
    ],
    [
      "unsorted-static-view",
      (value) => value.staticOverrides.reverse(),
      "VGPU-C1-INTEGRATION-MATERIALIZER-ORDER",
    ],
    [
      "selected-type-mismatch",
      (value) =>
        (value.staticOverrides[1].selected = { type: "i32", value: 0 }),
      "VGPU-C1-INTEGRATION-MATERIALIZER-TYPE",
    ],
    [
      "effective-value-mismatch",
      (value) => (value.overrides[0].selected.value = 8),
      "VGPU-C1-INTEGRATION-EFFECTIVE-SUBSET",
    ],
    [
      "stale-source-hash",
      (value) => (value.sourceSha256 = "1".repeat(64)),
      "VGPU-C1-INTEGRATION-SOURCE-HASH",
    ],
    [
      "static-count-mismatch",
      (value) => (value.verification.exactStaticOverrideCount = 1),
      "VGPU-C1-INTEGRATION-MATERIALIZER-VERIFICATION",
    ],
    [
      "workgroup-dependency-not-effective",
      (value) =>
        (value.verification.workgroupSizeAxes[0].overrides = ["A", "X"]),
      "VGPU-C1-INTEGRATION-MATERIALIZER-VERIFICATION",
    ],
    [
      "duplicate-static-name",
      (value) => {
        value.staticOverrides[1].name = "A";
        value.staticOverrides[1].id.value = 2;
      },
      "VGPU-C1-INTEGRATION-MATERIALIZER-ORDER",
    ],
  ];
  for (const [label, mutate, code] of mutations) {
    const value = syntheticMaterialization();
    mutate(value);
    expectIntegrationError(
      () => materializerToExactStaticRequest(value, expected),
      code,
      label
    );
  }

  const failure = {
    schemaVersion: 1,
    contractId: MATERIALIZER_CONTRACT,
    ok: false,
    upstreamRevision: TINT_REVISION,
    diagnostics: [
      {
        code: "VGPU-C1-OVERRIDE-MISSING-REQUIRED",
        phase: "materialize",
        message: "active override REQUIRED has no initializer",
      },
    ],
  };
  assertMaterializerFailure(
    failure,
    "VGPU-C1-OVERRIDE-MISSING-REQUIRED",
    "materialize"
  );
  expectIntegrationError(
    () => materializerToExactStaticRequest(failure, expected),
    "VGPU-C1-INTEGRATION-MATERIALIZER-FAILED",
    "failed-materialization"
  );
  return { status: "passed", positiveCases: 1, negativeCases: 9 };
}

function runStaticGate() {
  const adapter = runAdapterGate();
  assert(
    TINT_REVISION === WORKER_TINT_REVISION,
    "materializer and compiler worker pin different Tint revisions"
  );
  const materializerText = readFileSync(materializerSource, "utf8");
  for (const token of [
    "inspector.Overrides()",
    "GetEntryPoint(arguments.entry_point)",
    "ProgramToLoweredIR(program)",
    "SubstituteOverrides",
    "staticOverrides",
    "sourceSha256",
  ]) {
    assert(
      materializerText.includes(token),
      `materializer source omits required integration seam ${token}`
    );
  }
  const workerText = readFileSync(
    join(compilerFixtureDirectory, "prototype", "main.cc"),
    "utf8"
  );
  for (const token of [
    "SetInitializer",
    "SingleEntryPoint",
    "SubstituteOverrides",
    "SubstituteOverrides left a live override",
  ]) {
    assert(
      workerText.includes(token),
      `compiler worker omits exact-static invariant ${token}`
    );
  }
  return {
    status: "passed",
    adapter,
    materializerSeam: "staticOverrides",
    workerBoundary: "exact-static",
    tintRevision: TINT_REVISION,
  };
}

function loadValidators() {
  const schemas = [
    "origin-map-v1.schema.json",
    "request-v1.schema.json",
    "response-v1.schema.json",
  ].map((name) =>
    JSON.parse(
      readFileSync(join(compilerFixtureDirectory, "contracts", name), "utf8")
    )
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) ajv.addSchema(schema);
  return {
    request: ajv.getSchema(
      "https://vgpu.sh/schemas/native/tint-compiler/v1/request.schema.json"
    ),
    response: ajv.getSchema(
      "https://vgpu.sh/schemas/native/tint-compiler/v1/response.schema.json"
    ),
  };
}

function assertSchema(validate, value, label) {
  assert(typeof validate === "function", `${label} validator is unavailable`);
  if (!validate(value)) {
    fail(
      `${label} failed schema validation: ${JSON.stringify(validate.errors)}`
    );
  }
}

function compileMaterializer({ releaseRoot, compatInclude, scratch }) {
  const executable = join(scratch, "vgpu-override-defaults-prototype");
  const includeRoot = join(releaseRoot, "include");
  const library = join(releaseRoot, "lib", "libwebgpu_dawn.a");
  const result = runCommand("/usr/bin/xcrun", [
    "clang++",
    "-std=c++20",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-Werror",
    materializerSource,
    `-I${compatInclude}`,
    `-I${join(includeRoot, "src", "tint")}`,
    `-I${includeRoot}`,
    library,
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
  ]);
  if (result.error || result.signal || result.status !== 0) {
    fail(`materializer compilation failed: ${result.stderr.trim()}`);
  }
  return {
    executable,
    sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  };
}

function assertNoPhysicalPath(text, physicalPaths, label) {
  for (const path of physicalPaths) {
    assert(
      !path || !text.includes(path),
      `${label} leaked physical path ${path}`
    );
  }
  assert(
    !/(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\\\)/u.test(
      text
    ),
    `${label} leaked an absolute host path`
  );
}

function nameConfig(key, kind, payload) {
  return { by: "name", key, kind, payload };
}

function invokeMaterializerOnce({
  executable,
  sourcePath,
  sourceName,
  entryPoint,
  languageFeatures,
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
  for (const feature of languageFeatures) args.push("--feature", feature);
  for (const item of config) {
    args.push(`--${item.by}`, String(item.key), item.kind, item.payload);
  }
  return runCommand(executable, args);
}

function invokeMaterializer(input, physicalPaths) {
  const attempts = [
    invokeMaterializerOnce(input),
    invokeMaterializerOnce(input),
  ];
  same(
    attempts[0],
    attempts[1],
    `${input.id} materializer is nondeterministic`
  );
  const attempt = attempts[0];
  assert(!attempt.error, `${input.id} materializer failed to launch`);
  assert(
    !attempt.signal,
    `${input.id} materializer received ${attempt.signal}`
  );
  assert(attempt.stderr === "", `${input.id} materializer wrote stderr`);
  assert(
    attempt.stdout.endsWith("\n"),
    `${input.id} materializer omitted its terminal newline`
  );
  assertNoPhysicalPath(attempt.stdout, physicalPaths, input.id);
  let result;
  try {
    result = JSON.parse(attempt.stdout);
  } catch (error) {
    fail(
      `${input.id} materializer did not emit one JSON value: ${error.message}`
    );
  }
  assert(
    (result.ok === true && attempt.status === 0) ||
      (result.ok === false && attempt.status === 1),
    `${input.id} materializer status disagrees with result.ok`
  );
  return { result, invocations: attempts.length };
}

function exactStaticRequest({
  materialization,
  sourceText,
  sourceName,
  sourceInput,
  entryPoint,
  emittedName,
  stage = "compute",
  languageFeatures = [],
}) {
  const sha256 = sha256Utf8(sourceText);
  const overrides = materializerToExactStaticRequest(materialization, {
    sourceName,
    sourceSha256: sha256,
    entryPoint,
    stage,
  });
  return {
    schemaVersion: 1,
    contractId: COMPILER_CONTRACT,
    source: { virtualPath: sourceName, sha256, text: sourceText },
    originMap: {
      schemaVersion: 1,
      contractId: "vgpu-native-origin-map/v1",
      generatedSource: { virtualPath: sourceName, sha256 },
      sources: [{ input: sourceInput, sha256 }],
      segments: [
        {
          generated: {
            startByte: 0,
            endByte: Buffer.byteLength(sourceText, "utf8"),
          },
          origin: { input: sourceInput },
          precision: "module",
        },
      ],
    },
    entryPoint: { stage, wgsl: entryPoint, metal: emittedName },
    overrides,
    languageFeatures,
    metal: {
      bindingModel: "vgpu-metal-binding-slots-v1",
      bindings: [],
      internalReservations: [structuredClone(expectedInternalReservation)],
      storageBufferSizes: {
        model: "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
        immediateDataByteOffset: 4,
      },
    },
  };
}

async function invokeWorker({
  id,
  executable,
  request,
  validators,
  physicalPaths,
  countLaunches,
  expectation = { ok: true },
}) {
  assertSchema(validators.request, request, `${id} request`);
  assertRequestSemantics(request);
  countLaunches(2);
  const attempts = await Promise.all([
    invokeRawTintPrototype({ executable, request }),
    invokeRawTintPrototype({ executable, request }),
  ]);
  assert(
    attempts[0].status === attempts[1].status &&
      attempts[0].stdout === attempts[1].stdout &&
      attempts[0].stderr === attempts[1].stderr,
    `${id} worker response is nondeterministic`
  );
  assertNoPhysicalPath(attempts[0].stdout, physicalPaths, id);
  const responses = attempts.map((attempt, index) => {
    try {
      return decodeTintWorkerResponse(attempt, (response) => {
        assertSchema(
          validators.response,
          response,
          `${id} response ${index + 1}`
        );
      });
    } catch (error) {
      fail(`${id} returned untrusted worker output: ${error.message}`);
    }
  });
  same(responses[0], responses[1], `${id} decoded responses differ`);
  const response = attachDiagnosticOrigins(request, responses[0]);
  assertSchema(validators.response, response, `${id} enriched response`);
  assertResponseSemantics(request, response);
  assert(response.ok === expectation.ok, `${id} returned ok=${response.ok}`);
  if (!expectation.ok) {
    assert(
      response.diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === "error" &&
          diagnostic.code === expectation.code &&
          diagnostic.phase === expectation.phase &&
          (expectation.messageIncludes === undefined ||
            diagnostic.message.includes(expectation.messageIncludes))
      ),
      `${id} omitted its expected compiler diagnostic`
    );
  }
  return response;
}

function assertMaterializedNames(materialization, property, expected, id) {
  same(
    materialization[property].map(({ name }) => name),
    expected,
    `${id} ${property} differs`
  );
}

function nativeCases() {
  return [
    {
      id: "configured-dependent-and-required",
      source: "required-and-subsets.wgsl",
      sourceName: "resolved/required-and-subsets.wgsl",
      sourceInput: "required-and-subsets-wgsl",
      entryPoint: "needs_required",
      emittedName: "vgpu_required_and_subsets",
      config: [
        nameConfig("DEP", "number", "9"),
        nameConfig("REQUIRED", "number", "4"),
      ],
      effectiveNames: ["DEP"],
      staticNames: ["DEP", "REQUIRED"],
      exactOverrides: [
        { name: "DEP", value: { type: "u32", value: 9 } },
        { name: "REQUIRED", value: { type: "u32", value: 4 } },
      ],
      workgroupX: 9,
    },
    {
      id: "inactive-required-and-configured-second",
      source: "required-and-subsets.wgsl",
      sourceName: "resolved/required-and-subsets.wgsl",
      sourceInput: "required-and-subsets-wgsl",
      entryPoint: "first",
      emittedName: "vgpu_first",
      config: [nameConfig("SECOND", "number", "7")],
      effectiveNames: ["FIRST"],
      staticNames: ["FIRST"],
      exactOverrides: [{ name: "FIRST", value: { type: "u32", value: 2 } }],
      workgroupX: 2,
    },
    {
      id: "invalid-initializer-bypassed",
      source: "invalid-initializer.wgsl",
      sourceName: "resolved/invalid-initializer.wgsl",
      sourceInput: "invalid-initializer-wgsl",
      entryPoint: "main",
      emittedName: "vgpu_invalid_initializer",
      config: [nameConfig("A", "number", "7")],
      effectiveNames: ["A"],
      staticNames: ["A", "X"],
      exactOverrides: [
        { name: "A", value: { type: "u32", value: 7 } },
        { name: "X", value: { type: "u32", value: 0 } },
      ],
      workgroupX: 7,
    },
    {
      id: "all-scalar-kinds",
      source: "all-scalars.wgsl",
      sourceName: "resolved/all-scalars.wgsl",
      sourceInput: "all-scalars-wgsl",
      entryPoint: "main",
      emittedName: "vgpu_all_scalars",
      languageFeatures: ["f16"],
      config: [nameConfig("BASE", "number", "5")],
      effectiveNames: [
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
      ],
      staticNames: [
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
      ],
      exactOverrides: [
        { name: "BASE", value: { type: "u32", value: 5 } },
        { name: "DEP", value: { type: "u32", value: 10 } },
        { name: "EXPLICIT", value: { type: "f32", bits: "3fc00000" } },
        { name: "F16_HALF", value: { type: "f16", bits: "3800" } },
        { name: "F16_MAX", value: { type: "f16", bits: "7bff" } },
        { name: "F16_SUB", value: { type: "f16", bits: "0001" } },
        { name: "F32_MAX", value: { type: "f32", bits: "7f7fffff" } },
        { name: "F32_SUB", value: { type: "f32", bits: "00000001" } },
        { name: "FLAG", value: { type: "bool", value: true } },
        { name: "SIGNED", value: { type: "i32", value: -7 } },
      ],
      workgroupX: 10,
    },
  ];
}

async function runNativeGate(options, scratch) {
  if (!options.releaseRoot) {
    return { status: "skipped", reason: "dependency-roots-not-provided" };
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    if (options.requireNative) {
      fail("pinned feasibility dependencies require a Darwin arm64 host");
    }
    return { status: "skipped", reason: "requires-darwin-arm64" };
  }

  const workerScratch = join(scratch, "worker");
  const materializerScratch = join(scratch, "materializer");
  mkdirSync(workerScratch);
  mkdirSync(materializerScratch);
  // This helper verifies the pinned Dawn include tree and archive, the exact
  // compatibility overlay, and the JsonCpp compiled closure before building.
  const worker = compileTintPrototype({
    fixtureDirectory: compilerFixtureDirectory,
    releaseRoot: options.releaseRoot,
    compatInclude: options.compatInclude,
    jsoncppRoot: options.jsoncppRoot,
    scratch: workerScratch,
  });
  const materializer = compileMaterializer({
    releaseRoot: options.releaseRoot,
    compatInclude: options.compatInclude,
    scratch: materializerScratch,
  });
  const validators = loadValidators();
  const physicalPaths = [
    options.releaseRoot,
    options.compatInclude,
    options.jsoncppRoot,
    scratch,
    fixtureDirectory,
    overrideFixtureDirectory,
    compilerFixtureDirectory,
  ];
  let materializerInvocations = 0;
  let workerInvocations = 0;
  let staleMaterializationRejectedBeforeWorker = false;

  const missingSource = "required-and-subsets.wgsl";
  const missing = invokeMaterializer(
    {
      id: "missing-required-before-worker",
      executable: materializer.executable,
      sourcePath: join(canaryDirectory, missingSource),
      sourceName: `resolved/${missingSource}`,
      entryPoint: "needs_required",
      languageFeatures: [],
      config: [],
    },
    physicalPaths
  );
  materializerInvocations += missing.invocations;
  assertMaterializerFailure(
    missing.result,
    "VGPU-C1-OVERRIDE-MISSING-REQUIRED",
    "materialize"
  );
  assert(
    workerInvocations === 0,
    "missing REQUIRED reached the compiler worker"
  );

  const observed = [];
  const requests = new Map();
  const cases = nativeCases();
  for (const canary of cases) {
    const sourcePath = join(canaryDirectory, canary.source);
    const sourceText = readFileSync(sourcePath, "utf8");
    const run = invokeMaterializer(
      {
        ...canary,
        executable: materializer.executable,
        sourcePath,
        languageFeatures: canary.languageFeatures ?? [],
      },
      physicalPaths
    );
    materializerInvocations += run.invocations;
    assert(run.result.ok === true, `${canary.id} materialization failed`);
    assertMaterializedNames(
      run.result,
      "overrides",
      canary.effectiveNames,
      canary.id
    );
    if (canary.id === "invalid-initializer-bypassed") {
      const stale = structuredClone(run.result);
      stale.sourceSha256 =
        stale.sourceSha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
      const launchesBeforeRejection = workerInvocations;
      expectIntegrationError(
        () =>
          exactStaticRequest({
            materialization: stale,
            sourceText,
            sourceName: canary.sourceName,
            sourceInput: canary.sourceInput,
            entryPoint: canary.entryPoint,
            emittedName: canary.emittedName,
            languageFeatures: canary.languageFeatures,
          }),
        "VGPU-C1-INTEGRATION-SOURCE-HASH",
        "stale-materialization"
      );
      assert(
        workerInvocations === launchesBeforeRejection,
        "stale materialization reached the compiler worker"
      );
      staleMaterializationRejectedBeforeWorker = true;
    }
    const request = exactStaticRequest({
      materialization: run.result,
      sourceText,
      sourceName: canary.sourceName,
      sourceInput: canary.sourceInput,
      entryPoint: canary.entryPoint,
      emittedName: canary.emittedName,
      languageFeatures: canary.languageFeatures,
    });
    assertMaterializedNames(
      run.result,
      "staticOverrides",
      canary.staticNames,
      canary.id
    );
    same(
      request.overrides,
      canary.exactOverrides,
      `${canary.id} exact-static projection drifted`
    );
    requests.set(canary.id, request);
    const response = await invokeWorker({
      id: canary.id,
      executable: worker.executable,
      request,
      validators,
      physicalPaths,
      countLaunches(count) {
        workerInvocations += count;
      },
    });
    assert(
      response.result.resolvedWorkgroupSize?.x === canary.workgroupX,
      `${canary.id} returned the wrong workgroup X dimension`
    );
    observed.push({
      id: canary.id,
      effectiveOverrides: canary.effectiveNames,
      staticOverrides: canary.staticNames,
      workgroupX: canary.workgroupX,
    });
  }

  const missingStatic = structuredClone(
    requests.get("invalid-initializer-bypassed")
  );
  missingStatic.overrides.pop();
  await invokeWorker({
    id: "worker-rejects-missing-static-x",
    executable: worker.executable,
    request: missingStatic,
    validators,
    physicalPaths,
    countLaunches(count) {
      workerInvocations += count;
    },
    expectation: {
      ok: false,
      code: "VGPU-NATIVE-TINT-INSPECT",
      phase: "inspect",
      messageIncludes: "request override set differs",
    },
  });
  const extraStatic = structuredClone(
    requests.get("inactive-required-and-configured-second")
  );
  extraStatic.overrides.push(
    { name: "REQUIRED", value: { type: "u32", value: 4 } },
    { name: "SECOND", value: { type: "u32", value: 7 } }
  );
  await invokeWorker({
    id: "worker-rejects-inactive-static-extras",
    executable: worker.executable,
    request: extraStatic,
    validators,
    physicalPaths,
    countLaunches(count) {
      workerInvocations += count;
    },
    expectation: {
      ok: false,
      code: "VGPU-NATIVE-TINT-INSPECT",
      phase: "inspect",
      messageIncludes: "request override set differs",
    },
  });
  assert(
    new Set(
      cases
        .find(({ id }) => id === "all-scalar-kinds")
        .exactOverrides.map((item) => item.value.type)
    ).size === 5,
    "all scalar kinds were not projected"
  );
  assert(
    workerInvocations === (observed.length + 2) * 2,
    "worker invocation accounting drifted"
  );
  return {
    status: "passed",
    dawnCommit: TINT_REVISION,
    materializerExecutableSha256: materializer.sha256,
    workerExecutableSha256: worker.sha256,
    missingRequiredRejectedBeforeWorker: true,
    staleMaterializationRejectedBeforeWorker,
    materializerInvocations,
    workerInvocations,
    negativeWorkerCanaries: 2,
    scalarTypes: ["bool", "i32", "u32", "f16", "f32"],
    cases: observed,
  };
}

const options = parseArguments(process.argv.slice(2));
const scratch = mkdtempSync(
  join(tmpdir(), "vgpu-c1-override-worker-integration-")
);

try {
  const result = {
    schemaVersion: 1,
    contractId: runnerContract,
    static: runStaticGate(),
    native: await runNativeGate(options, scratch),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
