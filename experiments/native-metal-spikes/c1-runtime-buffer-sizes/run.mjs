#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  allocateStorageBufferSizeTables,
  STORAGE_BUFFER_SIZE_MODEL,
  StorageBufferSizeAllocationError,
} from "./lib/allocate.mjs";
import {
  StorageBufferSizeVerificationError,
  verifyStorageBufferSizeTables,
} from "./lib/verify.mjs";

const spikeDirectory = dirname(fileURLToPath(import.meta.url));
const fixturesDirectory = join(spikeDirectory, "fixtures");
const expectedTintCommit = "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca";
const emittedEntryPoint = "vgpu_multi_runtime_cross_row";
const metalTarget = "air64-apple-macos14.0";

function fail(message) {
  throw new Error(`C1 runtime buffer sizes: ${message}`);
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
    releaseRoot: process.env.C1_SIZE_TABLE_TINT_RELEASE_ROOT,
    compatInclude: process.env.C1_SIZE_TABLE_TINT_COMPAT_INCLUDE,
    requireTint: process.env.C1_SIZE_TABLE_REQUIRE_TINT === "1",
    skipMetalRuntime: process.env.C1_SIZE_TABLE_SKIP_METAL_RUNTIME === "1",
    requireMetalRuntime:
      process.env.C1_SIZE_TABLE_REQUIRE_METAL_RUNTIME === "1",
    requireOfflineMetal:
      process.env.C1_SIZE_TABLE_REQUIRE_OFFLINE_METAL === "1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: node run.mjs [--release-root <Dawn release>] " +
          "[--compat-include <header overlay>] [--require-tint] " +
          "[--skip-metal-runtime] [--require-metal-runtime] " +
          "[--require-offline-metal]\n"
      );
      process.exit(0);
    }
    if (argument === "--require-tint") {
      options.requireTint = true;
      continue;
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
  if (options.skipMetalRuntime && options.requireMetalRuntime) {
    fail("--skip-metal-runtime conflicts with --require-metal-runtime");
  }
  if (options.requireMetalRuntime || options.requireOfflineMetal) {
    options.requireTint = true;
  }
  return options;
}

function fixtureInput(fixtures) {
  return {
    model: fixtures.model,
    profile: clone(fixtures.profile),
    programs: clone(fixtures.programs),
  };
}

function permuteInput(input) {
  const permuted = clone(input);
  permuted.programs.reverse();
  for (const program of permuted.programs) {
    program.buffers.reverse();
    program.internalBindings.reverse();
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

function applyMutation(root, operation, mutationId) {
  const operationId = `${mutationId}/${operation.op}`;
  if (operation.op === "set") {
    exactKeys(operation, ["op", "path", "value"], operationId);
    const { target, key } = resolveMutationTarget(
      root,
      operation.path,
      operationId
    );
    target[key] = clone(operation.value);
    return;
  }
  if (operation.op === "append") {
    exactKeys(operation, ["op", "path", "value"], operationId);
    const { target, key } = resolveMutationTarget(
      root,
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
      root,
      operation.path,
      operationId
    );
    if (!Array.isArray(target[key])) {
      fail(`${operationId} target is not an array`);
    }
    target[key].reverse();
    return;
  }
  if (operation.op === "remove-last") {
    exactKeys(operation, ["op", "path"], operationId);
    const { target, key } = resolveMutationTarget(
      root,
      operation.path,
      operationId
    );
    if (!Array.isArray(target[key]) || target[key].length === 0) {
      fail(`${operationId} target is not a non-empty array`);
    }
    target[key].pop();
    return;
  }
  fail(`${mutationId} uses unsupported operation ${operation.op}`);
}

function expectAllocationError(input, expected, mutationId) {
  try {
    allocateStorageBufferSizeTables(input);
  } catch (error) {
    if (!(error instanceof StorageBufferSizeAllocationError)) throw error;
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

function expectVerificationError(input, projection, expected, mutationId) {
  try {
    verifyStorageBufferSizeTables(input, projection);
  } catch (error) {
    if (!(error instanceof StorageBufferSizeVerificationError)) throw error;
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
  fail(`${mutationId} escaped the independent verifier`);
}

function namedProgram(programs, id, owner) {
  const result = programs.find((program) => program.id === id);
  if (!result) fail(`${owner} omitted ${id}`);
  return result;
}

function verifyFixtureCoverage(input, projection) {
  const source = namedProgram(
    input.programs,
    "MultiRuntimeCrossRow",
    "fixture"
  );
  const projected = namedProgram(
    projection.programs,
    "MultiRuntimeCrossRow",
    "projection"
  );
  const storage = source.buffers.filter((buffer) => buffer.kind === "storage");
  const runtime = storage.filter((buffer) => buffer.runtimeSized);
  const fixed = storage.filter((buffer) => !buffer.runtimeSized);
  if (
    runtime.length !== 5 ||
    fixed.length !== 1 ||
    fixed[0].index !== 1 ||
    fixed[0].rangeBytes !== 40 ||
    fixed[0].minimumBindingSize !== 40 ||
    !isDeepStrictEqual(
      runtime
        .map((buffer) => [buffer.semanticBinding, buffer.minimumBindingSize])
        .sort((left, right) => compareText(left[0], right[0])),
      [
        ["g0b0", 16],
        ["g0b7", 16],
        ["g1b4", 24],
        ["g2b9", 4],
        ["g3b1", 32],
      ]
    ) ||
    !isDeepStrictEqual(
      storage.map((buffer) => buffer.index).sort((left, right) => left - right),
      [0, 1, 2, 3, 4, 5]
    )
  ) {
    fail(
      "multi-runtime fixture lost five runtime arrays or its interleaved fixed buffer"
    );
  }
  if (
    !projected.storageBufferSizes ||
    projected.storageBufferSizes.wordCount !== 6 ||
    projected.storageBufferSizes.payloadByteLength !== 24 ||
    projected.storageBufferSizes.byteOffset !== 4 ||
    projected.storageBufferSizes.uploadWordCount !== 8 ||
    projected.storageBufferSizes.uploadByteLength !== 32 ||
    !isDeepStrictEqual(
      projected.storageBufferSizes.words,
      [32, 0, 32, 36, 20, 112]
    ) ||
    !isDeepStrictEqual(
      projected.storageBufferSizes.uploadWords,
      [0, 32, 0, 32, 36, 20, 112, 0]
    ) ||
    projected.storageBufferSizes.entries.some(
      (entry) => entry.sizeWordIndex !== entry.metalBufferIndex
    )
  ) {
    fail(
      "multi-runtime projection no longer crosses uint4 with Metal-slot word indices"
    );
  }

  const sparseSource = namedProgram(
    input.programs,
    "SparseVertexStage",
    "fixture"
  );
  const sparse = namedProgram(
    projection.programs,
    "SparseVertexStage",
    "projection"
  );
  if (
    sparseSource.buffers.find((buffer) => buffer.kind === "uniform")?.index !==
      11 ||
    !sparse.storageBufferSizes ||
    sparse.storageBufferSizes.wordCount !== 29 ||
    sparse.storageBufferSizes.payloadByteLength !== 116 ||
    sparse.storageBufferSizes.byteOffset !== 4 ||
    sparse.storageBufferSizes.uploadWordCount !== 32 ||
    sparse.storageBufferSizes.uploadByteLength !== 128 ||
    sparse.storageBufferSizes.words[0] !== 16 ||
    sparse.storageBufferSizes.words[11] !== 0 ||
    sparse.storageBufferSizes.words[28] !== 48 ||
    sparse.storageBufferSizes.uploadWords[1] !== 16 ||
    sparse.storageBufferSizes.uploadWords[29] !== 48
  ) {
    fail(
      "sparse fixture no longer preserves storage slots 0/28 and uniform hole 11"
    );
  }
  const noRuntime = namedProgram(
    projection.programs,
    "NoRuntimeTable",
    "projection"
  );
  if (
    noRuntime.storageBufferSizes !== null ||
    noRuntime.internalBindings[0]?.role !== "immediate-data"
  ) {
    fail("fixed-only program unexpectedly allocated a storage-size table");
  }

  const noSizeQuerySource = namedProgram(
    input.programs,
    "RuntimeTypeNoSizeQuery",
    "fixture"
  );
  const noSizeQuery = namedProgram(
    projection.programs,
    "RuntimeTypeNoSizeQuery",
    "projection"
  );
  const unusedRuntimeBuffer = noSizeQuerySource.buffers.find(
    (buffer) => buffer.kind === "storage" && buffer.runtimeSized
  );
  if (
    noSizeQuerySource.needsStorageBufferSizes !== false ||
    unusedRuntimeBuffer?.index !== 7 ||
    unusedRuntimeBuffer.minimumBindingSize !== 8 ||
    noSizeQuery.storageBufferSizes !== null ||
    noSizeQuery.internalBindings.length !== 0
  ) {
    fail("runtime storage type incorrectly implied a storage-size table");
  }

  const upperSource = namedProgram(
    input.programs,
    "UpperNonRuntimeSlots",
    "fixture"
  );
  const upper = namedProgram(
    projection.programs,
    "UpperNonRuntimeSlots",
    "projection"
  );
  if (
    upperSource.buffers.find(
      (buffer) => buffer.kind === "storage" && !buffer.runtimeSized
    )?.index !== 28 ||
    upperSource.buffers.find((buffer) => buffer.kind === "uniform")?.index !==
      29 ||
    !upper.storageBufferSizes ||
    upper.storageBufferSizes.wordCount !== 3 ||
    !isDeepStrictEqual(upper.storageBufferSizes.words, [0, 0, 16]) ||
    upper.storageBufferSizes.entries.length !== 1 ||
    upper.storageBufferSizes.entries[0].sizeWordIndex !== 2
  ) {
    fail("fixed and uniform slots above runtime storage extended its table");
  }
}

function runAllocator(fixtures, mutationFixture, expectedSnapshot) {
  exactKeys(
    fixtures,
    ["schemaVersion", "model", "profile", "programs"],
    "fixtures/cases.json"
  );
  exactKeys(
    mutationFixture,
    [
      "schemaVersion",
      "inputMutations",
      "sourceCorruptions",
      "projectionCorruptions",
    ],
    "fixtures/mutations.json"
  );
  exactKeys(
    expectedSnapshot,
    ["schemaVersion", "model", "projection"],
    "snapshots/expected.json"
  );
  if (
    fixtures.schemaVersion !== 1 ||
    mutationFixture.schemaVersion !== 1 ||
    expectedSnapshot.schemaVersion !== 1 ||
    fixtures.model !== STORAGE_BUFFER_SIZE_MODEL ||
    expectedSnapshot.model !== STORAGE_BUFFER_SIZE_MODEL
  ) {
    fail("fixture identity mismatch");
  }
  if (
    !Array.isArray(mutationFixture.inputMutations) ||
    !Array.isArray(mutationFixture.sourceCorruptions) ||
    !Array.isArray(mutationFixture.projectionCorruptions)
  ) {
    fail("mutation collections must be arrays");
  }

  const input = fixtureInput(fixtures);
  const pristineInput = clone(input);
  const first = allocateStorageBufferSizeTables(input);
  const second = allocateStorageBufferSizeTables(clone(input));
  const permutedInput = permuteInput(input);
  const permuted = allocateStorageBufferSizeTables(permutedInput);
  if (
    !isDeepStrictEqual(first, second) ||
    !isDeepStrictEqual(first, permuted) ||
    !isDeepStrictEqual(input, pristineInput)
  ) {
    fail("allocator is nondeterministic or mutated its input");
  }
  const pristineProjection = clone(first);
  verifyStorageBufferSizeTables(input, first);
  if (
    !isDeepStrictEqual(input, pristineInput) ||
    !isDeepStrictEqual(first, pristineProjection)
  ) {
    fail("independent verifier mutated its input or projection");
  }
  verifyFixtureCoverage(input, first);

  const actualSnapshot = {
    schemaVersion: 1,
    model: STORAGE_BUFFER_SIZE_MODEL,
    projection: first,
  };
  if (!isDeepStrictEqual(actualSnapshot, expectedSnapshot)) {
    process.stderr.write(`${JSON.stringify(actualSnapshot, null, 2)}\n`);
    fail("allocator snapshot drifted");
  }

  for (const mutation of mutationFixture.inputMutations) {
    exactKeys(mutation, ["id", "operations", "expected"], "input mutation");
    if (
      typeof mutation.id !== "string" ||
      mutation.id.length === 0 ||
      !Array.isArray(mutation.operations)
    ) {
      fail("input mutation id or operations are invalid");
    }
    const mutated = clone(input);
    for (const operation of mutation.operations) {
      applyMutation(mutated, operation, mutation.id);
    }
    if (mutation.expected.status === "same-projection") {
      exactKeys(mutation.expected, ["status"], `${mutation.id}/expected`);
      const result = allocateStorageBufferSizeTables(mutated);
      verifyStorageBufferSizeTables(mutated, result);
      if (!isDeepStrictEqual(result, first)) {
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
    if (mutation.expected.status === "word") {
      exactKeys(
        mutation.expected,
        ["status", "program", "index", "value"],
        `${mutation.id}/expected`
      );
      const result = allocateStorageBufferSizeTables(mutated);
      verifyStorageBufferSizeTables(mutated, result);
      const program = namedProgram(
        result.programs,
        mutation.expected.program,
        mutation.id
      );
      if (
        program.storageBufferSizes?.words[mutation.expected.index] !==
        mutation.expected.value
      ) {
        fail(
          `${mutation.id} did not preserve the non-multiple array-stride range`
        );
      }
      continue;
    }
    fail(`${mutation.id} has an unknown expected status`);
  }

  for (const corruption of mutationFixture.sourceCorruptions) {
    exactKeys(
      corruption,
      ["id", "operations", "expected"],
      "source corruption"
    );
    exactKeys(
      corruption.expected,
      ["code", "messageIncludes"],
      `${corruption.id}/expected`
    );
    const corrupted = clone(input);
    for (const operation of corruption.operations) {
      applyMutation(corrupted, operation, corruption.id);
    }
    expectVerificationError(
      corrupted,
      first,
      corruption.expected,
      corruption.id
    );
  }

  for (const corruption of mutationFixture.projectionCorruptions) {
    exactKeys(
      corruption,
      ["id", "operations", "expected"],
      "projection corruption"
    );
    exactKeys(
      corruption.expected,
      ["code", "messageIncludes"],
      `${corruption.id}/expected`
    );
    const corrupted = clone(first);
    for (const operation of corruption.operations) {
      applyMutation(corrupted, operation, corruption.id);
    }
    expectVerificationError(
      input,
      corrupted,
      corruption.expected,
      corruption.id
    );
  }

  return {
    input,
    projection: first,
    summary: {
      status: "passed",
      programs: input.programs.length,
      runtimeArraysInCrossRowCase: 5,
      deterministicRuns: 2,
      reorderedInputs: 1,
      inputMutations: mutationFixture.inputMutations.length,
      verifierMutations:
        mutationFixture.sourceCorruptions.length +
        mutationFixture.projectionCorruptions.length,
      purityChecks: 2,
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

function commandFailure(owner, result) {
  const diagnostic = `${result.stdout}${result.stderr}`.trim();
  const suffix = diagnostic ? `: ${diagnostic}` : "";
  fail(
    `${owner} failed with ${
      result.signal ? `signal ${result.signal}` : `status ${result.status}`
    }${suffix}`
  );
}

function availableXcrunTool(tool) {
  const result = runCommand("xcrun", ["--find", tool]);
  return (
    !result.error && result.status === 0 && result.stdout.trim().length > 0
  );
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function compileTintWrapper(releaseRoot, compatInclude, scratch) {
  const provenance = readJSON(
    join(spikeDirectory, "..", "c1-tint-standalone", "provenance/releases.json")
  );
  const release = provenance.releases?.find(
    (candidate) => candidate.commit === expectedTintCommit
  );
  const expectedLibraryHash = release?.files?.["lib/libwebgpu_dawn.a"]?.sha256;
  const expectedCompilerHeaderHash = provenance.supplementalSource?.sha256;
  if (!expectedLibraryHash || !expectedCompilerHeaderHash) {
    fail("pinned Dawn provenance is incomplete");
  }
  const includeRoot = join(releaseRoot, "include");
  const tintInclude = join(includeRoot, "src/tint");
  const library = join(releaseRoot, "lib/libwebgpu_dawn.a");
  if (!existsSync(tintInclude) || !existsSync(library)) {
    fail("release root lacks Tint headers or libwebgpu_dawn.a");
  }
  if (sha256(library) !== expectedLibraryHash) {
    fail(`libwebgpu_dawn.a does not match pinned Dawn ${expectedTintCommit}`);
  }
  const bundledCompilerHeader = join(includeRoot, "src/utils/compiler.h");
  const compilerHeader = compatInclude
    ? join(compatInclude, "src/utils/compiler.h")
    : bundledCompilerHeader;
  if (!existsSync(compilerHeader)) {
    fail(
      "official release needs --compat-include with its exact missing header overlay"
    );
  }
  if (sha256(compilerHeader) !== expectedCompilerHeaderHash) {
    fail(`compiler.h does not match pinned Dawn ${expectedTintCommit}`);
  }

  const source = join(spikeDirectory, "prototype/main.cc");
  const sourceText = readFileSync(source, "utf8");
  if (
    sourceText.includes("tint::GenerateBindings") ||
    sourceText.includes("api/helpers/generate_bindings")
  ) {
    fail("prototype must not call or include GenerateBindings");
  }
  if (
    (sourceText.match(/array_lengths\.ubo_binding/g)?.length ?? 0) !== 1 ||
    !sourceText.includes('if (arguments.transport == "ubo")') ||
    !sourceText.includes(
      "array_lengths.buffer_sizes_offset = arguments.buffer_sizes_offset"
    ) ||
    !sourceText.includes("writer_options.immediate_binding_point")
  ) {
    fail(
      "prototype did not isolate legacy UBO use from the immediate candidate"
    );
  }
  const wrapper = join(scratch, "vgpu-tint-runtime-buffer-sizes");
  const args = [
    "clang++",
    "-std=c++20",
    "-O2",
    source,
    ...(compatInclude ? [`-I${compatInclude}`] : []),
    `-I${tintInclude}`,
    `-I${includeRoot}`,
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
    wrapper,
  ];
  const compilation = runCommand("xcrun", args);
  if (compilation.error || compilation.signal || compilation.status !== 0) {
    commandFailure("Tint wrapper compilation", compilation);
  }
  return wrapper;
}

function mappingForProgram(input, projection) {
  const source = namedProgram(
    input.programs,
    "MultiRuntimeCrossRow",
    "fixture"
  );
  const projected = namedProgram(
    projection.programs,
    "MultiRuntimeCrossRow",
    "projection"
  );
  const entries = new Map(
    projected.storageBufferSizes.entries.map((entry) => [
      entry.semanticBinding,
      entry,
    ])
  );
  return source.buffers
    .map((buffer) => {
      const match = /^g(\d+)b(\d+)$/.exec(buffer.semanticBinding);
      const projectedEntry = entries.get(buffer.semanticBinding);
      if (
        !match ||
        (buffer.runtimeSized &&
          (!projectedEntry ||
            projectedEntry.metalBufferIndex !== buffer.index ||
            projectedEntry.sizeWordIndex !== buffer.index)) ||
        (!buffer.runtimeSized && projectedEntry)
      ) {
        fail(`cannot map ${buffer.semanticBinding} into Tint`);
      }
      return {
        kind: buffer.kind,
        group: Number(match[1]),
        binding: Number(match[2]),
        metalIndex: buffer.index,
        count: buffer.count,
        runtimeSized: buffer.runtimeSized,
      };
    })
    .sort(
      (left, right) =>
        left.group - right.group ||
        left.binding - right.binding ||
        compareText(left.kind, right.kind)
    );
}

function writeMapping(path, mappings) {
  writeFileSync(
    path,
    `${mappings
      .map(
        (mapping) =>
          `${mapping.kind} ${mapping.group} ${mapping.binding} ${mapping.metalIndex} ${mapping.count}`
      )
      .join("\n")}\n`
  );
}

function invokeWrapper(wrapper, mappingPath, outputPath, options = {}) {
  return runCommand(wrapper, [
    join(
      spikeDirectory,
      "canaries",
      options.source ?? "multiple-runtime-storage.wgsl"
    ),
    options.entryPoint ?? "main",
    options.emittedEntryPoint ?? emittedEntryPoint,
    outputPath,
    mappingPath,
    "30",
    "30",
    options.transport ?? "immediate",
    String(options.transport === "ubo" ? 0 : 4),
  ]);
}

function runStageLocalTint(wrapper, scratch, transport) {
  const cases = [
    {
      stage: "vertex",
      entryPoint: "vertexMain",
      emittedEntryPoint: "vgpu_stage_local_vertex",
      metalIndex: 0,
      rowCount: 1,
      componentRead: "[0u].x",
    },
    {
      stage: "fragment",
      entryPoint: "fragmentMain",
      emittedEntryPoint: "vgpu_stage_local_fragment",
      metalIndex: 5,
      rowCount: 2,
      componentRead: "[1u].y",
    },
  ];
  const generatedMSL = {};
  for (const testCase of cases) {
    const mapping = [
      {
        kind: "storage",
        group: 4,
        binding: 2,
        metalIndex: testCase.metalIndex,
        count: 1,
        runtimeSized: true,
      },
    ];
    const mappingPath = join(scratch, `stage-local-${testCase.stage}.map`);
    writeMapping(mappingPath, mapping);
    const options = {
      source: "stage-local-runtime-storage.wgsl",
      entryPoint: testCase.entryPoint,
      emittedEntryPoint: testCase.emittedEntryPoint,
      transport,
    };
    const attempts = ["first", "second"].map((suffix) => {
      const outputPath = join(
        scratch,
        `stage-local-${transport}-${testCase.stage}-${suffix}.metal`
      );
      const process = invokeWrapper(wrapper, mappingPath, outputPath, options);
      return {
        ...process,
        outputPath,
        msl: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
      };
    });
    for (const attempt of attempts) {
      if (
        attempt.error ||
        attempt.signal ||
        attempt.status !== 0 ||
        attempt.msl.length === 0
      ) {
        commandFailure(`stage-local ${testCase.stage} Tint canary`, attempt);
      }
    }
    if (
      attempts[0].stdout !== attempts[1].stdout ||
      attempts[0].msl !== attempts[1].msl
    ) {
      fail(`stage-local ${testCase.stage} Tint output is not deterministic`);
    }
    const response = JSON.parse(attempts[0].stdout);
    if (
      response.stage !== testCase.stage ||
      response.entryPoint !== testCase.entryPoint ||
      response.emittedEntryPoint !== testCase.emittedEntryPoint ||
      response.storageBufferSizesIndex !== 30 ||
      response.transport !== transport ||
      response.bufferSizesOffset !== (transport === "immediate" ? 4 : null) ||
      response.wordCount !== testCase.metalIndex + 1 ||
      response.payloadByteLength !== (testCase.metalIndex + 1) * 4 ||
      response.shaderTableByteLength !==
        (transport === "immediate"
          ? (testCase.metalIndex + 1) * 4
          : testCase.rowCount * 16) ||
      response.uploadByteLength !== testCase.rowCount * 16 ||
      !isDeepStrictEqual(response.postLoweringBufferIndices, [
        testCase.metalIndex,
        30,
      ]) ||
      !isDeepStrictEqual(response.bindings, [
        {
          kind: "storage",
          group: 4,
          binding: 2,
          metalIndex: testCase.metalIndex,
          sizeWordIndex: testCase.metalIndex,
        },
      ])
    ) {
      fail(`stage-local ${testCase.stage} projection drifted`);
    }
    if (
      !attempts[0].msl.includes(`[[buffer(${testCase.metalIndex})]]`) ||
      !attempts[0].msl.includes("[[buffer(30)]]") ||
      (transport === "ubo" &&
        (!attempts[0].msl.includes(testCase.componentRead) ||
          !new RegExp(`tint_array<uint4,\\s*${testCase.rowCount}>`).test(
            attempts[0].msl
          ))) ||
      (transport === "immediate" &&
        !new RegExp(`tint_array<uint,\\s*${testCase.metalIndex + 1}>`).test(
          attempts[0].msl
        ))
    ) {
      fail(`stage-local ${testCase.stage} MSL size-word access drifted`);
    }
    if (
      testCase.stage === "vertex" &&
      (!attempts[0].msl.includes("[[stage_in]]") ||
        !attempts[0].msl.includes("[[attribute(0)]]"))
    ) {
      fail("stage-local vertex MSL omitted the consumed vertex attribute");
    }
    generatedMSL[testCase.stage] = attempts[0].outputPath;
  }
  return {
    generatedMSL,
    transport,
    entries: cases.length,
    deterministicRunsPerEntry: 2,
    physicalIndices: Object.fromEntries(
      cases.map((testCase) => [testCase.stage, testCase.metalIndex])
    ),
  };
}

function generateTintCanary(
  wrapper,
  scratch,
  { id, owner, mappings, source, entryPoint, emittedEntryPoint, transport }
) {
  const mappingPath = join(scratch, `${id}-${transport}.map`);
  writeMapping(mappingPath, mappings);
  const attempts = ["first", "second"].map((suffix) => {
    const outputPath = join(scratch, `${id}-${transport}-${suffix}.metal`);
    const process = invokeWrapper(wrapper, mappingPath, outputPath, {
      source,
      entryPoint,
      emittedEntryPoint,
      transport,
    });
    return {
      ...process,
      msl: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
    };
  });
  for (const attempt of attempts) {
    if (
      attempt.error ||
      attempt.signal ||
      attempt.status !== 0 ||
      attempt.msl.length === 0
    ) {
      commandFailure(`${owner} Tint canary`, attempt);
    }
  }
  if (
    attempts[0].stdout !== attempts[1].stdout ||
    attempts[0].msl !== attempts[1].msl
  ) {
    fail(`${owner} Tint output is not deterministic`);
  }
  return {
    msl: attempts[0].msl,
    response: JSON.parse(attempts[0].stdout),
  };
}

function runNoSizeQueryTint(wrapper, scratch, transport) {
  const emittedEntryPoint = "vgpu_runtime_type_no_size_query";
  const mappings = [
    {
      kind: "storage",
      group: 0,
      binding: 0,
      metalIndex: 7,
      count: 1,
      runtimeSized: true,
    },
    {
      kind: "storage",
      group: 0,
      binding: 1,
      metalIndex: 1,
      count: 1,
      runtimeSized: false,
    },
  ];
  const { response, msl } = generateTintCanary(wrapper, scratch, {
    id: "no-size-query",
    owner: "runtime type without size query",
    mappings,
    source: "runtime-storage-fixed-prefix.wgsl",
    entryPoint: "fixedPrefixOnly",
    emittedEntryPoint,
    transport,
  });
  if (
    response.entryPoint !== "fixedPrefixOnly" ||
    response.emittedEntryPoint !== emittedEntryPoint ||
    response.stage !== "compute" ||
    response.needsStorageBufferSizes !== false ||
    response.transport !== transport ||
    response.storageBufferSizesIndex !== 30 ||
    response.bufferSizesOffset !== (transport === "immediate" ? 4 : null) ||
    response.wordCount !== 8 ||
    !isDeepStrictEqual(response.postLoweringBufferIndices, [1, 7]) ||
    !isDeepStrictEqual(
      response.bindings,
      mappings.map((mapping) => ({
        kind: mapping.kind,
        group: mapping.group,
        binding: mapping.binding,
        metalIndex: mapping.metalIndex,
        sizeWordIndex: null,
      }))
    )
  ) {
    fail("runtime type without size query disagrees with Tint metadata");
  }
  if (
    !msl.includes(emittedEntryPoint) ||
    !msl.includes("[[buffer(7)]]") ||
    !msl.includes("[[buffer(1)]]") ||
    msl.includes("[[buffer(30)]]") ||
    msl.includes("tint_storage_buffer_sizes") ||
    msl.includes("tint_immediate_data")
  ) {
    fail("runtime type without size query emitted the internal size transport");
  }
  return {
    status: "passed",
    deterministicRuns: 2,
    reflectedBindings: mappings.length,
    runtimeSizedBindings: mappings.filter((mapping) => mapping.runtimeSized)
      .length,
    needsStorageBufferSizes: response.needsStorageBufferSizes,
    postLoweringBufferIndices: response.postLoweringBufferIndices,
  };
}

function runMixedSizeQueryTint(wrapper, scratch, transport) {
  const emittedEntryPoint = "vgpu_mixed_size_query";
  const mappings = [
    {
      kind: "storage",
      group: 0,
      binding: 0,
      metalIndex: 7,
      count: 1,
      runtimeSized: true,
    },
    {
      kind: "storage",
      group: 0,
      binding: 1,
      metalIndex: 1,
      count: 1,
      runtimeSized: false,
    },
    {
      kind: "storage",
      group: 0,
      binding: 2,
      metalIndex: 0,
      count: 1,
      runtimeSized: true,
    },
  ];
  const { response, msl } = generateTintCanary(wrapper, scratch, {
    id: "mixed-size-query",
    owner: "mixed runtime size query",
    mappings,
    source: "runtime-storage-fixed-prefix.wgsl",
    entryPoint: "mixedSizeQuery",
    emittedEntryPoint,
    transport,
  });
  const expectedBindings = mappings.map((mapping) => ({
    kind: mapping.kind,
    group: mapping.group,
    binding: mapping.binding,
    metalIndex: mapping.metalIndex,
    sizeWordIndex: mapping.runtimeSized ? mapping.metalIndex : null,
  }));
  if (
    response.entryPoint !== "mixedSizeQuery" ||
    response.emittedEntryPoint !== emittedEntryPoint ||
    response.stage !== "compute" ||
    response.needsStorageBufferSizes !== true ||
    response.transport !== transport ||
    response.storageBufferSizesIndex !== 30 ||
    response.bufferSizesOffset !== (transport === "immediate" ? 4 : null) ||
    response.wordCount !== 8 ||
    response.payloadByteLength !== 32 ||
    response.shaderTableByteLength !== 32 ||
    response.uploadByteLength !== (transport === "immediate" ? 48 : 32) ||
    !isDeepStrictEqual(response.postLoweringBufferIndices, [0, 1, 7, 30]) ||
    !isDeepStrictEqual(response.bindings, expectedBindings)
  ) {
    fail("mixed runtime size query disagrees with configured-map extent");
  }

  const hasExpectedTableType =
    transport === "immediate"
      ? /tint_array<uint,\s*8>\s+tint_storage_buffer_sizes/.test(msl)
      : /tint_array<uint4,\s*2>/.test(msl);
  const readsLowSizeWord =
    transport === "immediate"
      ? msl.includes("tint_storage_buffer_sizes[0u]")
      : msl.includes("[0u].x");
  const readsHighSizeWord =
    transport === "immediate"
      ? msl.includes("tint_storage_buffer_sizes[7u]")
      : msl.includes("[1u].w");
  if (
    !msl.includes(emittedEntryPoint) ||
    !msl.includes("[[buffer(0)]]") ||
    !msl.includes("[[buffer(1)]]") ||
    !msl.includes("[[buffer(7)]]") ||
    !msl.includes("[[buffer(30)]]") ||
    !hasExpectedTableType ||
    !readsLowSizeWord ||
    readsHighSizeWord
  ) {
    fail("mixed runtime size query MSL did not preserve sparse map extent");
  }
  return {
    status: "passed",
    deterministicRuns: 2,
    runtimeSizedBindings: mappings.filter((mapping) => mapping.runtimeSized)
      .length,
    queriedSizeWordIndices: [0],
    configuredSizeWordIndices: [0, 7],
    wordCount: response.wordCount,
  };
}

function normalizeDiagnostic(value, scratch) {
  return value
    .replaceAll(spikeDirectory, "<spike-dir>")
    .replaceAll(scratch, "<scratch>")
    .replaceAll("\\", "/")
    .trim();
}

function expectWrapperFailure(wrapper, mapping, expected, id, scratch) {
  const mappingPath = join(scratch, `negative-${id}.map`);
  const outputPath = join(scratch, `negative-${id}.metal`);
  writeMapping(mappingPath, mapping);
  const first = invokeWrapper(wrapper, mappingPath, outputPath);
  const second = invokeWrapper(wrapper, mappingPath, outputPath);
  const firstDiagnostic = normalizeDiagnostic(
    `${first.stdout}${first.stderr}`,
    scratch
  );
  const secondDiagnostic = normalizeDiagnostic(
    `${second.stdout}${second.stderr}`,
    scratch
  );
  if (
    first.error ||
    second.error ||
    first.status === 0 ||
    second.status === 0 ||
    first.status !== second.status ||
    firstDiagnostic !== secondDiagnostic ||
    !firstDiagnostic.includes(expected)
  ) {
    fail(`${id} wrapper negative was not deterministic: ${firstDiagnostic}`);
  }
}

function verifyGeneratedMSL(msl, mappings, transport) {
  if (!msl.includes(emittedEntryPoint)) {
    fail("generated MSL omitted the remapped compute entry point");
  }
  for (const mapping of mappings) {
    if (!msl.includes(`[[buffer(${mapping.metalIndex})]]`)) {
      fail(`generated MSL omitted buffer(${mapping.metalIndex})`);
    }
  }
  if (!msl.includes("[[buffer(30)]]")) {
    fail("generated MSL omitted storage-buffer-sizes at buffer(30)");
  }
  if (transport === "ubo") {
    if (!/tint_array<uint4,\s*2>/.test(msl)) {
      fail("UBO MSL did not materialize two uint4 size-table rows");
    }
    const componentReads = ["[0u].x", "[0u].z", "[0u].w", "[1u].x", "[1u].y"];
    for (const read of componentReads) {
      if (!msl.includes(read)) {
        fail(`UBO MSL omitted size-table component ${read}`);
      }
    }
  } else {
    if (!/tint_array<uint,\s*6>/.test(msl)) {
      fail("immediate MSL did not materialize six slot-indexed size words");
    }
    for (const index of [0, 2, 3, 4, 5]) {
      if (!msl.includes(`[${index}u]`)) {
        fail(`immediate MSL omitted size-table word ${index}`);
      }
    }
  }
}

function runTintTransport(wrapper, allocatorResult, scratch, transport) {
  const mappings = mappingForProgram(
    allocatorResult.input,
    allocatorResult.projection
  );
  const mappingPath = join(scratch, `multi-runtime-${transport}.map`);
  writeMapping(mappingPath, mappings);
  const attempts = ["first", "second"].map((suffix) => {
    const outputPath = join(
      scratch,
      `multi-runtime-${transport}-${suffix}.metal`
    );
    const process = invokeWrapper(wrapper, mappingPath, outputPath, {
      transport,
    });
    return {
      ...process,
      outputPath,
      msl: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
    };
  });
  for (const attempt of attempts) {
    if (
      attempt.error ||
      attempt.signal ||
      attempt.status !== 0 ||
      attempt.msl.length === 0
    ) {
      commandFailure("Tint wrapper execution", attempt);
    }
  }
  if (
    attempts[0].stdout !== attempts[1].stdout ||
    attempts[0].msl !== attempts[1].msl
  ) {
    fail("Tint wrapper output is not deterministic");
  }
  const response = JSON.parse(attempts[0].stdout);
  const expectedBindings = mappings.map((mapping) => ({
    kind: mapping.kind,
    group: mapping.group,
    binding: mapping.binding,
    metalIndex: mapping.metalIndex,
    sizeWordIndex: mapping.runtimeSized ? mapping.metalIndex : null,
  }));
  if (
    response.entryPoint !== "main" ||
    response.emittedEntryPoint !== emittedEntryPoint ||
    response.stage !== "compute" ||
    response.needsStorageBufferSizes !== true ||
    response.transport !== transport ||
    response.storageBufferSizesIndex !== 30 ||
    response.bufferSizesOffset !== (transport === "immediate" ? 4 : null) ||
    response.wordCount !== 6 ||
    response.payloadByteLength !== 24 ||
    response.shaderTableByteLength !== (transport === "immediate" ? 24 : 32) ||
    response.uploadByteLength !== 32 ||
    !isDeepStrictEqual(
      response.postLoweringBufferIndices,
      [0, 1, 2, 3, 4, 5, 30]
    ) ||
    !isDeepStrictEqual(response.bindings, expectedBindings)
  ) {
    fail("Tint wrapper returned a projection different from the allocator");
  }
  verifyGeneratedMSL(attempts[0].msl, mappings, transport);
  const stageLocal = runStageLocalTint(wrapper, scratch, transport);
  const noSizeQuery = runNoSizeQueryTint(wrapper, scratch, transport);
  const mixedSizeQuery = runMixedSizeQueryTint(wrapper, scratch, transport);

  if (transport === "immediate") {
    const duplicateTarget = clone(mappings);
    duplicateTarget[1].metalIndex = duplicateTarget[0].metalIndex;
    const internalCollision = clone(mappings);
    internalCollision[0].metalIndex = 30;
    const missingBinding = clone(mappings).slice(0, -1);
    const wrongKind = clone(mappings);
    wrongKind[0].kind = "uniform";
    const externalCeiling = clone(mappings);
    externalCeiling[0].metalIndex = 31;
    const uint32Overflow = clone(mappings);
    uint32Overflow[0].metalIndex = 4_294_967_296;
    expectWrapperFailure(
      wrapper,
      duplicateTarget,
      "repeats a Metal buffer index",
      "duplicate-target",
      scratch
    );
    expectWrapperFailure(
      wrapper,
      internalCollision,
      "collides with storage-buffer-sizes slot",
      "internal-collision",
      scratch
    );
    expectWrapperFailure(
      wrapper,
      missingBinding,
      "mapping count differs",
      "missing-reflected-binding",
      scratch
    );
    expectWrapperFailure(
      wrapper,
      wrongKind,
      "mapping differs from selected-entry reflection",
      "wrong-resource-kind",
      scratch
    );
    expectWrapperFailure(
      wrapper,
      externalCeiling,
      "crosses external ceiling",
      "external-ceiling",
      scratch
    );
    expectWrapperFailure(
      wrapper,
      uint32Overflow,
      "invalid mapping line",
      "projected-index-u32-overflow",
      scratch
    );
  }

  return {
    generatedMSL: attempts[0].outputPath,
    stageLocalGeneratedMSL: stageLocal.generatedMSL,
    summary: {
      status: "passed",
      deterministicRuns: 2,
      reflectedBindings: mappings.length,
      negativeMappings: transport === "immediate" ? 6 : 0,
      transport,
      stageLocal,
      noSizeQuery,
      mixedSizeQuery,
      sizeWordIndices: response.bindings.map(
        (binding) => binding.sizeWordIndex
      ),
    },
  };
}

function runTint(wrapper, allocatorResult, scratch) {
  const candidate = runTintTransport(
    wrapper,
    allocatorResult,
    scratch,
    "immediate"
  );
  const legacy = runTintTransport(wrapper, allocatorResult, scratch, "ubo");
  return {
    generatedMSL: candidate.generatedMSL,
    stageLocalGeneratedMSL: candidate.stageLocalGeneratedMSL,
    legacyGeneratedMSL: legacy.generatedMSL,
    legacyStageLocalGeneratedMSL: legacy.stageLocalGeneratedMSL,
    summary: {
      status: "passed",
      candidate: candidate.summary,
      legacyComparison: legacy.summary,
    },
  };
}

function compileSwiftCanary(scratch) {
  const executable = join(scratch, "runtime-buffer-size-canary");
  const architecture = process.arch === "x64" ? "x86_64" : process.arch;
  if (architecture !== "arm64" && architecture !== "x86_64") {
    fail(`unsupported Swift target architecture ${architecture}`);
  }
  const compilation = runCommand("xcrun", [
    "swiftc",
    "-O",
    "-target",
    `${architecture}-apple-macosx14.0`,
    join(spikeDirectory, "prototype/main.swift"),
    "-framework",
    "Foundation",
    "-framework",
    "Metal",
    "-o",
    executable,
  ]);
  if (compilation.error || compilation.signal || compilation.status !== 0) {
    commandFailure("Swift runtime canary compilation", compilation);
  }
  return executable;
}

function verifyRuntimeResponse(response) {
  const expected = {
    backingBufferLength: 2048,
    backingBufferOffsets: [0, 256, 512, 768, 1024],
    allStorageCompatibilityResult: [2, 3, 4, 5, 6, 0, 0, 0, 0, 0],
    canonicalResult: [2, 3, 4, 5, 6, 0, 0, 0, 0, 0],
    densePoisonResult: [2, 3, 0, 28, 268435455, 0, 0, 0, 0, 0],
    dispatchesPerTransport: 4,
    exactCapacityVertexStreamIndex: 29,
    immediateAllStorageUploadBytesHex:
      "0000000020000000280000002000000024000000140000007000000000000000",
    immediateCanonicalUploadBytesHex:
      "0000000020000000000000002000000024000000140000007000000000000000",
    immediateComputeAlignment: 4,
    immediateComputeDataSize: 28,
    immediateDenseUploadBytesHex:
      "0000000020000000200000002400000014000000700000000000000000000000",
    immediateFragmentAlignment: 4,
    immediateFragmentDataSize: 28,
    immediateReboundUploadBytesHex:
      "0000000030000000000000002800000028000000180000008000000000000000",
    immediateVertexAlignment: 4,
    immediateVertexDataSize: 8,
    reboundResult: [3, 4, 5, 6, 7, 0, 0, 0, 0, 0],
    stageLocalFragmentBufferIndices: [5, 30],
    stageLocalVertexBufferIndices: [0, 29, 30],
    transportReadbacksEqual: true,
    uboCanonicalUploadBytesHex:
      "2000000000000000200000002400000014000000700000000000000000000000",
    uboComputeAlignment: 16,
    uboComputeDataSize: 32,
    uboFragmentAlignment: 16,
    uboFragmentDataSize: 32,
    uboVertexAlignment: 16,
    uboVertexDataSize: 16,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(response[key], value)) {
      fail(`Metal runtime response ${key} drifted`);
    }
  }
  if (typeof response.device !== "string" || response.device.length === 0) {
    fail("Metal runtime response omitted the device name");
  }
}

function runMetalRuntime(
  generatedMSL,
  stageLocalGeneratedMSL,
  legacyGeneratedMSL,
  legacyStageLocalGeneratedMSL,
  scratch,
  required
) {
  if (process.platform !== "darwin") {
    if (required) fail("Metal runtime gate requires macOS");
    return { status: "skipped", reason: "host-is-not-macos" };
  }
  if (!availableXcrunTool("swiftc")) {
    if (required) fail("Metal runtime gate requires xcrun swiftc");
    return { status: "skipped", reason: "swiftc-unavailable" };
  }
  const executable = compileSwiftCanary(scratch);
  const attempts = [
    runCommand(executable, [
      generatedMSL,
      stageLocalGeneratedMSL.vertex,
      stageLocalGeneratedMSL.fragment,
      legacyGeneratedMSL,
      legacyStageLocalGeneratedMSL.vertex,
      legacyStageLocalGeneratedMSL.fragment,
    ]),
    runCommand(executable, [
      generatedMSL,
      stageLocalGeneratedMSL.vertex,
      stageLocalGeneratedMSL.fragment,
      legacyGeneratedMSL,
      legacyStageLocalGeneratedMSL.vertex,
      legacyStageLocalGeneratedMSL.fragment,
    ]),
  ];
  if (attempts.some((attempt) => attempt.status === 75)) {
    if (required) fail("Metal runtime gate found no Metal device");
    return { status: "skipped", reason: "no-metal-device" };
  }
  for (const attempt of attempts) {
    if (attempt.error || attempt.signal || attempt.status !== 0) {
      commandFailure("Metal runtime canary", attempt);
    }
  }
  if (attempts[0].stdout !== attempts[1].stdout) {
    fail("Metal runtime output is not deterministic");
  }
  const response = JSON.parse(attempts[0].stdout);
  verifyRuntimeResponse(response);
  return {
    status: "passed",
    deterministicRuns: 2,
    dispatchesPerRun: 8,
    device: response.device,
    canonicalResult: response.canonicalResult,
    reboundResult: response.reboundResult,
    densePoisonResult: response.densePoisonResult,
  };
}

function runOfflineMetal(generatedMSL, scratch, required) {
  if (process.platform !== "darwin") {
    if (required) fail("offline Metal gate requires macOS");
    return { status: "skipped", reason: "host-is-not-macos" };
  }
  const missing = ["metal", "metallib"].filter(
    (tool) => !availableXcrunTool(tool)
  );
  if (missing.length > 0) {
    if (required) {
      fail(
        `offline Metal gate requires missing xcrun tools: ${missing.join(", ")}`
      );
    }
    return {
      status: "skipped",
      reason: `missing-xcrun-tools:${missing.join(",")}`,
    };
  }
  const air = join(scratch, "multi-runtime.air");
  const metallib = join(scratch, "multi-runtime.metallib");
  const compile = runCommand("xcrun", [
    "-sdk",
    "macosx",
    "metal",
    "-c",
    generatedMSL,
    "-o",
    air,
    "-std=macos-metal2.4",
    "-target",
    metalTarget,
  ]);
  if (compile.error || compile.signal || compile.status !== 0) {
    commandFailure("offline Metal compilation", compile);
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
    commandFailure("offline metallib link", link);
  }
  if (!existsSync(metallib)) {
    fail("offline Metal gate did not produce a metallib");
  }
  return { status: "passed", target: metalTarget };
}

function printSummary(result) {
  const allocator = result.allocator;
  process.stdout.write(
    `PASS allocator: ${allocator.programs} programs, ` +
      `${allocator.runtimeArraysInCrossRowCase} cross-row runtime arrays, ` +
      `${allocator.inputMutations} input mutations, ` +
      `${allocator.verifierMutations} verifier mutations\n`
  );
  for (const [label, value] of [
    ["Tint integration", result.tint],
    ["Metal runtime", result.metalRuntime],
    ["offline Metal", result.offlineMetal],
  ]) {
    if (value.status === "passed") {
      const detail = value.device ? ` (${value.device})` : "";
      process.stdout.write(`PASS ${label}${detail}\n`);
    } else {
      process.stdout.write(`SKIP ${label}: ${value.reason}\n`);
    }
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const fixtures = readJSON(join(fixturesDirectory, "cases.json"));
  const mutations = readJSON(join(fixturesDirectory, "mutations.json"));
  const snapshot = readJSON(join(spikeDirectory, "snapshots/expected.json"));
  const allocatorResult = runAllocator(fixtures, mutations, snapshot);
  const result = {
    allocator: allocatorResult.summary,
    tint: { status: "skipped", reason: "no-release-root-provided" },
    metalRuntime: { status: "skipped", reason: "requires-tint-output" },
    offlineMetal: { status: "skipped", reason: "requires-tint-output" },
  };

  if (!options.releaseRoot) {
    if (options.requireTint) {
      fail("--require-tint requires --release-root");
    }
    printSummary(result);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), "vgpu-c1-runtime-buffer-sizes-"));
  try {
    const wrapper = compileTintWrapper(
      options.releaseRoot,
      options.compatInclude,
      scratch
    );
    const tintResult = runTint(wrapper, allocatorResult, scratch);
    result.tint = tintResult.summary;
    if (options.skipMetalRuntime) {
      result.metalRuntime = { status: "skipped", reason: "requested-by-flag" };
    } else {
      result.metalRuntime = runMetalRuntime(
        tintResult.generatedMSL,
        tintResult.stageLocalGeneratedMSL,
        tintResult.legacyGeneratedMSL,
        tintResult.legacyStageLocalGeneratedMSL,
        scratch,
        options.requireMetalRuntime
      );
    }
    result.offlineMetal = runOfflineMetal(
      tintResult.generatedMSL,
      scratch,
      options.requireOfflineMetal
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  printSummary(result);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
