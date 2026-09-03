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
import Ajv2020 from "ajv/dist/2020.js";
import {
  allocateBindingSlots,
  BindingSlotAllocationError,
} from "./lib/allocate.mjs";
import {
  BindingSlotVerificationError,
  verifyBindingSlotAllocation,
} from "./lib/verify.mjs";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(fixtureDirectory, "..", "..", "..");
const expectedTintCommit = "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca";
const metalTarget = "air64-apple-macos14.0";

function fail(message) {
  throw new Error(`C1 binding slots: ${message}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArguments(argv) {
  const options = {
    releaseRoot: process.env.C1_TINT_RELEASE_ROOT,
    compatInclude: process.env.C1_TINT_COMPAT_INCLUDE,
    requireTint: process.env.C1_REQUIRE_TINT === "1",
    requireOfflineMetal: process.env.C1_REQUIRE_OFFLINE_METAL === "1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: node run.mjs [--release-root <Dawn release>] " +
          "[--compat-include <header overlay>] [--require-tint] " +
          "[--require-offline-metal]\n"
      );
      process.exit(0);
    }
    if (argument === "--require-tint") {
      options.requireTint = true;
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
        value;
      continue;
    }
    fail(`unknown argument ${argument}`);
  }
  if (options.releaseRoot) options.releaseRoot = resolve(options.releaseRoot);
  if (options.compatInclude)
    options.compatInclude = resolve(options.compatInclude);
  if (options.requireOfflineMetal) options.requireTint = true;
  return options;
}

function caseInput(fixtures, fixtureCase) {
  return {
    profile: clone(fixtures.profile),
    programs: clone(fixtureCase.programs),
  };
}

function permuteInput(input) {
  const permuted = clone(input);
  permuted.profile.internalReservations.reverse();
  permuted.programs.reverse();
  for (const program of permuted.programs) {
    program.entries.reverse();
    for (const entry of program.entries) entry.bindings.reverse();
    program.bindings.reverse();
    for (const binding of program.bindings) binding.components.reverse();
    program.requiredInternalBindings.reverse();
    for (const internal of program.requiredInternalBindings)
      internal.stages.reverse();
  }
  return permuted;
}

function schemaValidators() {
  const schema = readJSON(
    join(
      repository,
      "docs/plans/native/contracts/metal-projection-v1.schema.json"
    )
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const binding = ajv.getSchema(`${schema.$id}#/$defs/binding`);
  const internalBinding = ajv.getSchema(`${schema.$id}#/$defs/internalBinding`);
  if (!binding || !internalBinding)
    fail("could not compile projection sub-schemas");
  return { binding, internalBinding };
}

function validateProjectionFragments(allocation, validators, caseId) {
  for (const program of allocation.programs) {
    for (const binding of program.bindings) {
      if (!validators.binding(binding)) {
        fail(
          `${caseId}/${
            program.semanticProgram
          } binding schema: ${JSON.stringify(validators.binding.errors)}`
        );
      }
    }
    for (const internal of program.internalBindings) {
      if (!validators.internalBinding(internal)) {
        fail(
          `${caseId}/${
            program.semanticProgram
          } internal schema: ${JSON.stringify(
            validators.internalBinding.errors
          )}`
        );
      }
    }
  }
}

function findProgram(input, name) {
  const program = input.programs.find(
    (candidate) => candidate.semanticProgram === name
  );
  if (!program) fail(`mutation references unknown program ${name}`);
  return program;
}

function findEntry(program, stage) {
  const entry = program.entries.find((candidate) => candidate.stage === stage);
  if (!entry)
    fail(
      `mutation references unknown stage ${program.semanticProgram}/${stage}`
    );
  return entry;
}

function findBinding(program, id) {
  const binding = program.bindings.find((candidate) => candidate.id === id);
  if (!binding)
    fail(
      `mutation references unknown binding ${program.semanticProgram}/${id}`
    );
  return binding;
}

function applyMutation(input, operation) {
  const program = operation.program
    ? findProgram(input, operation.program)
    : undefined;
  switch (`${operation.op}:${operation.target}`) {
    case "append:input.property":
      input[operation.key] = clone(operation.value);
      return;
    case "reverse:program.bindings":
      program.bindings.reverse();
      return;
    case "reverse:entry.bindings":
      findEntry(program, operation.stage).bindings.reverse();
      return;
    case "append:program.bindings":
      program.bindings.push(clone(operation.value));
      return;
    case "append:entry.bindings":
      findEntry(program, operation.stage).bindings.push(operation.value);
      return;
    case "remove:entry.bindings": {
      const bindings = findEntry(program, operation.stage).bindings;
      const index = bindings.indexOf(operation.value);
      if (index < 0) fail(`mutation cannot remove ${operation.value}`);
      bindings.splice(index, 1);
      return;
    }
    case "append:profile.internalReservations":
      input.profile.internalReservations.push(clone(operation.value));
      return;
    case "replace:profile.internalReservation.index": {
      const reservation = input.profile.internalReservations.find(
        (candidate) =>
          candidate.role === operation.role &&
          candidate.stage === operation.stage &&
          candidate.resourceClass === operation.resourceClass
      );
      if (!reservation) fail("mutation references unknown reservation");
      reservation.index = operation.value;
      return;
    }
    case "append:binding.components":
      findBinding(program, operation.binding).components.push(
        clone(operation.value)
      );
      return;
    case "replace:binding.id":
      findBinding(program, operation.binding).id = operation.value;
      return;
    case "replace:component.resourceClass":
    case "replace:component.count": {
      const component = findBinding(program, operation.binding).components.find(
        (candidate) => candidate.component === operation.component
      );
      if (!component)
        fail(`mutation references unknown component ${operation.component}`);
      component[
        operation.target.endsWith("count") ? "count" : "resourceClass"
      ] = operation.value;
      return;
    }
    case "replace:internalRequirement.role": {
      const requirement = program.requiredInternalBindings.find(
        (candidate) => candidate.role === operation.role
      );
      if (!requirement)
        fail(`mutation references unknown internal role ${operation.role}`);
      requirement.role = operation.value;
      return;
    }
    case "replace:program.semanticProgram":
      program.semanticProgram =
        operation.repeat === undefined
          ? operation.value
          : operation.value.repeat(operation.repeat);
      return;
    case "replace:root.programs":
      input.programs = clone(operation.value);
      return;
    default:
      fail(`unsupported mutation ${operation.op}:${operation.target}`);
  }
}

function expectAllocationError(input, expected, mutationId) {
  try {
    allocateBindingSlots(input);
  } catch (error) {
    if (!(error instanceof BindingSlotAllocationError)) throw error;
    if (
      error.code !== expected.code ||
      !error.message.includes(expected.messageIncludes)
    ) {
      fail(
        `${mutationId} expected ${expected.code}/${expected.messageIncludes}, received ${error.code}/${error.message}`
      );
    }
    return;
  }
  fail(`${mutationId} unexpectedly succeeded`);
}

function runAllocator(fixtures, mutationFixture, expected) {
  if (
    fixtures.schemaVersion !== 1 ||
    mutationFixture.schemaVersion !== 1 ||
    expected.schemaVersion !== 1 ||
    fixtures.bindingModel !== "vgpu-metal-binding-slots-v1" ||
    expected.bindingModel !== fixtures.bindingModel
  ) {
    fail("fixture identity mismatch");
  }
  const validators = schemaValidators();
  const allocations = new Map();
  const actualCases = [];
  for (const fixtureCase of fixtures.cases) {
    for (const source of fixtureCase.sources ?? []) {
      if (!existsSync(join(fixtureDirectory, "canaries", source))) {
        fail(`${fixtureCase.id} references missing canary ${source}`);
      }
    }
    const input = caseInput(fixtures, fixtureCase);
    const first = allocateBindingSlots(input);
    const second = allocateBindingSlots(clone(input));
    const permuted = allocateBindingSlots(permuteInput(input));
    if (
      !isDeepStrictEqual(first, second) ||
      !isDeepStrictEqual(first, permuted)
    ) {
      fail(`${fixtureCase.id} allocation is not deterministic`);
    }
    verifyBindingSlotAllocation(input, first);
    validateProjectionFragments(first, validators, fixtureCase.id);
    allocations.set(fixtureCase.id, { input, allocation: first });
    actualCases.push({
      id: fixtureCase.id,
      ...(fixtureCase.status ? { status: fixtureCase.status } : {}),
      ...first,
    });
  }
  const actual = {
    schemaVersion: 1,
    bindingModel: fixtures.bindingModel,
    cases: actualCases,
  };
  if (!isDeepStrictEqual(actual, expected)) {
    process.stderr.write(`${JSON.stringify(actual, null, 2)}\n`);
    fail("allocator snapshot drifted");
  }

  for (const mutation of mutationFixture.mutations) {
    const baseline = allocations.get(mutation.baseCase);
    if (!baseline) fail(`${mutation.id} references an unknown base case`);
    const input = clone(baseline.input);
    for (const operation of mutation.operations)
      applyMutation(input, operation);
    if (mutation.expected.status === "same-snapshot") {
      const result = allocateBindingSlots(input);
      verifyBindingSlotAllocation(input, result);
      if (!isDeepStrictEqual(result, baseline.allocation)) {
        fail(`${mutation.id} changed the canonical allocation`);
      }
    } else if (mutation.expected.status === "error") {
      expectAllocationError(input, mutation.expected, mutation.id);
    } else {
      fail(`${mutation.id} has unknown expected status`);
    }
  }

  const verifierCases = [
    {
      id: "tampered-index",
      base: "order-and-resource-classes",
      mutate(output) {
        output.programs[0].bindings[0].slots[0].index = 9;
      },
      code: "SLOT_MISMATCH",
    },
    {
      id: "missing-slot",
      base: "stage-local-draw-and-shared-binding",
      mutate(output) {
        output.programs[0].bindings[0].slots.pop();
      },
      code: "SLOT_SET_MISMATCH",
    },
    {
      id: "inactive-stage",
      base: "order-and-resource-classes",
      mutate(output) {
        output.programs[0].bindings[0].slots[0].stage = "vertex";
      },
      code: "INACTIVE_SLOT",
    },
    {
      id: "unexpected-internal",
      base: "order-and-resource-classes",
      mutate(output) {
        output.programs[0].internalBindings.push({
          role: "unexpected",
          slots: [],
        });
      },
      code: "INTERNAL_SET_MISMATCH",
    },
    {
      id: "reordered-programs",
      base: "two-programs-from-one-source",
      mutate(output) {
        output.programs.reverse();
      },
      code: "PROGRAM_SET_MISMATCH",
    },
    {
      id: "unknown-root-property",
      base: "order-and-resource-classes",
      mutate(output) {
        output.ignored = true;
      },
      code: "INVALID_SHAPE",
    },
    {
      id: "unknown-program-property",
      base: "order-and-resource-classes",
      mutate(output) {
        output.programs[0].ignored = true;
      },
      code: "INVALID_SHAPE",
    },
    {
      id: "unknown-binding-property",
      base: "order-and-resource-classes",
      mutate(output) {
        output.programs[0].bindings[0].ignored = true;
      },
      code: "INVALID_SHAPE",
    },
    {
      id: "unknown-slot-property",
      base: "order-and-resource-classes",
      mutate(output) {
        output.programs[0].bindings[0].slots[0].ignored = true;
      },
      code: "INVALID_SHAPE",
    },
  ];
  for (const verifierCase of verifierCases) {
    const baseline = allocations.get(verifierCase.base);
    const tampered = clone(baseline.allocation);
    verifierCase.mutate(tampered);
    try {
      verifyBindingSlotAllocation(baseline.input, tampered);
    } catch (error) {
      if (
        error instanceof BindingSlotVerificationError &&
        error.code === verifierCase.code
      ) {
        continue;
      }
      throw error;
    }
    fail(`${verifierCase.id} escaped the independent verifier`);
  }
  return {
    allocations,
    summary: {
      status: "passed",
      cases: fixtures.cases.length,
      deterministicPermutations: fixtures.cases.length,
      mutations: mutationFixture.mutations.length,
      verifierMutations: verifierCases.length,
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

function compileWrapper(releaseRoot, compatInclude, scratch) {
  const provenance = readJSON(
    join(
      fixtureDirectory,
      "..",
      "c1-tint-standalone",
      "provenance/releases.json"
    )
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
  const compilerHeader = join(includeRoot, "src/utils/compiler.h");
  const resolvedCompilerHeader = compatInclude
    ? join(compatInclude, "src/utils/compiler.h")
    : compilerHeader;
  if (!existsSync(resolvedCompilerHeader)) {
    fail(
      "official release needs --compat-include with its exact missing header overlay"
    );
  }
  if (sha256(resolvedCompilerHeader) !== expectedCompilerHeaderHash) {
    fail(`compiler.h does not match pinned Dawn ${expectedTintCommit}`);
  }
  const wrapper = join(scratch, "vgpu-tint-binding-slots");
  const source = join(fixtureDirectory, "prototype/main.cc");
  const sourceText = readFileSync(source, "utf8");
  if (
    sourceText.includes("tint::GenerateBindings") ||
    sourceText.includes("api/helpers/generate_bindings")
  ) {
    fail("prototype must not call or include GenerateBindings");
  }
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
  const result = runCommand("xcrun", args);
  if (result.error || result.signal || result.status !== 0) {
    fail(`wrapper compilation failed: ${result.stderr.trim()}`);
  }
  return wrapper;
}

function selectedTintMappings(fixtures, tintCanary, allocation) {
  const fixtureCase = fixtures.cases.find(
    (candidate) => candidate.id === tintCanary.case
  );
  const inputProgram = fixtureCase?.programs.find(
    (candidate) => candidate.semanticProgram === tintCanary.program
  );
  const projected = allocation.programs.find(
    (candidate) => candidate.semanticProgram === tintCanary.program
  );
  const entry = inputProgram?.entries.find(
    (candidate) => candidate.stage === tintCanary.stage
  );
  if (!inputProgram || !projected || !entry) {
    fail(`invalid Tint canary ${tintCanary.case}/${tintCanary.program}`);
  }
  const mappings = [];
  for (const id of entry.bindings) {
    const source = inputProgram.bindings.find(
      (candidate) => candidate.id === id
    );
    const projectedBinding = projected.bindings.find(
      (candidate) => candidate.semanticBinding === id
    );
    const slots = projectedBinding?.slots.filter(
      (slot) => slot.stage === tintCanary.stage
    );
    if (!source || !slots || slots.length !== 1) {
      fail(
        `${tintCanary.program}/${tintCanary.stage}/${id} is not directly representable`
      );
    }
    const kind = tintCanary.bindingKinds[id];
    if (!kind) fail(`${tintCanary.program}/${id} has no Tint resource kind`);
    mappings.push({
      kind,
      group: source.group,
      binding: source.binding,
      metalIndex: slots[0].index,
      count: slots[0].count,
    });
  }
  mappings.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.group - right.group ||
      left.binding - right.binding
  );
  const internalIndices = {};
  for (const role of tintCanary.internalRoles ?? []) {
    const internal = projected.internalBindings.find(
      (candidate) => candidate.role === role
    );
    const slots = internal?.slots.filter(
      (slot) => slot.stage === tintCanary.stage
    );
    if (!slots || slots.length !== 1 || slots[0].resourceClass !== "buffer") {
      fail(`${tintCanary.program} has no single buffer slot for ${role}`);
    }
    internalIndices[role] = slots[0].index;
  }
  return { mappings, internalIndices };
}

function normalizeDiagnostic(value, releaseRoot, scratch) {
  let normalized = value;
  if (releaseRoot)
    normalized = normalized.replaceAll(releaseRoot, "<release-root>");
  if (scratch) normalized = normalized.replaceAll(scratch, "<scratch>");
  return normalized
    .replaceAll(fixtureDirectory, "<fixture-dir>")
    .replaceAll("\\", "/")
    .trim();
}

function hasNamedBufferBinding(msl, symbol, index) {
  return new RegExp(`\\b${symbol}\\s*\\[\\[buffer\\(${index}\\)\\]\\]`).test(
    msl
  );
}

function verifyRoleBindingMatcher() {
  const swapped =
    "tint_storage_buffer_sizes [[buffer(29)]], " +
    "tint_immediate_data [[buffer(30)]]";
  if (
    hasNamedBufferBinding(swapped, "tint_storage_buffer_sizes", 30) ||
    hasNamedBufferBinding(swapped, "tint_immediate_data", 29)
  ) {
    fail("internal-role matcher accepts swapped buffer indices");
  }
}

function runTintCanary(wrapper, fixtures, tintCanary, allocation, scratch) {
  const { mappings, internalIndices } = selectedTintMappings(
    fixtures,
    tintCanary,
    allocation
  );
  const safeName = `${tintCanary.program}-${tintCanary.stage}`;
  const mappingPath = join(scratch, `${safeName}.map`);
  writeFileSync(
    mappingPath,
    `${mappings
      .map(
        (mapping) =>
          `${mapping.kind} ${mapping.group} ${mapping.binding} ${mapping.metalIndex} ${mapping.count}`
      )
      .join("\n")}\n`
  );
  const attempts = ["first", "second"].map((suffix) => {
    const outputPath = join(scratch, `${safeName}-${suffix}.metal`);
    const args = [
      join(fixtureDirectory, "canaries", tintCanary.source),
      tintCanary.entryPoint,
      tintCanary.emittedEntryPoint,
      outputPath,
      mappingPath,
      ...(tintCanary.languageFeatures?.includes("sized_binding_array")
        ? ["--sized-binding-array"]
        : []),
      ...(internalIndices["storage-buffer-sizes"] === undefined
        ? []
        : [
            "--storage-buffer-sizes-index",
            String(internalIndices["storage-buffer-sizes"]),
          ]),
      ...(internalIndices["immediate-data"] === undefined
        ? []
        : ["--immediate-index", String(internalIndices["immediate-data"])]),
      ...(tintCanary.writerOptions?.includes("force-u32-div-mod-immediate")
        ? ["--force-u32-div-mod-immediate"]
        : []),
    ];
    const process = runCommand(wrapper, args);
    return {
      ...process,
      outputPath,
      msl: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
    };
  });
  const succeeded = attempts.every(
    (attempt) =>
      !attempt.error &&
      attempt.signal === null &&
      attempt.status === 0 &&
      attempt.msl.length > 0
  );
  if (succeeded && tintCanary.expectedTintStatus === "rejected") {
    fail(`${safeName} was expected to be rejected but passed`);
  }
  if (!succeeded) {
    const diagnostic = normalizeDiagnostic(
      `${attempts[0].stdout}${attempts[0].stderr}`,
      "",
      scratch
    );
    if (
      tintCanary.experimental &&
      tintCanary.expectedTintStatus === "rejected"
    ) {
      if (
        attempts[0].status !== attempts[1].status ||
        normalizeDiagnostic(
          `${attempts[1].stdout}${attempts[1].stderr}`,
          "",
          scratch
        ) !== diagnostic
      ) {
        fail(`${safeName} experimental failure is nondeterministic`);
      }
      return { id: safeName, status: "rejected", diagnostic };
    }
    fail(`${safeName} wrapper execution failed: ${diagnostic}`);
  }
  if (
    attempts[0].stdout !== attempts[1].stdout ||
    attempts[0].msl !== attempts[1].msl
  ) {
    fail(`${safeName} Tint output is not deterministic`);
  }
  const response = JSON.parse(attempts[0].stdout);
  if (
    response.entryPoint !== tintCanary.entryPoint ||
    response.emittedEntryPoint !== tintCanary.emittedEntryPoint ||
    response.stage !== tintCanary.stage ||
    !isDeepStrictEqual(response.bindings, mappings) ||
    response.needsStorageBufferSizes !==
      (internalIndices["storage-buffer-sizes"] !== undefined) ||
    response.usedStorageBufferSizes !==
      (internalIndices["storage-buffer-sizes"] !== undefined) ||
    response.usedImmediate !==
      (internalIndices["immediate-data"] !== undefined) ||
    (internalIndices["storage-buffer-sizes"] !== undefined &&
      response.storageBufferSizesIndex !==
        internalIndices["storage-buffer-sizes"]) ||
    (internalIndices["immediate-data"] !== undefined &&
      response.immediateIndex !== internalIndices["immediate-data"])
  ) {
    fail(`${safeName} returned a map different from the vgpu allocation`);
  }
  if (!attempts[0].msl.includes(tintCanary.emittedEntryPoint)) {
    fail(`${safeName} MSL omitted the emitted entry point`);
  }
  for (const mapping of mappings) {
    const attribute =
      mapping.kind === "sampler"
        ? "sampler"
        : mapping.kind.includes("texture")
        ? "texture"
        : "buffer";
    if (!attempts[0].msl.includes(`[[${attribute}(${mapping.metalIndex})]]`)) {
      fail(`${safeName} MSL omitted ${attribute}(${mapping.metalIndex})`);
    }
  }
  for (const [role, index] of Object.entries(internalIndices)) {
    const symbol =
      role === "storage-buffer-sizes"
        ? "tint_storage_buffer_sizes"
        : "tint_immediate_data";
    if (!hasNamedBufferBinding(attempts[0].msl, symbol, index)) {
      fail(`${safeName} MSL omitted ${role} at buffer(${index})`);
    }
  }
  return {
    id: safeName,
    status: "passed",
    mslPath: attempts[0].outputPath,
    msl: attempts[0].msl,
    resourceArrays: mappings.some((mapping) => mapping.count > 1),
  };
}

function runTintNegativeCanaries(wrapper, scratch) {
  const canaries = [
    {
      id: "user-buffer-collision",
      source: "binding-slots.wgsl",
      entryPoint: "main",
      mapping: [
        "uniform 0 3 0 1",
        "storage 2 0 0 1",
        "texture 1 7 0 1",
        "sampler 1 2 0 1",
      ],
      flags: [],
      diagnostic: "requested binding intervals collide",
    },
    {
      id: "texture-array-overlap",
      source: "resource-arrays.wgsl",
      entryPoint: "main",
      mapping: [
        "texture 0 0 0 3",
        "sampler 0 1 0 1",
        "texture 0 2 2 1",
        "sampler 0 3 1 1",
      ],
      flags: ["--sized-binding-array"],
      diagnostic: "requested binding intervals collide",
    },
    {
      id: "user-internal-buffer-collision",
      source: "runtime-array.wgsl",
      entryPoint: "main",
      mapping: ["storage 0 0 30 1"],
      flags: ["--storage-buffer-sizes-index", "30"],
      diagnostic: "requested binding intervals collide",
    },
    {
      id: "array-count-reflection-mismatch",
      source: "resource-arrays.wgsl",
      entryPoint: "main",
      mapping: [
        "texture 0 0 0 2",
        "sampler 0 1 0 1",
        "texture 0 2 3 1",
        "sampler 0 3 1 1",
      ],
      flags: ["--sized-binding-array"],
      diagnostic:
        "requested binding map differs from selected-entry reflection",
    },
    {
      id: "missing-selected-entry-binding",
      source: "binding-slots.wgsl",
      entryPoint: "main",
      mapping: ["uniform 0 3 0 1", "storage 2 0 1 1", "texture 1 7 0 1"],
      flags: [],
      diagnostic:
        "requested binding count does not match selected-entry reflection",
    },
    {
      id: "extra-selected-entry-binding",
      source: "binding-slots.wgsl",
      entryPoint: "main",
      mapping: [
        "uniform 0 3 0 1",
        "storage 2 0 1 1",
        "texture 1 7 0 1",
        "sampler 1 2 0 1",
        "uniform 9 9 2 1",
      ],
      flags: [],
      diagnostic:
        "requested binding count does not match selected-entry reflection",
    },
    {
      id: "wrong-selected-entry-resource-kind",
      source: "binding-slots.wgsl",
      entryPoint: "main",
      mapping: [
        "storage 0 3 0 1",
        "storage 2 0 1 1",
        "texture 1 7 0 1",
        "sampler 1 2 0 1",
      ],
      flags: [],
      diagnostic:
        "requested binding map differs from selected-entry reflection",
    },
    {
      id: "runtime-array-without-size-table",
      source: "runtime-array.wgsl",
      entryPoint: "main",
      mapping: ["storage 0 0 0 1"],
      flags: [],
      diagnostic: "selected entry requires a storage-buffer-sizes slot",
    },
  ];

  for (const canary of canaries) {
    const mappingPath = join(scratch, `${canary.id}.map`);
    writeFileSync(mappingPath, `${canary.mapping.join("\n")}\n`);
    const diagnostics = ["first", "second"].map((attempt) => {
      const outputPath = join(scratch, `${canary.id}-${attempt}.metal`);
      const result = runCommand(wrapper, [
        join(fixtureDirectory, "canaries", canary.source),
        canary.entryPoint,
        `vgpu_negative_${canary.id.replaceAll("-", "_")}`,
        outputPath,
        mappingPath,
        ...canary.flags,
      ]);
      if (result.error || result.signal || result.status === 0) {
        fail(`${canary.id} negative canary unexpectedly succeeded or crashed`);
      }
      if (existsSync(outputPath)) {
        fail(`${canary.id} negative canary emitted MSL`);
      }
      return normalizeDiagnostic(
        `${result.stdout}${result.stderr}`,
        "",
        scratch
      );
    });
    if (
      diagnostics[0] !== diagnostics[1] ||
      !diagnostics[0].includes(canary.diagnostic)
    ) {
      fail(
        `${canary.id} returned an unexpected or nondeterministic diagnostic: ${diagnostics[0]}`
      );
    }
  }
  return canaries.length;
}

function commandExists(command) {
  const result = runCommand("xcrun", ["--find", command]);
  return result.status === 0 && result.stdout.trim().length > 0;
}

function runOfflineMetal(tintResults, scratch, required) {
  if (!commandExists("metal") || !commandExists("metallib")) {
    if (required)
      fail("offline Apple Metal toolchain is required but unavailable");
    return { status: "skipped", reason: "offline-metal-toolchain-unavailable" };
  }
  let compiled = 0;
  for (const result of tintResults) {
    if (result.status !== "passed") continue;
    const air = join(scratch, `${result.id}.air`);
    const library = join(scratch, `${result.id}.metallib`);
    const compile = runCommand("xcrun", [
      "metal",
      "-std=macos-metal2.4",
      "-target",
      metalTarget,
      "-c",
      result.mslPath,
      "-o",
      air,
    ]);
    if (compile.status !== 0 || compile.signal || compile.error) {
      fail(
        `${
          result.id
        } offline Metal compilation failed: ${compile.stderr.trim()}`
      );
    }
    const link = runCommand("xcrun", ["metallib", air, "-o", library]);
    if (
      link.status !== 0 ||
      link.signal ||
      link.error ||
      !existsSync(library)
    ) {
      fail(`${result.id} metallib link failed: ${link.stderr.trim()}`);
    }
    compiled += 1;
  }
  return { status: "passed", target: metalTarget, compiled };
}

function runTintIntegration(options, fixtures, allocations, scratch) {
  if (!options.releaseRoot) {
    if (options.requireTint) fail("Tint integration requires --release-root");
    return {
      tint: { status: "skipped", reason: "release-root-not-provided" },
      offlineMetal: {
        status: "skipped",
        reason: "Tint-integration-not-run",
      },
    };
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    if (options.requireTint)
      fail("the pinned release fixture requires Darwin arm64");
    return {
      tint: { status: "skipped", reason: "requires-darwin-arm64" },
      offlineMetal: { status: "skipped", reason: "Tint-integration-not-run" },
    };
  }
  const wrapper = compileWrapper(
    options.releaseRoot,
    options.compatInclude,
    scratch
  );
  verifyRoleBindingMatcher();
  const negativeCanaries = runTintNegativeCanaries(wrapper, scratch);
  const results = fixtures.tintCanaries.map((tintCanary) => {
    const allocation = allocations.get(tintCanary.case)?.allocation;
    if (!allocation) fail(`missing allocation for ${tintCanary.case}`);
    return runTintCanary(wrapper, fixtures, tintCanary, allocation, scratch);
  });
  const resourceArray = results.find(
    (result) => result.resourceArrays || result.id === "ResourceArrays-compute"
  );
  const offlineMetal = runOfflineMetal(
    results,
    scratch,
    options.requireOfflineMetal
  );
  return {
    tint: {
      status: "passed",
      dawnCommit: expectedTintCommit,
      verifiedHashes: ["lib/libwebgpu_dawn.a", "src/utils/compiler.h"],
      internalRoleAssociationCanary: "passed",
      canaries: results.length,
      deterministicCanaries: results.length,
      negativeCanaries,
      sampledTextureArrayWriterEvidence: resourceArray?.status ?? "not-run",
      rejectedExperimentalDiagnostics: results
        .filter((result) => result.status === "rejected")
        .map((result) => ({ id: result.id, diagnostic: result.diagnostic })),
    },
    offlineMetal,
  };
}

const options = parseArguments(process.argv.slice(2));
const fixtures = readJSON(join(fixtureDirectory, "fixtures/programs.json"));
const mutations = readJSON(join(fixtureDirectory, "fixtures/mutations.json"));
const expected = readJSON(join(fixtureDirectory, "snapshots/expected.json"));
const scratch = mkdtempSync(join(tmpdir(), "vgpu-c1-binding-slots-"));

try {
  const allocator = runAllocator(fixtures, mutations, expected);
  const integration = runTintIntegration(
    options,
    fixtures,
    allocator.allocations,
    scratch
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        bindingModel: fixtures.bindingModel,
        allocator: allocator.summary,
        ...integration,
      },
      null,
      2
    )}\n`
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
