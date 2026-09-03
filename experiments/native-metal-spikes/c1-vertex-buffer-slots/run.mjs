#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  allocateVertexBufferSlots,
  VertexBufferSlotAllocationError,
} from "./lib/allocate.mjs";
import {
  verifyVertexBufferSlots,
  VertexBufferSlotVerificationError,
} from "./lib/verify.mjs";

const spikeDirectory = dirname(fileURLToPath(import.meta.url));
const fixturesDirectory = join(spikeDirectory, "fixtures");
const candidateId = "c1-metal-pipeline-local-vertex-partition";
const metalSources = [
  "collision.metal",
  "partition.metal",
  "exact-capacity.metal",
];

function fail(message) {
  throw new Error(`C1 vertex buffer slots: ${message}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys, owner) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${owner} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (!isDeepStrictEqual(actual, expected)) {
    fail(`${owner} has unexpected or missing properties`);
  }
}

function parseArguments(argv) {
  const options = {
    skipMetalRuntime: process.env.C1_VERTEX_SKIP_METAL_RUNTIME === "1",
    requireMetalRuntime: process.env.C1_VERTEX_REQUIRE_METAL_RUNTIME === "1",
    requireOfflineMetal: process.env.C1_VERTEX_REQUIRE_OFFLINE_METAL === "1",
  };
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: node run.mjs [--skip-metal-runtime] " +
          "[--require-metal-runtime] [--require-offline-metal]\n"
      );
      process.exit(0);
    }
    if (argument === "--skip-metal-runtime") {
      options.skipMetalRuntime = true;
      continue;
    }
    if (argument === "--require-metal-runtime") {
      options.requireMetalRuntime = true;
      continue;
    }
    if (argument === "--require-offline-metal") {
      options.requireOfflineMetal = true;
      continue;
    }
    fail(`unknown argument ${argument}`);
  }
  if (options.skipMetalRuntime && options.requireMetalRuntime) {
    fail("--skip-metal-runtime conflicts with --require-metal-runtime");
  }
  return options;
}

function fixtureInput(fixtures) {
  return {
    profile: clone(fixtures.profile),
    pipelines: clone(fixtures.pipelines),
  };
}

function permuteInput(input) {
  const permuted = clone(input);
  permuted.profile.internalReservations.reverse();
  permuted.pipelines.reverse();
  for (const pipeline of permuted.pipelines) {
    pipeline.internalRoles.reverse();
  }
  return permuted;
}

function resolveMutationTarget(root, path, operationId) {
  if (!Array.isArray(path) || path.length === 0) {
    fail(`${operationId} has an empty mutation path`);
  }
  let target = root;
  for (const key of path.slice(0, -1)) {
    if (
      target === null ||
      typeof target !== "object" ||
      !Object.hasOwn(target, key)
    ) {
      fail(`${operationId} references a missing mutation path`);
    }
    target = target[key];
  }
  if (target === null || typeof target !== "object") {
    fail(`${operationId} mutation parent is not an object or array`);
  }
  return { target, key: path.at(-1) };
}

function applyMutation(input, operation, mutationId) {
  const operationId = `${mutationId}/${operation.op}`;
  if (operation.op === "set") {
    exactKeys(operation, ["op", "path", "value"], operationId);
    const { target, key } = resolveMutationTarget(
      input,
      operation.path,
      operationId
    );
    target[key] = clone(operation.value);
    return;
  }
  if (operation.op === "append") {
    exactKeys(operation, ["op", "path", "value"], operationId);
    const { target, key } = resolveMutationTarget(
      input,
      operation.path,
      operationId
    );
    if (!Array.isArray(target[key])) {
      fail(`${operationId} target is not an array`);
    }
    target[key].push(clone(operation.value));
    return;
  }
  if (operation.op === "reverse") {
    exactKeys(operation, ["op", "path"], operationId);
    const { target, key } = resolveMutationTarget(
      input,
      operation.path,
      operationId
    );
    if (!Array.isArray(target[key])) {
      fail(`${operationId} target is not an array`);
    }
    target[key].reverse();
    return;
  }
  fail(`${mutationId} uses unsupported operation ${operation.op}`);
}

function expectAllocationError(input, expected, mutationId) {
  try {
    allocateVertexBufferSlots(input);
  } catch (error) {
    if (!(error instanceof VertexBufferSlotAllocationError)) throw error;
    if (
      error.code !== expected.code ||
      !error.message.includes(expected.messageIncludes)
    ) {
      fail(
        `${mutationId} expected ${expected.code}/${expected.messageIncludes}, ` +
          `received ${error.code}/${error.message}`
      );
    }
    return;
  }
  fail(`${mutationId} unexpectedly succeeded`);
}

function runAllocator(fixtures, mutationFixture, expectedSnapshot) {
  exactKeys(
    fixtures,
    ["schemaVersion", "candidate", "profile", "pipelines"],
    "fixtures/cases.json"
  );
  exactKeys(
    mutationFixture,
    ["schemaVersion", "mutations"],
    "fixtures/mutations.json"
  );
  exactKeys(
    expectedSnapshot,
    ["schemaVersion", "candidate", "projection"],
    "snapshots/expected.json"
  );
  if (
    fixtures.schemaVersion !== 1 ||
    mutationFixture.schemaVersion !== 1 ||
    expectedSnapshot.schemaVersion !== 1 ||
    fixtures.candidate !== candidateId ||
    expectedSnapshot.candidate !== candidateId
  ) {
    fail("fixture identity mismatch");
  }
  if (!Array.isArray(mutationFixture.mutations)) {
    fail("fixtures/mutations.json mutations must be an array");
  }

  const input = fixtureInput(fixtures);
  const first = allocateVertexBufferSlots(input);
  const second = allocateVertexBufferSlots(clone(input));
  const permuted = allocateVertexBufferSlots(permuteInput(input));
  if (
    !isDeepStrictEqual(first, second) ||
    !isDeepStrictEqual(first, permuted)
  ) {
    fail("allocator output is not deterministic under semantic reordering");
  }
  const inputBeforeVerification = clone(input);
  const projectionBeforeVerification = clone(first);
  verifyVertexBufferSlots(input, first);
  if (
    !isDeepStrictEqual(input, inputBeforeVerification) ||
    !isDeepStrictEqual(first, projectionBeforeVerification)
  ) {
    fail("independent verifier mutated its input or projection");
  }
  const actualSnapshot = {
    schemaVersion: 1,
    candidate: candidateId,
    projection: first,
  };
  if (!isDeepStrictEqual(actualSnapshot, expectedSnapshot)) {
    process.stderr.write(`${JSON.stringify(actualSnapshot, null, 2)}\n`);
    fail("allocator snapshot drifted");
  }

  for (const mutation of mutationFixture.mutations) {
    exactKeys(mutation, ["id", "operations", "expected"], "mutation");
    if (
      typeof mutation.id !== "string" ||
      mutation.id.length === 0 ||
      !Array.isArray(mutation.operations)
    ) {
      fail("mutation id or operations are invalid");
    }
    const mutated = clone(input);
    for (const operation of mutation.operations) {
      applyMutation(mutated, operation, mutation.id);
    }
    if (mutation.expected.status === "same-projection") {
      exactKeys(mutation.expected, ["status"], `${mutation.id}/expected`);
      const projection = allocateVertexBufferSlots(mutated);
      verifyVertexBufferSlots(mutated, projection);
      if (!isDeepStrictEqual(projection, first)) {
        fail(`${mutation.id} changed the canonical projection`);
      }
      continue;
    }
    if (mutation.expected.status === "error") {
      exactKeys(
        mutation.expected,
        ["status", "code", "messageIncludes"],
        `${mutation.id}/expected`
      );
      expectAllocationError(mutated, mutation.expected, mutation.id);
      continue;
    }
    fail(`${mutation.id} has an unknown expected status`);
  }

  const verifierCases = [
    {
      id: "vertex-stream-collides-with-shader",
      code: "SLOT_COLLISION",
      mutate(projection) {
        projection.pipelines[0].vertexStreams[0].metalIndex = 20;
      },
    },
    {
      id: "internal-collides-with-vertex-stream",
      code: "SLOT_COLLISION",
      mutate(projection) {
        projection.pipelines[0].internalBindings[0].index = 28;
      },
    },
    {
      id: "candidate-range-crosses-ceiling",
      code: "PROJECTION_MISMATCH",
      mutate(projection) {
        projection.pipelines[0].vertexInputRange.endExclusive = 31;
      },
    },
    {
      id: "missing-vertex-stream",
      code: "PROJECTION_MISMATCH",
      mutate(projection) {
        projection.pipelines[0].vertexStreams.pop();
      },
    },
    {
      id: "shader-occupied-end-is-cardinality",
      code: "PROJECTION_MISMATCH",
      mutate(projection) {
        projection.pipelines[2].shaderOccupiedEnd = 2;
        projection.pipelines[2].vertexInputRange.start = 2;
        projection.pipelines[2].vertexStreams[0].metalIndex = 2;
      },
    },
    {
      id: "mapping-key-version-drift",
      code: "PROJECTION_MISMATCH",
      mutate(projection) {
        projection.pipelines[3].mappingKey.bindingProfileVersion = 2;
      },
    },
    {
      id: "static-baseline-status-drift",
      code: "PROJECTION_MISMATCH",
      mutate(projection) {
        projection.staticBaseline.pipelines[1].status = "supported";
        projection.staticBaseline.pipelines[1].reason = null;
      },
    },
    {
      id: "non-canonical-pipeline-order",
      code: "PROJECTION_MISMATCH",
      mutate(projection) {
        projection.pipelines.reverse();
      },
    },
    {
      id: "unknown-root-property",
      code: "INVALID_SHAPE",
      mutate(projection) {
        projection.ignored = true;
      },
    },
    {
      id: "unknown-vertex-slot-property",
      code: "INVALID_SHAPE",
      mutate(projection) {
        projection.pipelines[0].vertexStreams[0].ignored = true;
      },
    },
  ];
  for (const verifierCase of verifierCases) {
    const tampered = clone(first);
    verifierCase.mutate(tampered);
    try {
      verifyVertexBufferSlots(input, tampered);
    } catch (error) {
      if (
        error instanceof VertexBufferSlotVerificationError &&
        error.code === verifierCase.code
      ) {
        continue;
      }
      throw error;
    }
    fail(`${verifierCase.id} escaped the independent verifier`);
  }

  return {
    projection: first,
    summary: {
      status: "passed",
      cases: fixtures.pipelines.length,
      deterministicRuns: 2,
      reorderedInputs: 1,
      mutations: mutationFixture.mutations.length,
      verifierMutations: verifierCases.length,
      verifierPurityChecks: 1,
    },
  };
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
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

function availableXcrunTool(tool) {
  const result = runCommand("xcrun", ["--find", tool]);
  return (
    !result.error && result.status === 0 && result.stdout.trim().length > 0
  );
}

function commandFailure(owner, result) {
  const diagnostic = `${result.stdout}${result.stderr}`.trim();
  const suffix = diagnostic ? `: ${diagnostic}` : "";
  fail(
    `${owner} failed with ${
      result.signal ? `signal ${result.signal}` : `status ${result.status}`
    }${suffix}`
  );
}

function validateExactCapacitySource() {
  const source = readFileSync(
    join(fixturesDirectory, "exact-capacity.metal"),
    "utf8"
  );
  const declarations = [
    ...source.matchAll(
      /\b(constant\s+(?:float|ExactImmediateData)&|device\s+const\s+float&)\s+([A-Za-z_][A-Za-z0-9_]*)\s+\[\[buffer\((\d+)\)\]\]/g
    ),
  ].map((match) => ({
    declaration: match[1].replaceAll(/\s+/g, " "),
    symbol: match[2],
    index: Number(match[3]),
  }));
  const expected = [
    ...Array.from({ length: 12 }, (_, index) => ({
      declaration: "constant float&",
      symbol: `buffer${index}`,
      index,
    })),
    ...Array.from({ length: 10 }, (_, offset) => ({
      declaration: "device const float&",
      symbol: `buffer${12 + offset}`,
      index: 12 + offset,
    })),
    {
      declaration: "constant ExactImmediateData&",
      symbol: "immediateData",
      index: 30,
    },
  ];
  const identity = (item) => `${item.declaration}/${item.index}/${item.symbol}`;
  const actualIdentities = declarations.map(identity).sort(compareText);
  const expectedIdentities = expected.map(identity).sort(compareText);
  const bufferAttributeCount = source.match(/\[\[buffer\(/g)?.length ?? 0;
  if (
    bufferAttributeCount !== expected.length ||
    !isDeepStrictEqual(actualIdentities, expectedIdentities) ||
    !/struct\s+ExactImmediateData\s*\{\s*float\s+ordinaryValue\s*;\s*uint\s+storageBufferSizes\s*\[\s*1\s*\]\s*;\s*\}\s*;/s.test(
      source
    ) ||
    !/\bimmediateData\.ordinaryValue\b/.test(source) ||
    !/\bimmediateData\.storageBufferSizes\s*\[\s*0\s*\]/.test(source)
  ) {
    fail(
      "exact-capacity.metal must keep 12 user constant, 10 device const, and one shared immediate-data struct buffer argument"
    );
  }
  return {
    status: "passed",
    userConstantArguments: 12,
    storageStyleArguments: 10,
    internalConstantArguments: 1,
    totalConstantArguments: 13,
    sharedImmediateFields: ["ordinaryValue", "storageBufferSizes[0]"],
  };
}

function pixelsMatch(actual, expected, tolerance) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (pixel, pixelIndex) =>
        Array.isArray(pixel) &&
        pixel.length === expected[pixelIndex].length &&
        pixel.every(
          (value, component) =>
            Number.isInteger(value) &&
            Math.abs(value - expected[pixelIndex][component]) <= tolerance
        )
    )
  );
}

function pipelineById(projection, id) {
  const pipeline = projection.pipelines.find(
    (candidate) => candidate.id === id
  );
  if (!pipeline) fail(`projection has no pipeline ${id}`);
  return pipeline;
}

function metalRuntimeInputs(projection) {
  const switchA = pipelineById(projection, "SwitchA");
  const switchB = pipelineById(projection, "SwitchB");
  const exact = pipelineById(projection, "DrawExactCapacity");
  if (
    switchA.vertexStreams.length !== 1 ||
    switchB.vertexStreams.length !== 1 ||
    exact.vertexStreams.length !== 8
  ) {
    fail("runtime canaries have unexpected vertex-stream cardinality");
  }
  const expandShaderIntervals = (pipeline) =>
    pipeline.shaderBufferIntervals.flatMap((interval) =>
      Array.from(
        { length: interval.count },
        (_, index) => interval.start + index
      )
    );
  const switchAShaderIndices = expandShaderIntervals(switchA);
  const switchBShaderIndices = expandShaderIntervals(switchB);
  if (
    !isDeepStrictEqual(switchAShaderIndices, [0]) ||
    !isDeepStrictEqual(switchBShaderIndices, [0, 1]) ||
    switchA.internalBindings.length !== 0 ||
    switchB.internalBindings.length !== 0
  ) {
    fail(
      "partition.metal no longer matches the projected SwitchA/SwitchB artifact slots"
    );
  }
  const immediate = exact.internalBindings.find(
    (binding) => binding.role === "immediate-data"
  );
  if (!immediate || exact.internalBindings.length !== 1) {
    fail("exact-capacity projection must emit only immediate-data");
  }
  return {
    switchAStream: switchA.vertexStreams[0].metalIndex,
    switchBStream: switchB.vertexStreams[0].metalIndex,
    switchAShaderIndices,
    switchBShaderIndices,
    exactStreamStart: exact.vertexStreams[0].metalIndex,
    exactVertexIndices: exact.vertexStreams.map((stream) => stream.metalIndex),
    exactShaderIndices: expandShaderIntervals(exact),
    immediateIndex: immediate.index,
  };
}

function validateMetalRuntimeResult(result, inputs) {
  exactKeys(
    result,
    ["schemaVersion", "status", "languageVersion", "collision", "candidate"],
    "Metal runtime result"
  );
  if (result.schemaVersion !== 1 || result.status !== "passed") {
    fail("Metal runtime returned an invalid passed result");
  }
  exactKeys(
    result.collision,
    [
      "pipelineCreation",
      "duplicateIndex",
      "usedBufferBindingCount",
      "isArgument",
      "sharedNamespace",
      "lastBoundSamples",
      "expectedLastBoundSamples",
      "tolerance",
    ],
    "Metal collision result"
  );
  exactKeys(
    result.candidate,
    ["pipelineCreation", "exactCapacity", "pipelineSwitch"],
    "Metal candidate result"
  );
  exactKeys(
    result.candidate.exactCapacity,
    [
      "shaderIndices",
      "vertexStreamIndices",
      "internalIndices",
      "usedBufferBindingCount",
      "uniqueBufferIndexCount",
      "renderSample",
      "renderExpected",
      "renderTolerance",
      "immediateData",
    ],
    "Metal exact-capacity result"
  );
  exactKeys(
    result.candidate.pipelineSwitch,
    [
      "streamIndices",
      "switchABindings",
      "switchBBindings",
      "samples",
      "expectedSamples",
      "tolerance",
    ],
    "Metal pipeline-switch result"
  );
  const expectedCollisionSamples = [
    [191, 191, 191, 255],
    [64, 64, 64, 255],
  ];
  const expectedSwitchSamples = [
    [0, 255, 0, 255],
    [0, 0, 0, 255],
    [0, 255, 0, 255],
    [255, 255, 255, 255],
    [0, 255, 0, 255],
  ];
  const expectedReflectedBindings = (shaderIndices, streamIndex) =>
    [
      ...shaderIndices.map((index) => ({ index, isArgument: true })),
      { index: streamIndex, isArgument: false },
    ].sort(
      (left, right) =>
        left.index - right.index ||
        Number(left.isArgument) - Number(right.isArgument)
    );
  const expectedSwitchABindings = expectedReflectedBindings(
    inputs.switchAShaderIndices,
    inputs.switchAStream
  );
  const expectedSwitchBBindings = expectedReflectedBindings(
    inputs.switchBShaderIndices,
    inputs.switchBStream
  );
  const exact = result.candidate.exactCapacity;
  const pipelineSwitch = result.candidate.pipelineSwitch;
  exactKeys(
    exact.immediateData,
    [
      "index",
      "ordinaryValue",
      "storageBufferSizeSentinel",
      "ordinaryValueByteOffset",
      "sizeTableByteOffset",
      "byteLength",
    ],
    "Metal exact-capacity immediate-data result"
  );
  if (
    result.languageVersion !== "2.4" ||
    result.collision.pipelineCreation !== "passed" ||
    result.collision.duplicateIndex !== 0 ||
    result.collision.usedBufferBindingCount !== 2 ||
    !isDeepStrictEqual(result.collision.isArgument, [false, true]) ||
    result.collision.sharedNamespace !== true ||
    !isDeepStrictEqual(
      result.collision.expectedLastBoundSamples,
      expectedCollisionSamples
    ) ||
    result.collision.tolerance !== 1 ||
    !pixelsMatch(
      result.collision.lastBoundSamples,
      expectedCollisionSamples,
      result.collision.tolerance
    ) ||
    result.candidate.pipelineCreation !== "passed" ||
    !isDeepStrictEqual(exact.shaderIndices, inputs.exactShaderIndices) ||
    !isDeepStrictEqual(exact.vertexStreamIndices, inputs.exactVertexIndices) ||
    !isDeepStrictEqual(exact.internalIndices, [inputs.immediateIndex]) ||
    !isDeepStrictEqual(exact.immediateData, {
      index: inputs.immediateIndex,
      ordinaryValue: 0.03125,
      storageBufferSizeSentinel: 8,
      ordinaryValueByteOffset: 0,
      sizeTableByteOffset: 4,
      byteLength: 8,
    }) ||
    exact.usedBufferBindingCount !== 31 ||
    exact.uniqueBufferIndexCount !== 31 ||
    !isDeepStrictEqual(exact.renderExpected, [128, 64, 191, 255]) ||
    exact.renderTolerance !== 1 ||
    !pixelsMatch(
      [exact.renderSample],
      [exact.renderExpected],
      exact.renderTolerance
    ) ||
    !isDeepStrictEqual(pipelineSwitch.streamIndices, [
      inputs.switchAStream,
      inputs.switchBStream,
    ]) ||
    !isDeepStrictEqual(
      pipelineSwitch.switchABindings,
      expectedSwitchABindings
    ) ||
    !isDeepStrictEqual(
      pipelineSwitch.switchBBindings,
      expectedSwitchBBindings
    ) ||
    !isDeepStrictEqual(pipelineSwitch.expectedSamples, expectedSwitchSamples) ||
    pipelineSwitch.tolerance !== 0 ||
    !pixelsMatch(
      pipelineSwitch.samples,
      expectedSwitchSamples,
      pipelineSwitch.tolerance
    )
  ) {
    fail("Metal runtime result does not match the candidate canaries");
  }
}

function runMetalRuntime(options, scratch, projection) {
  if (options.skipMetalRuntime) {
    return { status: "skipped", reason: "user-requested" };
  }
  if (process.platform !== "darwin") {
    if (options.requireMetalRuntime) {
      fail("Metal runtime is required but the host is not macOS");
    }
    return { status: "skipped", reason: "non-macos-host" };
  }
  if (!availableXcrunTool("swiftc")) {
    if (options.requireMetalRuntime) {
      fail("Metal runtime is required but xcrun cannot find swiftc");
    }
    return { status: "skipped", reason: "swiftc-unavailable" };
  }
  const swiftArchitecture =
    process.arch === "arm64"
      ? "arm64"
      : process.arch === "x64"
      ? "x86_64"
      : undefined;
  if (!swiftArchitecture) {
    if (options.requireMetalRuntime) {
      fail(`unsupported Swift target architecture ${process.arch}`);
    }
    return { status: "skipped", reason: "unsupported-host-architecture" };
  }
  const swiftTarget = `${swiftArchitecture}-apple-macosx14.0`;
  const executable = join(scratch, "c1-vertex-buffer-slots");
  const compilation = runCommand("xcrun", [
    "swiftc",
    "-O",
    "-target",
    swiftTarget,
    join(spikeDirectory, "prototype/main.swift"),
    "-framework",
    "Foundation",
    "-framework",
    "Metal",
    "-o",
    executable,
  ]);
  if (compilation.error || compilation.signal || compilation.status !== 0) {
    commandFailure("Swift prototype compilation", compilation);
  }
  const sourcePaths = metalSources.map((source) =>
    join(fixturesDirectory, source)
  );
  const inputs = metalRuntimeInputs(projection);
  const runtimeArguments = [
    ...sourcePaths,
    String(inputs.switchAStream),
    String(inputs.switchBStream),
    String(inputs.exactStreamStart),
    String(inputs.immediateIndex),
  ];
  const attempts = [0, 1].map(() => runCommand(executable, runtimeArguments));
  const parsed = attempts.map((attempt, index) => {
    if (attempt.error || attempt.signal || attempt.status !== 0) {
      commandFailure(`Metal runtime attempt ${index + 1}`, attempt);
    }
    try {
      return JSON.parse(attempt.stdout);
    } catch {
      fail(`Metal runtime attempt ${index + 1} returned invalid JSON`);
    }
  });
  if (!isDeepStrictEqual(parsed[0], parsed[1])) {
    fail("Metal runtime result is not deterministic");
  }
  if (parsed[0]?.status === "skipped") {
    exactKeys(
      parsed[0],
      ["schemaVersion", "status", "reason"],
      "Metal runtime skipped result"
    );
    if (options.requireMetalRuntime) {
      fail(`Metal runtime is required but skipped: ${parsed[0].reason}`);
    }
    return { ...parsed[0], swiftTarget };
  }
  validateMetalRuntimeResult(parsed[0], inputs);
  return { ...parsed[0], swiftTarget };
}

function runOfflineMetal(options, scratch) {
  if (process.platform !== "darwin") {
    if (options.requireOfflineMetal) {
      fail("offline Metal is required but the host is not macOS");
    }
    return { status: "skipped", reason: "non-macos-host" };
  }
  const missingTools = ["metal", "metallib"].filter(
    (tool) => !availableXcrunTool(tool)
  );
  if (missingTools.length > 0) {
    if (options.requireOfflineMetal) {
      fail(
        `offline Metal is required but xcrun cannot find ${missingTools.join(
          ", "
        )}`
      );
    }
    return {
      status: "skipped",
      reason: "offline-metal-toolchain-unavailable",
      missingTools,
    };
  }
  const compiled = [];
  for (const sourceName of metalSources) {
    const source = join(fixturesDirectory, sourceName);
    if (!existsSync(source)) fail(`missing Metal fixture ${sourceName}`);
    const stem = basename(sourceName, ".metal");
    const air = join(scratch, `${stem}.air`);
    const metallib = join(scratch, `${stem}.metallib`);
    const compilation = runCommand("xcrun", [
      "-sdk",
      "macosx",
      "metal",
      "-std=metal2.4",
      "-mmacosx-version-min=14.0",
      "-c",
      source,
      "-o",
      air,
    ]);
    if (compilation.error || compilation.signal || compilation.status !== 0) {
      commandFailure(`offline compilation of ${sourceName}`, compilation);
    }
    const link = runCommand("xcrun", [
      "-sdk",
      "macosx",
      "metallib",
      air,
      "-o",
      metallib,
    ]);
    if (link.error || link.signal || link.status !== 0) {
      commandFailure(`offline link of ${sourceName}`, link);
    }
    compiled.push(sourceName);
  }
  return {
    status: "passed",
    compiler: "xcrun metal + metallib",
    languageVersion: "2.4",
    deploymentTarget: "macOS 14.0",
    compiled,
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  for (const source of metalSources) {
    if (!existsSync(join(fixturesDirectory, source))) {
      fail(`missing Metal fixture ${source}`);
    }
  }
  const fixtures = readJSON(join(fixturesDirectory, "cases.json"));
  const mutations = readJSON(join(fixturesDirectory, "mutations.json"));
  const expected = readJSON(join(spikeDirectory, "snapshots/expected.json"));
  const metalFixtureGuard = validateExactCapacitySource();
  const allocator = runAllocator(fixtures, mutations, expected);

  const scratch = mkdtempSync(join(tmpdir(), "c1-vertex-buffer-slots-"));
  try {
    const metalRuntime = runMetalRuntime(
      options,
      scratch,
      allocator.projection
    );
    const offlineMetal = runOfflineMetal(options, scratch);
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "passed",
          candidate: candidateId,
          metalFixtureGuard,
          allocator: allocator.summary,
          metalRuntime,
          offlineMetal,
        },
        null,
        2
      )}\n`
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
}
