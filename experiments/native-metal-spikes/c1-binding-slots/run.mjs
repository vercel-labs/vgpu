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
const projectionRepresentabilityCaseId =
  "external-texture-expansion-representability";
const supportedFixtureStatuses = new Set([
  "tint-writer-validated-sampled-texture-array",
  "projection-representability-only",
]);

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

function expectProjectionSchemaFailure(
  validator,
  value,
  expectedKeyword,
  canaryId
) {
  if (validator(value)) {
    fail(`${canaryId} unexpectedly passed the projection schema`);
  }
  if (!validator.errors?.some((error) => error.keyword === expectedKeyword)) {
    fail(
      `${canaryId} failed for the wrong reason: ${JSON.stringify(
        validator.errors
      )}`
    );
  }
}

function runProjectionSchemaCanaries(allocations, validators) {
  const sharedBinding = allocations
    .get("stage-local-draw-and-shared-binding")
    ?.allocation.programs.find(
      (program) => program.semanticProgram === "SharedDraw"
    )
    ?.bindings.find((binding) => binding.semanticBinding === "g0b0");
  const sharedInternal = allocations
    .get("stage-local-internal-binding")
    ?.allocation.programs.find(
      (program) => program.semanticProgram === "SharedInternalDraw"
    )
    ?.internalBindings.find((binding) => binding.role === "immediate-data");
  if (!sharedBinding || !sharedInternal) {
    fail("projection schema canaries reference missing program-level unions");
  }
  const projectionOnlyBinding = allocations
    .get(projectionRepresentabilityCaseId)
    ?.allocation.programs.find(
      (program) => program.semanticProgram === "ExternalTexture"
    )
    ?.bindings.find((binding) => binding.semanticBinding === "g0b0");
  if (!projectionOnlyBinding) {
    fail("projection-only schema canary references a missing binding");
  }
  if (validators.binding(projectionOnlyBinding)) {
    fail("projection-only external texture passed the production schema");
  }
  if (
    !validators.binding.errors?.some(
      (error) =>
        error.instancePath === "/slots" &&
        error.keyword === "maxItems" &&
        error.params.limit === 2
    )
  ) {
    fail(
      `projection-only external texture failed for the wrong reason: ${JSON.stringify(
        validators.binding.errors
      )}`
    );
  }

  const canaries = [
    {
      id: "binding-duplicate-stage",
      validator: validators.binding,
      keyword: "contains",
      value: clone(sharedBinding),
      mutate(value) {
        value.slots[1].stage = value.slots[0].stage;
        value.slots[1].index = value.slots[0].index + 1;
      },
    },
    {
      id: "binding-three-stage-slots",
      validator: validators.binding,
      keyword: "maxItems",
      value: clone(sharedBinding),
      mutate(value) {
        value.slots.push({
          ...clone(value.slots[0]),
          stage: "compute",
        });
      },
    },
    {
      id: "binding-inverted-stage-order",
      validator: validators.binding,
      keyword: "const",
      value: clone(sharedBinding),
      mutate(value) {
        value.slots.reverse();
      },
    },
    {
      id: "internal-binding-duplicate-stage",
      validator: validators.internalBinding,
      keyword: "contains",
      value: clone(sharedInternal),
      mutate(value) {
        value.slots[1].stage = value.slots[0].stage;
        value.slots[1].index = value.slots[0].index - 1;
      },
    },
    {
      id: "internal-binding-three-stage-slots",
      validator: validators.internalBinding,
      keyword: "maxItems",
      value: clone(sharedInternal),
      mutate(value) {
        value.slots.push({
          ...clone(value.slots[0]),
          stage: "compute",
        });
      },
    },
    {
      id: "internal-binding-inverted-stage-order",
      validator: validators.internalBinding,
      keyword: "const",
      value: clone(sharedInternal),
      mutate(value) {
        value.slots.reverse();
      },
    },
  ];
  for (const canary of canaries) {
    canary.mutate(canary.value);
    expectProjectionSchemaFailure(
      canary.validator,
      canary.value,
      canary.keyword,
      canary.id
    );
  }
  return canaries.length;
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
  let artifactSchemaCases = 0;
  let projectionRepresentabilityCases = 0;
  for (const fixtureCase of fixtures.cases) {
    if (
      fixtureCase.status !== undefined &&
      !supportedFixtureStatuses.has(fixtureCase.status)
    ) {
      fail(`${fixtureCase.id} has unsupported status ${fixtureCase.status}`);
    }
    if (
      (fixtureCase.status === "projection-representability-only") !==
      (fixtureCase.id === projectionRepresentabilityCaseId)
    ) {
      fail(
        `${fixtureCase.id} does not match the projection-representability allowlist`
      );
    }
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
    if (fixtureCase.status === "projection-representability-only") {
      projectionRepresentabilityCases += 1;
    } else {
      validateProjectionFragments(first, validators, fixtureCase.id);
      artifactSchemaCases += 1;
    }
    allocations.set(fixtureCase.id, { input, allocation: first });
    actualCases.push({
      id: fixtureCase.id,
      ...(fixtureCase.status ? { status: fixtureCase.status } : {}),
      ...first,
    });
  }
  if (artifactSchemaCases !== 8 || projectionRepresentabilityCases !== 1) {
    fail(
      `expected 8 production-schema cases and 1 projection-only case, received ${artifactSchemaCases}/${projectionRepresentabilityCases}`
    );
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
  const projectionSchemaMutations = runProjectionSchemaCanaries(
    allocations,
    validators
  );
  return {
    allocations,
    summary: {
      status: "passed",
      cases: fixtures.cases.length,
      artifactSchemaCases,
      projectionRepresentabilityCases,
      deterministicPermutations: fixtures.cases.length,
      mutations: mutationFixture.mutations.length,
      verifierMutations: verifierCases.length,
      projectionSchemaMutations,
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
  if (
    sourceText.includes("ubo_binding") ||
    !sourceText.includes(
      "array_lengths.buffer_sizes_offset = arguments.buffer_sizes_offset"
    ) ||
    !sourceText.includes("writer_options.immediate_binding_point")
  ) {
    fail(
      "prototype must route storage sizes through the shared immediate block"
    );
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
  const expectedInternalRoles = [...(tintCanary.internalRoles ?? [])].sort();
  if (new Set(expectedInternalRoles).size !== expectedInternalRoles.length) {
    fail(`${tintCanary.program} repeats an expected internal role`);
  }
  const projectedInternal = projected.internalBindings
    .map((internal) => ({
      role: internal.role,
      slots: internal.slots.filter((slot) => slot.stage === tintCanary.stage),
    }))
    .filter((internal) => internal.slots.length > 0)
    .sort((left, right) => left.role.localeCompare(right.role));
  const projectedInternalRoles = projectedInternal.map(
    (internal) => internal.role
  );
  if (!isDeepStrictEqual(projectedInternalRoles, expectedInternalRoles)) {
    fail(`${tintCanary.program} projected a different internal role set`);
  }
  const internalIndices = {};
  for (const internal of projectedInternal) {
    if (
      internal.slots.length !== 1 ||
      internal.slots[0].resourceClass !== "buffer"
    ) {
      fail(
        `${tintCanary.program} has no single buffer slot for ${internal.role}`
      );
    }
    internalIndices[internal.role] = internal.slots[0].index;
  }
  let configuredImmediateIndex;
  if (
    (tintCanary.runtimeStorageBindings ?? 0) > 0 ||
    internalIndices["immediate-data"] !== undefined
  ) {
    const reservations = fixtures.profile.internalReservations.filter(
      (reservation) =>
        reservation.role === "immediate-data" &&
        reservation.stage === tintCanary.stage &&
        reservation.resourceClass === "buffer" &&
        reservation.count === 1
    );
    if (reservations.length !== 1) {
      fail(
        `${tintCanary.program} has no single profile immediate-data reservation`
      );
    }
    configuredImmediateIndex = reservations[0].index;
  }
  return { mappings, internalIndices, configuredImmediateIndex };
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

function hasDedicatedSizeTableBinding(msl) {
  return /\btint_storage_buffer_sizes\s*\[\[buffer\(/.test(msl);
}

function hasSharedImmediateLayout(msl) {
  return /struct\s+tint_immediate_data_struct\s*\{\s*\/\*\s*0x0000\s*\*\/\s*uint\s+tint_non_constant_zero;\s*\/\*\s*0x0004\s*\*\/\s*tint_array<uint,\s*\d+>\s+tint_storage_buffer_sizes;\s*\}/.test(
    msl
  );
}

function verifyInternalBindingMatchers() {
  const distinct =
    "tint_storage_buffer_sizes [[buffer(7)]], " +
    "tint_immediate_data [[buffer(30)]]";
  if (
    !hasDedicatedSizeTableBinding(distinct) ||
    !hasNamedBufferBinding(distinct, "tint_immediate_data", 30) ||
    hasNamedBufferBinding(distinct, "tint_immediate_data", 7)
  ) {
    fail(
      "internal binding matchers do not distinguish dedicated and shared transport"
    );
  }
}

function runTintCanary(wrapper, fixtures, tintCanary, allocation, scratch) {
  const { mappings, internalIndices, configuredImmediateIndex } =
    selectedTintMappings(fixtures, tintCanary, allocation);
  const expectsImmediate = internalIndices["immediate-data"] !== undefined;
  const forcesOrdinaryImmediate = tintCanary.writerOptions?.includes(
    "force-u32-div-mod-immediate"
  );
  if (
    typeof tintCanary.needsStorageBufferSizes !== "boolean" ||
    !Number.isSafeInteger(tintCanary.runtimeStorageBindings ?? 0) ||
    (tintCanary.runtimeStorageBindings ?? 0) < 0 ||
    (tintCanary.bufferSizesOffset !== undefined &&
      (!Number.isSafeInteger(tintCanary.bufferSizesOffset) ||
        tintCanary.bufferSizesOffset < 0 ||
        tintCanary.bufferSizesOffset % 4 !== 0)) ||
    (tintCanary.needsStorageBufferSizes &&
      tintCanary.bufferSizesOffset === undefined) ||
    (tintCanary.bufferSizesOffset !== undefined &&
      configuredImmediateIndex === undefined) ||
    (tintCanary.needsStorageBufferSizes && !expectsImmediate) ||
    (forcesOrdinaryImmediate && !expectsImmediate)
  ) {
    fail(
      `${tintCanary.program}/${tintCanary.stage} has invalid Tint expectations`
    );
  }
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
      ...(configuredImmediateIndex === undefined
        ? []
        : ["--immediate-index", String(configuredImmediateIndex)]),
      ...(tintCanary.bufferSizesOffset === undefined
        ? []
        : ["--buffer-sizes-offset", String(tintCanary.bufferSizesOffset)]),
      ...(tintCanary.needsStorageBufferSizes
        ? ["--expect-storage-buffer-sizes"]
        : []),
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
    response.needsStorageBufferSizes !== tintCanary.needsStorageBufferSizes ||
    response.runtimeStorageBindings !==
      (tintCanary.runtimeStorageBindings ?? 0) ||
    response.usedImmediate !== expectsImmediate ||
    response.immediateIndex !== (configuredImmediateIndex ?? null) ||
    response.bufferSizesOffset !== (tintCanary.bufferSizesOffset ?? null)
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
  const immediateIndex = internalIndices["immediate-data"];
  if (
    immediateIndex !== undefined &&
    !hasNamedBufferBinding(
      attempts[0].msl,
      "tint_immediate_data",
      immediateIndex
    )
  ) {
    fail(`${safeName} MSL omitted immediate-data at buffer(${immediateIndex})`);
  }
  if (
    immediateIndex === undefined &&
    configuredImmediateIndex !== undefined &&
    hasNamedBufferBinding(
      attempts[0].msl,
      "tint_immediate_data",
      configuredImmediateIndex
    )
  ) {
    fail(`${safeName} MSL emitted an undeclared immediate-data binding`);
  }
  if (hasDedicatedSizeTableBinding(attempts[0].msl)) {
    fail(`${safeName} MSL emitted a dedicated storage-size binding`);
  }
  const sizeMemberReferences =
    attempts[0].msl.match(/\btint_storage_buffer_sizes\b/g)?.length ?? 0;
  if (
    (tintCanary.needsStorageBufferSizes && sizeMemberReferences < 2) ||
    (!tintCanary.needsStorageBufferSizes && sizeMemberReferences > 1)
  ) {
    fail(`${safeName} MSL storage-size reads disagree with Tint metadata`);
  }
  if (
    forcesOrdinaryImmediate &&
    !attempts[0].msl.includes("tint_non_constant_zero")
  ) {
    fail(`${safeName} MSL ordinary immediate member drifted`);
  }
  if (
    tintCanary.needsStorageBufferSizes &&
    forcesOrdinaryImmediate &&
    !hasSharedImmediateLayout(attempts[0].msl)
  ) {
    fail(
      `${safeName} MSL did not place ordinary and size immediates in one struct`
    );
  }
  return {
    id: safeName,
    status: "passed",
    mslPath: attempts[0].outputPath,
    msl: attempts[0].msl,
    resourceArrays: mappings.some((mapping) => mapping.count > 1),
  };
}

function verifySharedImmediateDataCanaries(fixtures, results) {
  const runtimeCanaries = fixtures.tintCanaries.filter(
    (canary) => (canary.runtimeStorageBindings ?? 0) > 0
  );
  const combinations = new Map([
    ["size-only", { needsSizes: true, forcesOrdinary: false }],
    ["ordinary-and-size", { needsSizes: true, forcesOrdinary: true }],
    ["ordinary-only", { needsSizes: false, forcesOrdinary: true }],
    ["neither", { needsSizes: false, forcesOrdinary: false }],
  ]);
  for (const [label, combination] of combinations) {
    const matching = runtimeCanaries.filter((canary) => {
      const forcesOrdinary =
        canary.writerOptions?.includes("force-u32-div-mod-immediate") === true;
      return (
        canary.needsStorageBufferSizes === combination.needsSizes &&
        forcesOrdinary === combination.forcesOrdinary
      );
    });
    if (matching.length !== 1) {
      fail(`shared immediate-data truth table requires one ${label} canary`);
    }
    const canary = matching[0];
    const expectedRoles =
      combination.needsSizes || combination.forcesOrdinary
        ? ["immediate-data"]
        : [];
    if (
      canary.bufferSizesOffset !== 4 ||
      !isDeepStrictEqual(canary.internalRoles ?? [], expectedRoles)
    ) {
      fail(`${canary.program} has invalid ${label} transport expectations`);
    }
    const result = results.find(
      (candidate) => candidate.id === `${canary.program}-${canary.stage}`
    );
    if (!result || result.status !== "passed") {
      fail(`${canary.program} did not prove the ${label} combination`);
    }
  }
  if (runtimeCanaries.length !== combinations.size) {
    fail("shared immediate-data truth table contains an unexpected canary");
  }
  return "passed";
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
      flags: ["--immediate-index", "30", "--buffer-sizes-offset", "4"],
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
      id: "buffer-sizes-offset-without-immediate-data",
      source: "runtime-array.wgsl",
      entryPoint: "main",
      mapping: ["storage 0 0 0 1"],
      flags: ["--buffer-sizes-offset", "4"],
      diagnostic:
        "buffer-sizes offset requires the shared immediate-data binding",
    },
    {
      id: "runtime-size-query-without-buffer-sizes-offset",
      source: "runtime-array.wgsl",
      entryPoint: "main",
      mapping: ["storage 0 0 0 1"],
      flags: ["--immediate-index", "30"],
      diagnostic: "runtime-sized storage requires a buffer-sizes offset",
    },
    {
      id: "runtime-sized-storage-without-immediate-configuration",
      source: "runtime-array.wgsl",
      entryPoint: "main",
      mapping: ["storage 0 0 0 1"],
      flags: [],
      diagnostic:
        "runtime-sized storage requires shared immediate-data configuration",
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
  verifyInternalBindingMatchers();
  const negativeCanaries = runTintNegativeCanaries(wrapper, scratch);
  const results = fixtures.tintCanaries.map((tintCanary) => {
    const allocation = allocations.get(tintCanary.case)?.allocation;
    if (!allocation) fail(`missing allocation for ${tintCanary.case}`);
    return runTintCanary(wrapper, fixtures, tintCanary, allocation, scratch);
  });
  const sharedImmediateDataCanary = verifySharedImmediateDataCanaries(
    fixtures,
    results
  );
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
      sharedImmediateDataCanary,
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
