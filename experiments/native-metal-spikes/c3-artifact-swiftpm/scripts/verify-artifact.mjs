#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(scriptDirectory, "..");
const defaultRepository = resolve(fixtureDirectory, "..", "..", "..");
const runtimeSupportedStorageBufferSizeModel =
  "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1";

function fail(message) {
  throw new Error(`C3 verify: ${message}`);
}

function parseArguments(argv) {
  const options = {
    repository: defaultRepository,
    inputsRoot: fixtureDirectory,
    expectedStorageBufferSizeModel: runtimeSupportedStorageBufferSizeModel,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      fail(`expected --name value pairs, received ${name ?? "<nothing>"}`);
    }
    const key = {
      "--package": "packageRoot",
      "--repository": "repository",
      "--inputs-root": "inputsRoot",
      "--expected-storage-buffer-size-model": "expectedStorageBufferSizeModel",
    }[name];
    if (!key) fail(`unknown option ${name}`);
    options[key] = value;
  }
  if (!options.packageRoot) fail("--package is required");
  return {
    ...options,
    packageRoot: resolve(options.packageRoot),
    repository: resolve(options.repository),
    inputsRoot: resolve(options.inputsRoot),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const fields = Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    return `{${fields
      .map((field) => `${JSON.stringify(field)}:${canonicalize(value[field])}`)
      .join(",")}}`;
  }
  fail(`cannot canonicalize ${typeof value}`);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalize(value), "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected)
    fail(`${label}: expected ${expected}, received ${actual}`);
}

function assertIncludes(contents, expected, label) {
  if (!contents.includes(expected)) fail(`${label}: missing ${expected}`);
}

function sourcePositionOffset(contents, position, owner) {
  const lineStarts = [0];
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === "\n") lineStarts.push(index + 1);
  }
  if (
    !Number.isSafeInteger(position.line) ||
    !Number.isSafeInteger(position.column) ||
    position.line < 1 ||
    position.line > lineStarts.length ||
    position.column < 1
  ) {
    fail(`${owner} has an invalid source position`);
  }
  const lineStart = lineStarts[position.line - 1];
  const nextLineStart = lineStarts[position.line];
  const lineEnd =
    nextLineStart === undefined ? contents.length : nextLineStart - 1;
  const offset = lineStart + position.column - 1;
  if (offset > lineEnd) fail(`${owner} source column is outside its line`);
  return offset;
}

function validateSourceSpans(semantic, inputs, inputsRoot) {
  const sourceById = new Map(
    inputs.map((input) => [
      input.id,
      {
        input,
        contents: readFileSync(
          join(inputsRoot, ...input.path.split("/")),
          "utf8"
        ),
      },
    ])
  );

  for (const program of semantic.programs) {
    for (const entry of Object.values(program.entryPoints)) {
      if (!entry.source) continue;
      const owner = `${program.name}/${entry.stage}/${entry.names.wgsl}`;
      const source = sourceById.get(entry.source.input);
      if (
        !source ||
        source.input.role !== "wgsl" ||
        !program.sources.includes(entry.source.input)
      ) {
        fail(`${owner} source span does not reference a declared WGSL input`);
      }
      const start = sourcePositionOffset(
        source.contents,
        entry.source.start,
        `${owner} start`
      );
      const end = sourcePositionOffset(
        source.contents,
        entry.source.end,
        `${owner} end`
      );
      if (end <= start) fail(`${owner} source span is empty or reversed`);
      const snippet = source.contents.slice(start, end);
      const escapedName = entry.names.wgsl.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );
      const declaration = new RegExp(
        `@${entry.stage}\\b[\\s\\S]*?\\bfn\\s+${escapedName}\\s*\\(`
      );
      if (!declaration.test(snippet)) {
        fail(
          `${owner} source span does not contain its WGSL entry declaration`
        );
      }
    }
  }
}

function requireSourceSpanMutationFailure(
  semantic,
  inputs,
  inputsRoot,
  mutate,
  expectedMessage,
  label
) {
  const candidate = clone(semantic);
  mutate(candidate);
  let rejected = false;
  try {
    validateSourceSpans(candidate, inputs, inputsRoot);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expectedMessage)) {
      fail(`${label}: unexpected error ${String(error)}`);
    }
    rejected = true;
  }
  if (!rejected) fail(`${label}: mutation was accepted`);
}

function stripPresentationAndProvenance(value) {
  if (Array.isArray(value)) {
    return value.map(stripPresentationAndProvenance);
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "swiftName" && key !== "source")
      .map(([key, child]) => [key, stripPresentationAndProvenance(child)])
  );
}

function stripInterfaceDiagnosticNames(program) {
  for (const entry of Object.values(program.entryPoints)) {
    for (const value of [...entry.inputs, ...entry.outputs]) {
      delete value.name;
    }
  }
  return program;
}

function normalizeSemanticSets(value, key = "") {
  if (Array.isArray(value)) {
    const normalized = value.map((child) => normalizeSemanticSets(child));
    const isStringSet =
      ["languageFeatures", "features", "visibility"].includes(key) ||
      (key === "bindings" &&
        normalized.every((child) => typeof child === "string"));
    return isStringSet
      ? normalized.sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0
        )
      : normalized;
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      normalizeSemanticSets(child, childKey),
    ])
  );
}

function reachableTypeAndLayoutClosure(program, semantic) {
  const typeIds = new Set();
  const layoutIds = new Set();
  const typeQueue = [];
  const layoutQueue = [];
  const addType = (id) => {
    if (id !== undefined && !typeIds.has(id)) {
      typeIds.add(id);
      typeQueue.push(id);
    }
  };
  const addLayout = (id) => {
    if (id !== undefined && !layoutIds.has(id)) {
      layoutIds.add(id);
      layoutQueue.push(id);
    }
  };

  for (const binding of program.bindings) {
    addType(binding.type);
    addLayout(binding.layout);
  }
  for (const entry of Object.values(program.entryPoints)) {
    for (const value of [...entry.inputs, ...entry.outputs])
      addType(value.type);
  }

  while (typeQueue.length > 0 || layoutQueue.length > 0) {
    while (typeQueue.length > 0) {
      const id = typeQueue.shift();
      const type = semantic.types[id];
      if (!type) fail(`program ${program.name} references unknown type ${id}`);
      for (const [layoutId, layout] of Object.entries(semantic.layouts)) {
        if (layout.type === id) addLayout(layoutId);
      }
      addType(type.element);
      for (const member of type.members ?? []) addType(member.type);
    }
    while (layoutQueue.length > 0) {
      const id = layoutQueue.shift();
      const layout = semantic.layouts[id];
      if (!layout)
        fail(`program ${program.name} references unknown layout ${id}`);
      addType(layout.type);
      for (const member of layout.members) {
        addType(member.type);
        addLayout(member.layout);
      }
    }
  }

  const types = Object.fromEntries(
    [...typeIds]
      .sort()
      .map((id) => [id, stripPresentationAndProvenance(semantic.types[id])])
  );
  const layouts = Object.fromEntries(
    [...layoutIds]
      .sort()
      .map((id) => [id, stripPresentationAndProvenance(semantic.layouts[id])])
  );
  return { types, layouts };
}

function programFingerprintInput(program, semantic, inputs) {
  const programWithoutFingerprint = clone(program);
  delete programWithoutFingerprint.fingerprint;
  delete programWithoutFingerprint.sources;
  const sourcesById = new Map(inputs.map((input) => [input.id, input]));
  const sources = program.sources
    .map((id) => {
      const input = sourcesById.get(id);
      if (!input || input.role !== "wgsl") {
        fail(`program ${program.name} references unknown WGSL input ${id}`);
      }
      return { id, sha256: input.sha256 };
    })
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );
  const closure = reachableTypeAndLayoutClosure(program, semantic);
  return {
    domain: "vgpu-native-program/v1",
    layoutModel: semantic.layoutModel,
    sources,
    languageFeatures: [...semantic.capabilities.languageFeatures].sort(),
    program: normalizeSemanticSets(
      stripPresentationAndProvenance(
        stripInterfaceDiagnosticNames(programWithoutFingerprint)
      )
    ),
    types: closure.types,
    layouts: closure.layouts,
  };
}

function fingerprintProgram(program, semantic, inputs) {
  return sha256Canonical(programFingerprintInput(program, semantic, inputs));
}

function requireSemanticProgram(semantic, name) {
  const program = semantic.programs.find(
    (candidate) => candidate.name === name
  );
  if (!program) fail(`semantic program ${name} is missing`);
  return program;
}

function roundUp(alignment, value) {
  return Math.ceil(value / alignment) * alignment;
}

function minimumBindingSizeForLayout(layoutId, semantic, visiting = new Set()) {
  if (visiting.has(layoutId)) fail(`layout cycle at ${layoutId}`);
  const layout = semantic.layouts[layoutId];
  const type = semantic.types[layout?.type];
  if (!layout || !type)
    fail(`cannot derive minimum binding size for ${layoutId}`);
  if (!layout.runtimeSized) return layout.minimumSize;

  const nextVisiting = new Set(visiting).add(layoutId);
  if (type.kind === "array" && type.count === undefined) {
    if (!Number.isSafeInteger(layout.arrayStride)) {
      fail(`runtime array layout ${layoutId} has no safe array stride`);
    }
    return layout.arrayStride;
  }
  if (type.kind === "struct") {
    const runtimeMembers = layout.members.filter(
      (member) => member.runtimeSized
    );
    if (runtimeMembers.length !== 1) {
      fail(
        `runtime struct layout ${layoutId} needs one trailing runtime member`
      );
    }
    const runtimeMember = runtimeMembers[0];
    if (layout.members.at(-1) !== runtimeMember) {
      fail(
        `runtime struct layout ${layoutId} has a non-trailing runtime member`
      );
    }
    const memberEnd =
      runtimeMember.offset +
      minimumBindingSizeForLayout(runtimeMember.layout, semantic, nextVisiting);
    const size = roundUp(
      layout.alignment,
      Math.max(layout.minimumSize, memberEnd)
    );
    if (!Number.isSafeInteger(size)) {
      fail(`runtime struct layout ${layoutId} minimum binding size overflows`);
    }
    return size;
  }
  fail(`runtime-sized layout ${layoutId} is neither an array nor a struct`);
}

function assertProgramFingerprintSensitivity(program, semantic, inputs) {
  const baseline = fingerprintProgram(program, semantic, inputs);
  const assertChanged = (actual, label) => {
    if (actual === baseline)
      fail(`${program.name} fingerprint ignored ${label}`);
  };

  const changedInputs = clone(inputs);
  const referencedInput = changedInputs.find(
    (input) => input.id === program.sources[0]
  );
  if (!referencedInput) {
    fail(`${program.name} fingerprint sensitivity has no referenced input`);
  }
  referencedInput.sha256 = "f".repeat(64);
  assertChanged(
    fingerprintProgram(program, semantic, changedInputs),
    "referenced WGSL hash"
  );

  const changedLayoutModel = clone(semantic);
  changedLayoutModel.layoutModel = `${semantic.layoutModel}-changed`;
  assertChanged(
    fingerprintProgram(program, changedLayoutModel, inputs),
    "layout model"
  );

  const changedLanguageFeatures = clone(semantic);
  changedLanguageFeatures.capabilities.languageFeatures = [
    ...semantic.capabilities.languageFeatures,
    "c3_fingerprint_probe",
  ];
  assertChanged(
    fingerprintProgram(program, changedLanguageFeatures, inputs),
    "language features"
  );

  const changedReachableLayout = clone(semantic);
  const reachableLayouts = Object.keys(
    reachableTypeAndLayoutClosure(program, semantic).layouts
  );
  if (reachableLayouts.length === 0) {
    fail(`${program.name} fingerprint sensitivity needs a reachable layout`);
  }
  const directlyReachableTypeIds = new Set([
    ...program.bindings.map((binding) => binding.type),
    ...Object.values(program.entryPoints).flatMap((entry) => [
      ...entry.inputs.map((value) => value.type),
      ...entry.outputs.map((value) => value.type),
    ]),
  ]);
  const directlyReachableLayoutId = reachableLayouts.find((id) =>
    directlyReachableTypeIds.has(semantic.layouts[id]?.type)
  );
  if (!directlyReachableLayoutId) {
    fail(
      `${program.name} fingerprint sensitivity needs a directly reachable layout`
    );
  }
  changedReachableLayout.layouts[directlyReachableLayoutId].minimumSize += 1;
  assertChanged(
    fingerprintProgram(program, changedReachableLayout, inputs),
    "reachable intrinsic layout"
  );

  const elementalTypeId = Object.keys(
    reachableTypeAndLayoutClosure(program, semantic).types
  )
    .map((id) => semantic.types[id].element)
    .find((id) => id !== undefined);
  const elementalLayoutId = Object.keys(semantic.layouts).find(
    (id) => semantic.layouts[id].type === elementalTypeId
  );
  if (
    !elementalTypeId ||
    !elementalLayoutId ||
    !reachableLayouts.includes(elementalLayoutId)
  ) {
    fail(
      `${program.name} fingerprint sensitivity needs a transitively reachable elemental layout`
    );
  }
  const changedElementalLayout = clone(semantic);
  changedElementalLayout.layouts[elementalLayoutId].minimumSize += 1;
  assertChanged(
    fingerprintProgram(program, changedElementalLayout, inputs),
    "transitively reachable elemental layout"
  );

  const changedUnreachable = clone(semantic);
  changedUnreachable.types.c3_unreachable = { kind: "scalar", scalar: "u32" };
  changedUnreachable.layouts.c3_unreachable = {
    type: "c3_unreachable",
    alignment: 4,
    minimumSize: 4,
    size: 4,
    runtimeSized: false,
    members: [],
  };
  assertEqual(
    fingerprintProgram(program, changedUnreachable, inputs),
    baseline,
    `${program.name} unreachable type/layout fingerprint exclusion`
  );
}

function assertShaderInterfaceProgramFingerprintSensitivity(semantic, inputs) {
  const programName = "SparseDraw";
  const originalProgram = requireSemanticProgram(semantic, programName);
  const baseline = fingerprintProgram(originalProgram, semantic, inputs);
  const originalBytes = canonicalize(originalProgram);
  const mutate = (change) => {
    const candidate = clone(semantic);
    const program = requireSemanticProgram(candidate, programName);
    change(program);
    return { candidate, program };
  };
  const assertMutationChangesFingerprint = (label, change) => {
    const candidate = mutate(change);
    if (
      fingerprintProgram(candidate.program, candidate.candidate, inputs) ===
      baseline
    ) {
      fail(`${programName} fingerprint ignored shader-interface ${label}`);
    }
  };
  const assertMutationPreservesFingerprint = (label, change) => {
    const candidate = mutate(change);
    assertEqual(
      fingerprintProgram(candidate.program, candidate.candidate, inputs),
      baseline,
      `${programName} ${label} fingerprint exclusion`
    );
  };

  assertMutationChangesFingerprint("location", (program) => {
    const value = program.entryPoints.vertex.inputs.find(
      (input) => input.location === 3
    );
    if (!value) fail(`${programName} location sensitivity input is missing`);
    value.location = 4;
  });
  assertMutationChangesFingerprint("type", (program) => {
    const value = program.entryPoints.vertex.inputs.find(
      (input) => input.location === 7
    );
    if (!value) fail(`${programName} type sensitivity input is missing`);
    value.type = "u32";
  });
  assertMutationChangesFingerprint("interpolation", (program) => {
    for (const entry of [
      program.entryPoints.vertex.outputs,
      program.entryPoints.fragment.inputs,
    ]) {
      const value = entry.find((item) => item.location === 2);
      if (!value) {
        fail(`${programName} interpolation sensitivity value is missing`);
      }
      value.interpolation.sampling = "center";
    }
  });

  assertMutationPreservesFingerprint(
    "vertex input diagnostic-name",
    (program) => {
      const value = program.entryPoints.vertex.inputs.find(
        (input) => input.location === 3
      );
      if (!value) fail(`${programName} diagnostic-name input is missing`);
      value.name = "renamedPosition";
    }
  );
  assertMutationPreservesFingerprint(
    "fragment output diagnostic-name removal",
    (program) => {
      const value = program.entryPoints.fragment.outputs.find(
        (output) => output.location === 1
      );
      if (!value) fail(`${programName} diagnostic-name output is missing`);
      delete value.name;
    }
  );

  assertMutationChangesFingerprint("program name", (program) => {
    program.name = "SparseDrawRenamed";
  });
  assertMutationChangesFingerprint("resolved entry name", (program) => {
    program.entryPoints.vertex.names.wgsl = "c3_sparse_vertex_renamed";
  });

  const fingerprintInput = programFingerprintInput(
    originalProgram,
    semantic,
    inputs
  );
  for (const entry of Object.values(fingerprintInput.program.entryPoints)) {
    for (const value of [...entry.inputs, ...entry.outputs]) {
      if (Object.hasOwn(value, "name")) {
        fail(`${programName} fingerprint preimage retained an interface name`);
      }
    }
  }
  assertEqual(
    canonicalize(originalProgram),
    originalBytes,
    `${programName} fingerprint projection mutation`
  );
}

function assertRetainedNameProgramFingerprintSensitivity(semantic, inputs) {
  const programName = "RuntimeArray";
  const originalProgram = requireSemanticProgram(semantic, programName);
  const baseline = fingerprintProgram(originalProgram, semantic, inputs);

  const renamedBindingSemantic = clone(semantic);
  const renamedBindingProgram = requireSemanticProgram(
    renamedBindingSemantic,
    programName
  );
  renamedBindingProgram.bindings[0].name = "renamedRuntimeValues";
  if (
    fingerprintProgram(
      renamedBindingProgram,
      renamedBindingSemantic,
      inputs
    ) === baseline
  ) {
    fail(`${programName} fingerprint ignored binding name`);
  }

  const renamedMemberSemantic = clone(semantic);
  const renamedMemberProgram = requireSemanticProgram(
    renamedMemberSemantic,
    programName
  );
  renamedMemberSemantic.types["runtime-values"].members[0].name =
    "renamedPrefix";
  if (
    fingerprintProgram(renamedMemberProgram, renamedMemberSemantic, inputs) ===
    baseline
  ) {
    fail(`${programName} fingerprint ignored reachable member name`);
  }
}

function assertOverrideProgramFingerprintSensitivity(semantic, inputs) {
  const programName = "Noop";
  const overrideName = "C3_WORKGROUP_X";
  const originalProgram = requireSemanticProgram(semantic, programName);
  const originalOverride = originalProgram.overrides.find(
    (override) => override.names.wgsl === overrideName
  );
  if (!originalOverride) {
    fail(`${programName} override fingerprint sensitivity is missing`);
  }
  const baseline = fingerprintProgram(originalProgram, semantic, inputs);
  const mutate = (change) => {
    const candidate = clone(semantic);
    const program = requireSemanticProgram(candidate, programName);
    const override = program.overrides.find(
      (current) => current.names.wgsl === overrideName
    );
    if (!override) fail(`${programName} override ${overrideName} is missing`);
    change(override);
    return { candidate, program };
  };

  const renamed = mutate((override) => {
    override.names.wgsl = "C3_WORKGROUP_Y";
  });
  if (
    fingerprintProgram(renamed.program, renamed.candidate, inputs) === baseline
  ) {
    fail(`${programName} fingerprint ignored resolved override name`);
  }

  const reselected = mutate((override) => {
    override.selected.value = 3;
  });
  if (
    fingerprintProgram(reselected.program, reselected.candidate, inputs) ===
    baseline
  ) {
    fail(`${programName} fingerprint ignored selected override value`);
  }

  const renamedForSwift = mutate((override) => {
    override.swiftName = "renamedForSwift";
  });
  assertEqual(
    fingerprintProgram(
      renamedForSwift.program,
      renamedForSwift.candidate,
      inputs
    ),
    baseline,
    `${programName} override Swift-name fingerprint exclusion`
  );
}

function runtimeProjectionInput(projection, librarySHA256) {
  return {
    semantic: projection.semantic,
    target: projection.target,
    abi: projection.abi,
    vertexBufferPolicy: projection.vertexBufferPolicy,
    storageBufferSizeModel: projection.storageBufferSizeModel,
    library: {
      path: projection.library.path,
      sha256: librarySHA256,
    },
    programs: projection.programs,
    deviceRequirements: projection.deviceRequirements,
  };
}

function validateProjectionSlotEntryStages(projection) {
  for (const program of projection.programs) {
    const entryStages = new Set(
      program.entryPoints.map((entry) => entry.stage)
    );
    for (const binding of program.bindings) {
      for (const slot of binding.slots) {
        if (!entryStages.has(slot.stage)) {
          fail(
            `${program.semanticProgram}/${binding.semanticBinding} slot stage ${slot.stage} has no projected entry point`
          );
        }
      }
    }
    for (const internal of program.internalBindings) {
      for (const slot of internal.slots) {
        if (!entryStages.has(slot.stage)) {
          fail(
            `${program.semanticProgram}/${internal.role} slot stage ${slot.stage} has no projected entry point`
          );
        }
      }
    }
  }
}

function requireProjectionSlotEntryMutationFailure(
  projection,
  mutate,
  expectedMessage,
  label
) {
  const candidate = clone(projection);
  mutate(candidate);
  let rejected = false;
  try {
    validateProjectionSlotEntryStages(candidate);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expectedMessage)) {
      fail(`${label}: unexpected error ${String(error)}`);
    }
    rejected = true;
  }
  if (!rejected) fail(`${label}: mutation was accepted`);
}

function validateVertexBufferPolicy(projection) {
  const ceiling = projection.vertexBufferPolicy?.externalBufferCeiling;
  if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
    fail("vertex-buffer policy has an invalid external ceiling");
  }
  for (const program of projection.programs) {
    for (const binding of program.bindings) {
      for (const slot of binding.slots) {
        if (slot.stage !== "vertex" || slot.resourceClass !== "buffer") {
          continue;
        }
        const end = slot.index + slot.count;
        if (!Number.isSafeInteger(end) || end > ceiling) {
          fail(
            `${program.semanticProgram}/${binding.semanticBinding} external vertex buffer interval ends at ${end}, above ceiling ${ceiling}`
          );
        }
      }
    }
    for (const internal of program.internalBindings) {
      for (const slot of internal.slots) {
        if (
          slot.stage === "vertex" &&
          slot.resourceClass === "buffer" &&
          slot.index < ceiling
        ) {
          fail(
            `${program.semanticProgram}/${internal.role} internal vertex buffer interval starts at ${slot.index}, below ceiling ${ceiling}`
          );
        }
      }
    }
  }
}

function validateResolvedWorkgroupSizes(semantic, projection) {
  const semanticPrograms = new Map(
    semantic.programs.map((program) => [program.name, program])
  );
  for (const program of projection.programs) {
    const semanticProgram = semanticPrograms.get(program.semanticProgram);
    if (!semanticProgram) {
      fail(
        `workgroup-size contract references unknown program ${program.semanticProgram}`
      );
    }
    if (semanticProgram.kind !== "compute") continue;
    for (const axis of ["x", "y", "z"]) {
      assertEqual(
        program.resolvedWorkgroupSize?.[axis],
        semanticProgram.entryPoints.compute.workgroupSize[axis],
        `${program.semanticProgram} resolved workgroup size ${axis}`
      );
    }
  }
}

function requireWorkgroupSizeMutationFailure(
  semantic,
  projection,
  mutate,
  expectedMessage,
  label
) {
  const semanticCandidate = clone(semantic);
  const projectionCandidate = clone(projection);
  mutate(semanticCandidate, projectionCandidate);
  let rejected = false;
  try {
    validateResolvedWorkgroupSizes(semanticCandidate, projectionCandidate);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expectedMessage)) {
      fail(`${label}: unexpected error ${String(error)}`);
    }
    rejected = true;
  }
  if (!rejected) fail(`${label}: mutation was accepted`);
}

const canonicalStageOrder = ["vertex", "fragment", "compute"];

function compareCanonicalStrings(left, right) {
  left = left.normalize("NFC");
  right = right.normalize("NFC");
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateSemanticOverrides(semantic) {
  const wgslIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const program of semantic.programs) {
    const names = new Set();
    const authoredIds = new Set();
    let previousName;
    for (const override of program.overrides) {
      const name = override.names?.wgsl;
      if (
        typeof name !== "string" ||
        name.length > 256 ||
        !wgslIdentifier.test(name)
      ) {
        fail(`${program.name} has an invalid override WGSL name`);
      }
      if (names.has(name)) fail(`${program.name} repeats override ${name}`);
      if (previousName !== undefined && previousName >= name) {
        fail(`${program.name} overrides are not canonically name ordered`);
      }
      names.add(name);
      previousName = name;

      if (Object.hasOwn(override, "wgslId")) {
        if (authoredIds.has(override.wgslId)) {
          fail(
            `${program.name} repeats authored WGSL override ID ${override.wgslId}`
          );
        }
        authoredIds.add(override.wgslId);
      }
    }
  }
}

function requireSemanticOverrideMutationFailure(
  semantic,
  mutate,
  expectedMessage,
  label
) {
  const candidate = clone(semantic);
  mutate(candidate);
  let rejected = false;
  try {
    validateSemanticOverrides(candidate);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expectedMessage)) {
      fail(`${label}: unexpected error ${String(error)}`);
    }
    rejected = true;
  }
  if (!rejected) fail(`${label}: mutation was accepted`);
}

function shaderInterfaceValueKey(value, includeBlendSource) {
  if (Object.hasOwn(value, "location")) {
    const blendSource =
      includeBlendSource && Object.hasOwn(value, "blendSource")
        ? value.blendSource
        : "none";
    return `location:${value.location}:blend-source:${blendSource}`;
  }
  return `builtin:${value.builtin}`;
}

function compareShaderInterfaceValues(left, right, includeBlendSource) {
  const leftHasLocation = Object.hasOwn(left, "location");
  const rightHasLocation = Object.hasOwn(right, "location");
  if (leftHasLocation !== rightHasLocation) return leftHasLocation ? -1 : 1;
  if (leftHasLocation) {
    if (left.location !== right.location) return left.location - right.location;
    const blendRank = (value) =>
      includeBlendSource && Object.hasOwn(value, "blendSource")
        ? value.blendSource + 1
        : 0;
    return blendRank(left) - blendRank(right);
  }
  return left.builtin < right.builtin
    ? -1
    : left.builtin > right.builtin
    ? 1
    : 0;
}

function resolveShaderInterfaceType(semantic, value, owner) {
  const type = semantic.types[value.type];
  if (!type) {
    fail(`${owner} references unknown shader interface type ${value.type}`);
  }
  if (type.kind === "scalar") {
    return { component: type.scalar, width: 1 };
  }
  if (type.kind === "vector") {
    const element = semantic.types[type.element];
    if (element?.kind === "scalar") {
      return { component: element.scalar, width: type.width };
    }
  }
  fail(
    `${owner} type ${value.type} must resolve to a scalar or vector of scalars`
  );
}

function shaderInterfaceTypeKey(shape) {
  return `${shape.component}x${shape.width}`;
}

const requiredBuiltinTypeKeys = new Map([
  ["vertex:inputs:vertex_index", "u32x1"],
  ["vertex:inputs:instance_index", "u32x1"],
  ["vertex:outputs:position", "f32x4"],
  ["fragment:inputs:position", "f32x4"],
  ["fragment:inputs:front_facing", "boolx1"],
  ["fragment:inputs:sample_index", "u32x1"],
  ["fragment:inputs:sample_mask", "u32x1"],
  ["fragment:outputs:frag_depth", "f32x1"],
  ["fragment:outputs:sample_mask", "u32x1"],
  ["compute:inputs:local_invocation_id", "u32x3"],
  ["compute:inputs:local_invocation_index", "u32x1"],
  ["compute:inputs:global_invocation_id", "u32x3"],
  ["compute:inputs:workgroup_id", "u32x3"],
  ["compute:inputs:num_workgroups", "u32x3"],
]);

function validateSemanticInterfaceValues(semantic, program, entry, direction) {
  const values = entry[direction];
  const owner = `${program.name}/${entry.stage} ${direction}`;
  const includeBlendSource =
    entry.stage === "fragment" && direction === "outputs";
  const keys = new Set();
  let previous;
  for (const value of values) {
    const key = shaderInterfaceValueKey(value, includeBlendSource);
    if (keys.has(key)) fail(`${owner} repeats shader interface value ${key}`);
    if (
      previous !== undefined &&
      compareShaderInterfaceValues(previous, value, includeBlendSource) >= 0
    ) {
      fail(`${owner} shader interface values are not canonically ordered`);
    }
    keys.add(key);
    previous = value;

    const shape = resolveShaderInterfaceType(semantic, value, owner);
    const shapeKey = shaderInterfaceTypeKey(shape);
    if (Object.hasOwn(value, "location")) {
      if (shape.component === "bool") {
        fail(`${owner} user location ${value.location} cannot use bool`);
      }
      const isInterStageValue =
        (entry.stage === "vertex" && direction === "outputs") ||
        (entry.stage === "fragment" && direction === "inputs");
      if (
        isInterStageValue &&
        ["i32", "u32"].includes(shape.component) &&
        value.interpolation?.type !== "flat"
      ) {
        fail(
          `${owner} integer user location ${value.location} requires flat interpolation`
        );
      }
      continue;
    }

    const builtinKey = `${entry.stage}:${direction}:${value.builtin}`;
    const requiredTypeKey = requiredBuiltinTypeKeys.get(builtinKey);
    if (!requiredTypeKey) {
      fail(`${owner} has unsupported builtin ${value.builtin}`);
    }
    if (shapeKey !== requiredTypeKey) {
      fail(
        `${owner} builtin ${value.builtin} requires ${requiredTypeKey}, received ${shapeKey}`
      );
    }
  }
}

function validateSemanticStageLink(semantic, program) {
  const entries = Object.values(program.entryPoints);
  for (const entry of entries) {
    validateSemanticInterfaceValues(semantic, program, entry, "inputs");
    validateSemanticInterfaceValues(semantic, program, entry, "outputs");
    if (
      entry.stage === "vertex" &&
      entry.outputs.filter((value) => value.builtin === "position").length !== 1
    ) {
      fail(`${program.name} vertex entry requires exactly one position output`);
    }
  }

  const fragment = entries.find((entry) => entry.stage === "fragment");
  if (!fragment) return;
  const vertex = entries.find((entry) => entry.stage === "vertex");
  if (!vertex) fail(`${program.name} fragment entry has no vertex entry`);

  const vertexOutputs = new Map(
    vertex.outputs
      .filter((value) => Object.hasOwn(value, "location"))
      .map((value) => [value.location, value])
  );
  for (const input of fragment.inputs.filter((value) =>
    Object.hasOwn(value, "location")
  )) {
    const output = vertexOutputs.get(input.location);
    if (!output) {
      fail(
        `${program.name} fragment location ${input.location} has no vertex output`
      );
    }
    const outputType = shaderInterfaceTypeKey(
      resolveShaderInterfaceType(
        semantic,
        output,
        `${program.name}/vertex outputs`
      )
    );
    const inputType = shaderInterfaceTypeKey(
      resolveShaderInterfaceType(
        semantic,
        input,
        `${program.name}/fragment inputs`
      )
    );
    if (
      outputType !== inputType ||
      canonicalize(output.interpolation) !== canonicalize(input.interpolation)
    ) {
      fail(
        `${program.name} location ${input.location} has an incompatible stage link`
      );
    }
  }

  const colors = fragment.outputs.filter((value) =>
    Object.hasOwn(value, "location")
  );
  const dualSourceColors = colors.filter((value) =>
    Object.hasOwn(value, "blendSource")
  );
  if (dualSourceColors.length === 0) return;
  const sources = dualSourceColors.map((value) => value.blendSource).sort();
  if (
    colors.length !== 2 ||
    dualSourceColors.length !== 2 ||
    dualSourceColors.some((value) => value.location !== 0) ||
    sources[0] !== 0 ||
    sources[1] !== 1 ||
    shaderInterfaceTypeKey(
      resolveShaderInterfaceType(
        semantic,
        dualSourceColors[0],
        `${program.name}/fragment outputs`
      )
    ) !==
      shaderInterfaceTypeKey(
        resolveShaderInterfaceType(
          semantic,
          dualSourceColors[1],
          `${program.name}/fragment outputs`
        )
      )
  ) {
    fail(`${program.name} has an invalid dual-source fragment interface`);
  }
}

function validateShaderInterfaceContract(semantic, projection) {
  if (
    projection.abi?.shaderInterfaceModel !== "vgpu-metal-shader-interface-v1"
  ) {
    fail("unsupported shader-interface model");
  }

  const semanticPrograms = new Map();
  let previousSemanticProgramName;
  for (const semanticProgram of semantic.programs) {
    const canonicalProgramName = semanticProgram.name.normalize("NFC");
    if (semanticPrograms.has(canonicalProgramName)) {
      fail(`semantic contract repeats program ${semanticProgram.name}`);
    }
    if (
      previousSemanticProgramName !== undefined &&
      compareCanonicalStrings(
        previousSemanticProgramName,
        semanticProgram.name
      ) >= 0
    ) {
      fail("semantic programs are not canonically name ordered");
    }
    previousSemanticProgramName = semanticProgram.name;
    semanticPrograms.set(canonicalProgramName, semanticProgram);
    validateSemanticStageLink(semantic, semanticProgram);
  }

  const projectedProgramNames = new Set();
  let previousProgramName;
  for (const program of projection.programs) {
    const canonicalProgramName = program.semanticProgram.normalize("NFC");
    if (projectedProgramNames.has(canonicalProgramName)) {
      fail(`Metal projection repeats program ${program.semanticProgram}`);
    }
    projectedProgramNames.add(canonicalProgramName);
    if (
      previousProgramName !== undefined &&
      compareCanonicalStrings(previousProgramName, program.semanticProgram) >= 0
    ) {
      fail("Metal projection programs are not canonically name ordered");
    }
    previousProgramName = program.semanticProgram;
  }
  const semanticProgramNames = [...semanticPrograms.keys()].sort(
    compareCanonicalStrings
  );
  const canonicalProjectedProgramNames = [...projectedProgramNames].sort(
    compareCanonicalStrings
  );
  if (
    canonicalize(semanticProgramNames) !==
    canonicalize(canonicalProjectedProgramNames)
  ) {
    fail("semantic and Metal projection program sets are not bijective");
  }

  for (const program of projection.programs) {
    const semanticProgram = semanticPrograms.get(
      program.semanticProgram.normalize("NFC")
    );
    if (!semanticProgram) {
      fail(
        `shader-interface contract references unknown program ${program.semanticProgram}`
      );
    }
    const semanticEntries = Object.values(semanticProgram.entryPoints);
    if (program.entryPoints.length !== semanticEntries.length) {
      fail(`${program.semanticProgram} has an incomplete projected entry set`);
    }

    let previousStageRank = -1;
    const projectedEntries = new Set();
    for (const entry of program.entryPoints) {
      const stageRank = canonicalStageOrder.indexOf(entry.stage);
      if (stageRank < 0 || stageRank <= previousStageRank) {
        fail(
          `${program.semanticProgram} entry points are not canonically stage ordered`
        );
      }
      previousStageRank = stageRank;
      const entryKey = `${entry.stage}:${entry.wgsl}`;
      if (projectedEntries.has(entryKey)) {
        fail(`${program.semanticProgram} repeats projected entry ${entryKey}`);
      }
      projectedEntries.add(entryKey);

      const semanticEntry = semanticEntries.find(
        (candidate) =>
          candidate.stage === entry.stage && candidate.names.wgsl === entry.wgsl
      );
      if (!semanticEntry) {
        fail(
          `${program.semanticProgram} projects unknown entry ${entry.stage}/${entry.wgsl}`
        );
      }
      if (entry.interface?.kind !== entry.stage) {
        fail(
          `${program.semanticProgram}/${entry.wgsl} interface kind disagrees with its stage`
        );
      }

      if (entry.stage === "vertex") {
        const expected = semanticEntry.inputs
          .filter((value) => Object.hasOwn(value, "location"))
          .sort((left, right) => left.location - right.location);
        const actual = entry.interface.attributes;
        if (actual.length !== expected.length) {
          fail(
            `${program.semanticProgram}/${entry.wgsl} vertex attribute map is not bijective`
          );
        }
        const metalAttributes = new Set();
        for (let index = 0; index < expected.length; index += 1) {
          const expectedLocation = expected[index].location;
          const projected = actual[index];
          if (projected.semantic.location !== expectedLocation) {
            fail(
              `${program.semanticProgram}/${entry.wgsl} vertex attributes are not canonical or exact`
            );
          }
          if (projected.metal.attribute !== expectedLocation) {
            fail(
              `${program.semanticProgram}/${entry.wgsl} remaps vertex location ${expectedLocation} in interface model v1`
            );
          }
          if (metalAttributes.has(projected.metal.attribute)) {
            fail(
              `${program.semanticProgram}/${entry.wgsl} repeats Metal attribute ${projected.metal.attribute}`
            );
          }
          metalAttributes.add(projected.metal.attribute);
        }
      } else if (entry.stage === "fragment") {
        const rank = (value) =>
          value.location * 3 +
          (Object.hasOwn(value, "blendSource") ? value.blendSource + 1 : 0);
        const expected = semanticEntry.outputs
          .filter((value) => Object.hasOwn(value, "location"))
          .sort((left, right) => rank(left) - rank(right));
        const actual = entry.interface.colorOutputs;
        if (actual.length !== expected.length) {
          fail(
            `${program.semanticProgram}/${entry.wgsl} fragment color map is not bijective`
          );
        }
        const metalColors = new Set();
        for (let index = 0; index < expected.length; index += 1) {
          const expectedValue = expected[index];
          const projected = actual[index];
          const expectedHasSource = Object.hasOwn(expectedValue, "blendSource");
          const projectedHasSource = Object.hasOwn(
            projected.semantic,
            "blendSource"
          );
          const metalHasIndex = Object.hasOwn(projected.metal, "index");
          if (
            projected.semantic.location !== expectedValue.location ||
            expectedHasSource !== projectedHasSource ||
            expectedHasSource !== metalHasIndex ||
            (expectedHasSource &&
              (projected.semantic.blendSource !== expectedValue.blendSource ||
                projected.metal.index !== expectedValue.blendSource))
          ) {
            fail(
              `${program.semanticProgram}/${entry.wgsl} fragment colors are not canonical or exact`
            );
          }
          if (projected.metal.color !== expectedValue.location) {
            fail(
              `${program.semanticProgram}/${entry.wgsl} remaps fragment location ${expectedValue.location} in interface model v1`
            );
          }
          const physicalKey = `${projected.metal.color}:${
            projected.metal.index ?? 0
          }`;
          if (metalColors.has(physicalKey)) {
            fail(
              `${program.semanticProgram}/${entry.wgsl} repeats Metal color ${physicalKey}`
            );
          }
          metalColors.add(physicalKey);
        }
      }
    }
  }
}

function requireShaderInterfaceMutationFailure(
  semantic,
  projection,
  mutate,
  expectedMessage,
  label
) {
  const semanticCandidate = clone(semantic);
  const projectionCandidate = clone(projection);
  mutate(semanticCandidate, projectionCandidate);
  let rejected = false;
  try {
    validateShaderInterfaceContract(semanticCandidate, projectionCandidate);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expectedMessage)) {
      fail(`${label}: unexpected error ${String(error)}`);
    }
    rejected = true;
  }
  if (!rejected) fail(`${label}: mutation was accepted`);
}

function validateStorageBufferSizeContract(semantic, projection) {
  const semanticPrograms = new Map(
    semantic.programs.map((program) => [program.name, program])
  );
  const ceiling = projection.vertexBufferPolicy.externalBufferCeiling;

  for (const program of projection.programs) {
    const semanticProgram = semanticPrograms.get(program.semanticProgram);
    if (!semanticProgram) {
      fail(
        `storage-size contract references unknown program ${program.semanticProgram}`
      );
    }
    if (!Array.isArray(program.storageBufferSizeRegions)) {
      fail(
        `${program.semanticProgram} has no canonical storage-buffer-size region array`
      );
    }

    let previousStageRank = -1;
    const observedStages = new Set();
    for (const region of program.storageBufferSizeRegions) {
      const stageRank = canonicalStageOrder.indexOf(region.stage);
      if (observedStages.has(region.stage)) {
        fail(
          `${program.semanticProgram} repeats storage-buffer-size stage ${region.stage}`
        );
      }
      if (stageRank < 0 || stageRank <= previousStageRank) {
        fail(
          `${program.semanticProgram} storage-buffer-size regions are not canonically stage ordered`
        );
      }
      observedStages.add(region.stage);
      previousStageRank = stageRank;

      if (
        !Number.isSafeInteger(region.immediateDataByteOffset) ||
        region.immediateDataByteOffset < 0 ||
        region.immediateDataByteOffset > 0xffffffff ||
        region.immediateDataByteOffset % 4 !== 0
      ) {
        fail(
          `${program.semanticProgram}/${region.stage} has an invalid immediate-data byte offset`
        );
      }

      const activeBindingIds = new Set(
        Object.values(semanticProgram.entryPoints)
          .filter((entry) => entry.stage === region.stage)
          .flatMap((entry) => entry.bindings)
      );
      const hasActiveRuntimeStorage = semanticProgram.bindings.some(
        (binding) => {
          if (
            !activeBindingIds.has(binding.id) ||
            binding.kind !== "buffer" ||
            binding.addressSpace !== "storage" ||
            !binding.visibility.includes(region.stage) ||
            semantic.layouts[binding.layout]?.runtimeSized !== true
          ) {
            return false;
          }
          return program.bindings.some(
            (projected) =>
              projected.semanticBinding === binding.id &&
              projected.slots.some(
                (slot) =>
                  slot.stage === region.stage &&
                  slot.mode === "direct" &&
                  slot.resourceClass === "buffer" &&
                  slot.component === "buffer" &&
                  slot.count === 1
              )
          );
        }
      );
      if (!hasActiveRuntimeStorage) {
        fail(
          `${program.semanticProgram}/${region.stage} region has no active runtime-sized storage binding`
        );
      }

      const matchingImmediateSlots = program.internalBindings
        .filter((binding) => binding.role === "immediate-data")
        .flatMap((binding) => binding.slots)
        .filter((slot) => slot.stage === region.stage);
      if (matchingImmediateSlots.length !== 1) {
        fail(
          `${program.semanticProgram}/${region.stage} region needs exactly one immediate-data slot`
        );
      }
      const [slot] = matchingImmediateSlots;
      if (
        slot.mode !== "direct" ||
        slot.resourceClass !== "buffer" ||
        slot.component !== "buffer" ||
        slot.count !== 1
      ) {
        fail(
          `${program.semanticProgram}/${region.stage} has an incompatible immediate-data slot`
        );
      }
      if (region.stage === "vertex" && slot.index < ceiling) {
        fail(
          `${program.semanticProgram}/${region.stage} immediate-data starts below the vertex-buffer ceiling`
        );
      }
      const overlapsExternalBuffer = program.bindings.some((binding) =>
        binding.slots.some(
          (external) =>
            external.stage === region.stage &&
            external.resourceClass === "buffer" &&
            slot.index < external.index + external.count &&
            external.index < slot.index + slot.count
        )
      );
      if (overlapsExternalBuffer) {
        fail(
          `${program.semanticProgram}/${region.stage} immediate-data overlaps an external buffer slot`
        );
      }
      const overlapsInternalBuffer = program.internalBindings.some((binding) =>
        binding.slots.some(
          (other) =>
            other !== slot &&
            other.stage === region.stage &&
            other.resourceClass === "buffer" &&
            slot.index < other.index + other.count &&
            other.index < slot.index + slot.count
        )
      );
      if (overlapsInternalBuffer) {
        fail(
          `${program.semanticProgram}/${region.stage} immediate-data overlaps another internal buffer slot`
        );
      }
    }
  }
}

function requireStorageContractMutationFailure(
  semantic,
  projection,
  mutate,
  expectedMessage,
  label
) {
  const semanticCandidate = clone(semantic);
  const projectionCandidate = clone(projection);
  mutate(semanticCandidate, projectionCandidate);
  let rejected = false;
  try {
    validateStorageBufferSizeContract(semanticCandidate, projectionCandidate);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expectedMessage)) {
      fail(`${label}: unexpected error ${String(error)}`);
    }
    rejected = true;
  }
  if (!rejected) fail(`${label}: mutation was accepted`);
}

function requireVertexPolicyMutationFailure(
  projection,
  mutate,
  expectedMessage,
  label
) {
  const candidate = clone(projection);
  mutate(candidate);
  let rejected = false;
  try {
    validateVertexBufferPolicy(candidate);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expectedMessage)) {
      fail(`${label}: unexpected error ${String(error)}`);
    }
    rejected = true;
  }
  if (!rejected) fail(`${label}: mutation was accepted`);
}

function walk(root) {
  const files = [];
  const visit = (directory) => {
    const names = readdirSync(directory).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    for (const name of names) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        fail(`generated tree contains a symlink: ${path}`);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) files.push(path);
      else fail(`generated tree contains a special filesystem entry: ${path}`);
    }
  };
  visit(root);
  return files;
}

function walkDirectories(root) {
  const directories = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        fail(`generated tree contains a symlink: ${path}`);
      if (metadata.isDirectory()) {
        directories.push(path);
        visit(path);
      }
    }
  };
  visit(root);
  return directories;
}

function resolveJSONPointer(document, fragment) {
  if (fragment === "" || fragment === undefined) return document;
  if (!fragment.startsWith("/"))
    fail(`unsupported JSON Schema fragment #${fragment}`);
  return fragment
    .slice(1)
    .split("/")
    .map((part) =>
      decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~")
    )
    .reduce((value, part) => {
      if (value === undefined || value === null || !(part in value)) {
        fail(`unresolved JSON Schema pointer #${fragment}`);
      }
      return value[part];
    }, document);
}

function checkSchemaReferences(schemas) {
  const byId = new Map(schemas.map((schema) => [schema.$id, schema]));
  if (byId.size !== schemas.length)
    fail("JSON Schema $id values are not unique");
  let references = 0;

  const visit = (value, currentSchema) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, currentSchema);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (typeof value.$ref === "string") {
      references += 1;
      const [externalId, fragment] = value.$ref.split("#", 2);
      const target = externalId === "" ? currentSchema : byId.get(externalId);
      if (!target)
        fail(`unresolved external JSON Schema reference ${value.$ref}`);
      resolveJSONPointer(target, fragment);
    }
    for (const child of Object.values(value)) visit(child, currentSchema);
  };

  for (const schema of schemas) visit(schema, schema);
  return references;
}

const options = parseArguments(process.argv.slice(2));
const packageRoot = realpathSync(options.packageRoot);
const artifactPath = join(packageRoot, "artifact.json");
const artifactBytes = readFileSync(artifactPath);
const artifact = JSON.parse(artifactBytes);

const schemaDirectory = join(
  options.repository,
  "docs",
  "plans",
  "native",
  "contracts"
);
const schemaFilenames = [
  "semantic-v1.schema.json",
  "metal-projection-v1.schema.json",
  "artifact-v1.schema.json",
  "metal-runner-request-v1.schema.json",
  "metal-runner-response-v1.schema.json",
];
const schemas = schemaFilenames.map((filename) =>
  JSON.parse(readFileSync(join(schemaDirectory, filename), "utf8"))
);
const referenceCount = checkSchemaReferences(schemas);
const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of schemas) ajv.addSchema(schema);
for (const schema of schemas) {
  if (!ajv.getSchema(schema.$id)) fail(`Ajv did not compile ${schema.$id}`);
}
const validateArtifact = ajv.getSchema(artifact.$schema);
if (!validateArtifact) fail(`no validator for ${artifact.$schema}`);
if (!validateArtifact(artifact)) {
  fail(
    `artifact schema failure:\n${ajv.errorsText(validateArtifact.errors, {
      separator: "\n",
    })}`
  );
}
validateSemanticOverrides(artifact.semantic);
const futureStorageSizeModelArtifact = clone(artifact);
futureStorageSizeModelArtifact.projection.storageBufferSizeModel =
  artifact.projection.storageBufferSizeModel.endsWith("-v999")
    ? "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v998"
    : "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v999";
if (!validateArtifact(futureStorageSizeModelArtifact)) {
  fail(
    `future storage-buffer-size model must remain structurally valid for conditional runtime checks:\n${ajv.errorsText(
      validateArtifact.errors,
      { separator: "\n" }
    )}`
  );
}
const finiteOverrideArtifact = clone(artifact);
const finiteOverrideProgram = requireSemanticProgram(
  finiteOverrideArtifact.semantic,
  "Noop"
);
finiteOverrideProgram.overrides.push(
  {
    names: { authored: "FIXTURE_F16", wgsl: "FIXTURE_F16" },
    swiftName: "fixtureF16",
    wgslId: 17,
    type: "f16",
    default: { type: "f16", bits: "7bff" },
    selected: { type: "f16", bits: "8000" },
  },
  {
    names: { authored: "FIXTURE_F32", wgsl: "FIXTURE_F32" },
    swiftName: "fixtureF32",
    type: "f32",
    default: { type: "f32", bits: "7f7fffff" },
    selected: { type: "f32", bits: "80000000" },
  }
);
if (!validateArtifact(finiteOverrideArtifact)) {
  fail(
    `finite override edge values must remain structurally valid:\n${ajv.errorsText(
      validateArtifact.errors,
      { separator: "\n" }
    )}`
  );
}
validateSemanticOverrides(finiteOverrideArtifact.semantic);
requireSemanticOverrideMutationFailure(
  finiteOverrideArtifact.semantic,
  (semantic) => {
    const overrides = requireSemanticProgram(semantic, "Noop").overrides;
    overrides.find(
      (override) => override.names.wgsl === "FIXTURE_F16"
    ).names.wgsl = "C3_WORKGROUP_X";
  },
  "repeats override",
  "duplicate semantic override name"
);
requireSemanticOverrideMutationFailure(
  finiteOverrideArtifact.semantic,
  (semantic) => {
    requireSemanticProgram(semantic, "Noop").overrides.reverse();
  },
  "not canonically name ordered",
  "non-canonical semantic override order"
);
requireSemanticOverrideMutationFailure(
  finiteOverrideArtifact.semantic,
  (semantic) => {
    const overrides = requireSemanticProgram(semantic, "Noop").overrides;
    overrides.find(
      (override) => override.names.wgsl === "FIXTURE_F16"
    ).wgslId = 7;
  },
  "repeats authored WGSL override ID",
  "duplicate authored WGSL override ID"
);
for (const [name, label] of [
  ["NOT VALID", "override WGSL name containing whitespace"],
  ["ÉXITO", "non-ASCII override WGSL name"],
  [`A${"a".repeat(256)}`, "overlong override WGSL name"],
]) {
  requireSemanticOverrideMutationFailure(
    finiteOverrideArtifact.semantic,
    (semantic) => {
      requireSemanticProgram(semantic, "Noop").overrides[0].names.wgsl = name;
    },
    "invalid override WGSL name",
    label
  );
}
for (const [label, mutate] of [
  [
    "missing storage-buffer-size model",
    (candidate) => {
      delete candidate.projection.storageBufferSizeModel;
    },
  ],
  [
    "missing shader-interface model",
    (candidate) => {
      delete candidate.projection.abi.shaderInterfaceModel;
    },
  ],
  [
    "unknown shader-interface model",
    (candidate) => {
      candidate.projection.abi.shaderInterfaceModel =
        "vgpu-metal-shader-interface-v2";
    },
  ],
  [
    "missing entry interface",
    (candidate) => {
      delete candidate.projection.programs[0].entryPoints[0].interface;
    },
  ],
  [
    "entry interface kind mismatch",
    (candidate) => {
      candidate.projection.programs[0].entryPoints[0].interface = {
        kind: "vertex",
        attributes: [],
      };
    },
  ],
  [
    "compute entry with vertex attributes",
    (candidate) => {
      candidate.projection.programs[0].entryPoints[0].interface.attributes = [];
    },
  ],
  [
    "vertex input interpolation",
    (candidate) => {
      candidate.semantic.programs[2].entryPoints.vertex.inputs.find(
        (value) => value.location === 3
      ).interpolation = {
        type: "perspective",
        sampling: "center",
      };
    },
  ],
  [
    "missing normalized vertex output interpolation",
    (candidate) => {
      delete candidate.semantic.programs[2].entryPoints.vertex.outputs.find(
        (value) => value.location === 2
      ).interpolation;
    },
  ],
  [
    "invalid flat interpolation sampling",
    (candidate) => {
      candidate.semantic.programs[2].entryPoints.fragment.inputs.find(
        (value) => value.location === 5
      ).interpolation.sampling = "center";
    },
  ],
  [
    "fragment blend source outside location zero",
    (candidate) => {
      candidate.semantic.programs[2].entryPoints.fragment.outputs[0].blendSource = 0;
    },
  ],
  [
    "fragment projection with unmatched blend source",
    (candidate) => {
      candidate.projection.programs[2].entryPoints[1].interface.colorOutputs[0].semantic.blendSource = 0;
    },
  ],
  [
    "compute output value",
    (candidate) => {
      candidate.semantic.programs[0].entryPoints.compute.outputs.push({
        type: "u32",
        invariant: false,
        builtin: "sample_mask",
      });
    },
  ],
  [
    "missing canonical region array",
    (candidate) => {
      delete candidate.projection.programs[0].storageBufferSizeRegions;
    },
  ],
  [
    "misaligned immediate-data offset",
    (candidate) => {
      candidate.projection.programs[1].storageBufferSizeRegions[0].immediateDataByteOffset = 2;
    },
  ],
  [
    "duplicate storage-buffer-size stage",
    (candidate) => {
      candidate.projection.programs[1].storageBufferSizeRegions.push({
        stage: "compute",
        immediateDataByteOffset: 8,
      });
    },
  ],
  [
    "serialized storage-buffer-size word count",
    (candidate) => {
      candidate.projection.programs[1].storageBufferSizeRegions[0].wordCount = 1;
    },
  ],
  [
    "serialized dynamic storage-buffer range",
    (candidate) => {
      candidate.projection.programs[1].storageBufferSizeRegions[0].rangeBytes = 4;
    },
  ],
  [
    "redundant storage-buffer-size boolean",
    (candidate) => {
      candidate.projection.programs[1].needsStorageBufferSizes = true;
    },
  ],
  [
    "legacy ambiguous interface locations",
    (candidate) => {
      candidate.projection.programs[0].entryPoints[0].interfaceLocations = [];
    },
  ],
  [
    "legacy literal workgroup component provenance",
    (candidate) => {
      candidate.semantic.programs[0].entryPoints.compute.workgroupSize.x = {
        kind: "literal",
        value: 4,
      };
    },
  ],
  [
    "legacy override workgroup component provenance",
    (candidate) => {
      candidate.semantic.programs[0].entryPoints.compute.workgroupSize.x = {
        kind: "override",
        override: "fixture_workgroup_x",
        value: 4,
      };
    },
  ],
  [
    "zero resolved semantic workgroup axis",
    (candidate) => {
      candidate.semantic.programs[0].entryPoints.compute.workgroupSize.x = 0;
    },
  ],
  [
    "emitted entry name outside the vgpu domain",
    (candidate) => {
      candidate.projection.programs[0].entryPoints[0].metal = "thread";
    },
  ],
  [
    "multiple direct components for one semantic binding",
    (candidate) => {
      candidate.projection.programs[0].bindings[0].slots.push({
        stage: "compute",
        mode: "direct",
        resourceClass: "texture",
        component: "texture",
        index: 0,
        count: 1,
      });
    },
  ],
  [
    "compute external binding with a vertex slot",
    (candidate) => {
      candidate.projection.programs.find(
        (program) => program.semanticProgram === "Noop"
      ).bindings[0].slots[0].stage = "vertex";
    },
  ],
  [
    "compute internal binding with a vertex slot",
    (candidate) => {
      candidate.projection.programs.find(
        (program) => program.semanticProgram === "RuntimeArray"
      ).internalBindings[0].slots[0].stage = "vertex";
    },
  ],
  [
    "reordered external program slot union",
    (candidate) => {
      candidate.projection.programs
        .find((program) => program.semanticProgram === "SparseDraw")
        .bindings.push({
          semanticBinding: "g0b0",
          slots: [
            {
              stage: "fragment",
              mode: "direct",
              resourceClass: "buffer",
              component: "buffer",
              index: 0,
              count: 1,
            },
            {
              stage: "vertex",
              mode: "direct",
              resourceClass: "buffer",
              component: "buffer",
              index: 0,
              count: 1,
            },
          ],
        });
    },
  ],
  [
    "reordered internal program slot union",
    (candidate) => {
      candidate.projection.programs
        .find((program) => program.semanticProgram === "SparseDraw")
        .internalBindings.push({
          role: "immediate-data",
          slots: [
            {
              stage: "fragment",
              mode: "direct",
              resourceClass: "buffer",
              component: "buffer",
              index: 30,
              count: 1,
            },
            {
              stage: "vertex",
              mode: "direct",
              resourceClass: "buffer",
              component: "buffer",
              index: 30,
              count: 1,
            },
          ],
        });
    },
  ],
  [
    "incoherent direct component",
    (candidate) => {
      candidate.projection.programs[0].bindings[0].slots[0].component =
        "texture";
    },
  ],
  [
    "legacy semantic override id",
    (candidate) => {
      requireSemanticProgram(candidate.semantic, "Noop").overrides[0].id =
        "fixture_bool";
    },
  ],
  [
    "override WGSL name containing whitespace",
    (candidate) => {
      requireSemanticProgram(
        candidate.semantic,
        "Noop"
      ).overrides[0].names.wgsl = "NOT VALID";
    },
  ],
  [
    "non-ASCII override WGSL name",
    (candidate) => {
      requireSemanticProgram(
        candidate.semantic,
        "Noop"
      ).overrides[0].names.wgsl = "ÉXITO";
    },
  ],
  [
    "overlong override WGSL name",
    (candidate) => {
      requireSemanticProgram(
        candidate.semantic,
        "Noop"
      ).overrides[0].names.wgsl = `A${"a".repeat(256)}`;
    },
  ],
  [
    "non-finite f16 override",
    (candidate) => {
      candidate.semantic.programs[0].overrides.push({
        names: { authored: "FIXTURE_F16", wgsl: "FIXTURE_F16" },
        swiftName: "fixtureF16",
        type: "f16",
        default: { type: "f16", bits: "7c00" },
        selected: { type: "f16", bits: "7c00" },
      });
    },
  ],
  [
    "non-finite f32 override",
    (candidate) => {
      candidate.semantic.programs[0].overrides.push({
        names: { authored: "FIXTURE_F32", wgsl: "FIXTURE_F32" },
        swiftName: "fixtureF32",
        type: "f32",
        default: { type: "f32", bits: "ff800000" },
        selected: { type: "f32", bits: "ff800000" },
      });
    },
  ],
]) {
  const candidate = clone(artifact);
  mutate(candidate);
  if (validateArtifact(candidate)) {
    fail(`artifact schema accepted ${label}`);
  }
}
if ("testing" in artifact.projection) {
  fail("C3 projection must not claim a compare runner");
}

const forbiddenExtensions = new Set([
  ".wgsl",
  ".metal",
  ".msl",
  ".air",
  ".js",
  ".mjs",
  ".cjs",
]);
const excluded = new Set(["artifact.json", ".vgpu-native-output.json"]);
const observedPaths = [];
const allPackagePaths = [];
const caseFoldedPaths = new Set();
for (const path of walk(packageRoot)) {
  const normalized = relative(packageRoot, path)
    .split(sep)
    .join("/")
    .normalize("NFC");
  if (normalized.includes("__"))
    fail(`unresolved placeholder in path ${normalized}`);
  const folded = normalized.toLocaleLowerCase("en-US");
  if (caseFoldedPaths.has(folded))
    fail(`case-insensitive path collision at ${normalized}`);
  caseFoldedPaths.add(folded);
  if (forbiddenExtensions.has(extname(normalized).toLowerCase())) {
    fail(`forbidden generated source/intermediate ${normalized}`);
  }
  if (
    /(^|\/)(?:\.build|\.swiftpm)(\/|$)/.test(normalized) ||
    normalized === "Package.resolved"
  ) {
    fail(`generated tree contains build or resolution residue ${normalized}`);
  }
  allPackagePaths.push(normalized);
  if (!excluded.has(normalized)) observedPaths.push(normalized);
}
allPackagePaths.sort((left, right) =>
  left < right ? -1 : left > right ? 1 : 0
);
const allowedPackagePaths = [
  ".vgpu-native-output.json",
  "Package.swift",
  "Sources/AppShaders/AppShaders.generated.swift",
  "Sources/AppShaders/Resources/AppShaders.metallib",
  "Sources/AppShadersC3MetalProbe/main.swift",
  "Tests/AppShadersTests/ArtifactCompatibilityTests.swift",
  "Tests/AppShadersTests/MutationMatrix.generated.swift",
  "artifact.json",
].sort();
const observedDirectories = walkDirectories(packageRoot)
  .map((path) =>
    relative(packageRoot, path).split(sep).join("/").normalize("NFC")
  )
  .sort();
const allowedDirectories = [
  "Sources",
  "Sources/AppShaders",
  "Sources/AppShaders/Resources",
  "Sources/AppShadersC3MetalProbe",
  "Tests",
  "Tests/AppShadersTests",
].sort();
assertEqual(
  JSON.stringify(observedDirectories),
  JSON.stringify(allowedDirectories),
  "generated package directory allowlist"
);
assertEqual(
  JSON.stringify(allPackagePaths),
  JSON.stringify(allowedPackagePaths),
  "generated package allowlist"
);
observedPaths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

const manifestPaths = artifact.files.map((file) => file.path);
assertEqual(
  JSON.stringify(manifestPaths),
  JSON.stringify(observedPaths),
  "artifact file set"
);
for (const file of artifact.files) {
  const bytes = readFileSync(join(packageRoot, ...file.path.split("/")));
  assertEqual(bytes.byteLength, file.size, `${file.path} size`);
  assertEqual(sha256Bytes(bytes), file.sha256, `${file.path} SHA-256`);
}

for (const input of artifact.inputs) {
  const path = join(options.inputsRoot, ...input.path.split("/"));
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile())
    fail(`invalid input path ${input.path}`);
  const bytes = readFileSync(path);
  assertEqual(bytes.byteLength, input.size, `${input.path} input size`);
  assertEqual(sha256Bytes(bytes), input.sha256, `${input.path} input SHA-256`);
}

const inputIds = new Map();
for (const input of artifact.inputs) {
  if (inputIds.has(input.id)) fail(`duplicate input id ${input.id}`);
  inputIds.set(input.id, input);
}
validateSourceSpans(artifact.semantic, artifact.inputs, options.inputsRoot);
requireSourceSpanMutationFailure(
  artifact.semantic,
  artifact.inputs,
  options.inputsRoot,
  (semantic) => {
    const noop = semantic.programs.find((program) => program.name === "Noop");
    const runtimeArray = semantic.programs.find(
      (program) => program.name === "RuntimeArray"
    );
    noop.sources = [...runtimeArray.sources];
    noop.entryPoints.compute.source = clone(
      runtimeArray.entryPoints.compute.source
    );
  },
  "source span does not contain its WGSL entry declaration",
  "crossed program source span"
);
requireSourceSpanMutationFailure(
  artifact.semantic,
  artifact.inputs,
  options.inputsRoot,
  (semantic) => {
    const noop = semantic.programs.find((program) => program.name === "Noop");
    noop.entryPoints.compute.source.start.line = 999;
  },
  "has an invalid source position",
  "out-of-range source span"
);
const typeIds = new Set(Object.keys(artifact.semantic.types));
const layoutIds = new Set(Object.keys(artifact.semantic.layouts));
const requireType = (type, owner) => {
  if (!typeIds.has(type)) fail(`${owner} references unknown type ${type}`);
};
const requireLayout = (layout, owner) => {
  if (!layoutIds.has(layout))
    fail(`${owner} references unknown layout ${layout}`);
};

for (const [typeId, type] of Object.entries(artifact.semantic.types)) {
  if ("element" in type) requireType(type.element, `type ${typeId}`);
  for (const member of type.members ?? []) {
    requireType(member.type, `type ${typeId} member ${member.name}`);
  }
}
for (const [layoutId, layout] of Object.entries(artifact.semantic.layouts)) {
  requireType(layout.type, `layout ${layoutId}`);
  for (const member of layout.members) {
    requireType(member.type, `layout ${layoutId} member ${member.name}`);
    requireLayout(member.layout, `layout ${layoutId} member ${member.name}`);
  }
}

for (const program of artifact.semantic.programs) {
  assertEqual(
    program.fingerprint.sha256,
    fingerprintProgram(program, artifact.semantic, artifact.inputs),
    `${program.name} fingerprint`
  );
  for (const source of program.sources) {
    const input = inputIds.get(source);
    if (!input || input.role !== "wgsl")
      fail(`${program.name} source ${source} is not a WGSL input`);
  }
  const bindingIds = new Set();
  for (const binding of program.bindings) {
    if (bindingIds.has(binding.id))
      fail(`${program.name} repeats binding ${binding.id}`);
    bindingIds.add(binding.id);
    assertEqual(
      binding.id,
      `g${binding.group}b${binding.binding}`,
      `${program.name} binding identity`
    );
    if (binding.kind === "buffer") {
      requireType(binding.type, `${program.name} binding ${binding.id}`);
      requireLayout(binding.layout, `${program.name} binding ${binding.id}`);
      const layout = artifact.semantic.layouts[binding.layout];
      const expectedMinimumBindingSize = minimumBindingSizeForLayout(
        binding.layout,
        artifact.semantic
      );
      if (binding.minimumBindingSize !== expectedMinimumBindingSize) {
        fail(
          `${program.name} binding ${binding.id} minimum size must be ${expectedMinimumBindingSize}, received ${binding.minimumBindingSize}`
        );
      }
      if (
        layout.runtimeSized &&
        binding.minimumBindingSize === layout.minimumSize
      ) {
        fail(
          `${program.name} binding ${binding.id} collapsed runtime minimumBindingSize to the zero-element layout minimumSize`
        );
      }
    }
  }
  const bindingsById = new Map(
    program.bindings.map((binding) => [binding.id, binding])
  );
  for (const entry of Object.values(program.entryPoints)) {
    if (entry.source && !program.sources.includes(entry.source.input)) {
      fail(
        `${program.name} entry ${entry.names.wgsl} references an undeclared source`
      );
    }
    for (const value of [...entry.inputs, ...entry.outputs]) {
      requireType(
        value.type,
        `${program.name} entry ${entry.names.wgsl} interface ${value.name}`
      );
    }
    for (const binding of entry.bindings) {
      if (!bindingIds.has(binding)) {
        fail(
          `${program.name} entry ${entry.names.wgsl} references unknown binding ${binding}`
        );
      }
    }
    for (const pair of entry.samplingPairs) {
      const texture = bindingsById.get(pair.texture);
      const sampler = bindingsById.get(pair.sampler);
      if (!texture || !["texture", "external-texture"].includes(texture.kind)) {
        fail(
          `${program.name} entry ${entry.names.wgsl} has invalid sampling texture ${pair.texture}`
        );
      }
      if (!sampler || sampler.kind !== "sampler") {
        fail(
          `${program.name} entry ${entry.names.wgsl} has invalid sampling sampler ${pair.sampler}`
        );
      }
    }
  }
  const programFeatures = new Set(program.capabilities.features);
  const rootFeatures = new Set(artifact.semantic.capabilities.features);
  for (const feature of programFeatures) {
    if (!rootFeatures.has(feature))
      fail(
        `${program.name} feature ${feature} is absent from module capabilities`
      );
  }
  const programLanguageFeatures = new Set(
    program.capabilities.languageFeatures
  );
  const rootLanguageFeatures = new Set(
    artifact.semantic.capabilities.languageFeatures
  );
  for (const feature of programLanguageFeatures) {
    if (!rootLanguageFeatures.has(feature)) {
      fail(
        `${program.name} language feature ${feature} is absent from module capabilities`
      );
    }
  }
  assertProgramFingerprintSensitivity(
    program,
    artifact.semantic,
    artifact.inputs
  );
}
assertShaderInterfaceProgramFingerprintSensitivity(
  artifact.semantic,
  artifact.inputs
);
assertRetainedNameProgramFingerprintSensitivity(
  artifact.semantic,
  artifact.inputs
);
assertOverrideProgramFingerprintSensitivity(artifact.semantic, artifact.inputs);

const runtimeArraySemantic = artifact.semantic.programs.find(
  (program) => program.name === "RuntimeArray"
);
const runtimeArraySemanticBinding = runtimeArraySemantic?.bindings.find(
  (binding) => binding.id === "g0b0"
);
const runtimeArrayLayout =
  artifact.semantic.layouts[runtimeArraySemanticBinding?.layout];
if (
  !runtimeArraySemanticBinding ||
  runtimeArrayLayout?.runtimeSized !== true ||
  runtimeArrayLayout.minimumSize !== 4 ||
  runtimeArraySemanticBinding.minimumBindingSize !== 8 ||
  minimumBindingSizeForLayout(
    runtimeArraySemanticBinding.layout,
    artifact.semantic
  ) !== 8
) {
  fail(
    "RuntimeArray must distinguish the zero-element layout minimum from the one-element binding minimum"
  );
}

const semanticSHA256 = sha256Canonical(artifact.semantic);
assertEqual(
  artifact.fingerprints.semantic.sha256,
  semanticSHA256,
  "semantic fingerprint"
);
assertEqual(
  artifact.projection.semantic.sha256,
  semanticSHA256,
  "projection semantic fingerprint"
);
assertEqual(
  artifact.fingerprints.logicalInputs.sha256,
  sha256Canonical(artifact.inputs),
  "logical inputs fingerprint"
);

const libraryPath = artifact.projection.library.path;
const libraries = artifact.files.filter((file) =>
  file.path.endsWith(".metallib")
);
assertEqual(libraries.length, 1, "projected Metal library count");
assertEqual(libraries[0].path, libraryPath, "projected Metal library path");
const runtimeSHA256 = sha256Canonical(
  runtimeProjectionInput(artifact.projection, libraries[0].sha256)
);
validateProjectionSlotEntryStages(artifact.projection);
requireProjectionSlotEntryMutationFailure(
  artifact.projection,
  (projection) => {
    projection.programs.find(
      (program) => program.semanticProgram === "Noop"
    ).bindings[0].slots[0].stage = "vertex";
  },
  "Noop/g0b0 slot stage vertex has no projected entry point",
  "cross-kind external slot"
);
requireProjectionSlotEntryMutationFailure(
  artifact.projection,
  (projection) => {
    const program = projection.programs.find(
      (candidate) => candidate.semanticProgram === "RuntimeArray"
    );
    program.bindings = [];
    program.internalBindings[0].slots[0].stage = "vertex";
  },
  "RuntimeArray/immediate-data slot stage vertex has no projected entry point",
  "cross-kind internal slot"
);
requireProjectionSlotEntryMutationFailure(
  artifact.projection,
  (projection) => {
    const program = projection.programs.find(
      (candidate) => candidate.semanticProgram === "SparseDraw"
    );
    program.entryPoints = program.entryPoints.filter(
      (entry) => entry.stage !== "vertex"
    );
    program.bindings.push({
      semanticBinding: "g0b0",
      slots: [
        {
          stage: "vertex",
          mode: "direct",
          resourceClass: "buffer",
          component: "buffer",
          index: 0,
          count: 1,
        },
      ],
    });
  },
  "SparseDraw/g0b0 slot stage vertex has no projected entry point",
  "missing-entry external slot"
);
requireProjectionSlotEntryMutationFailure(
  artifact.projection,
  (projection) => {
    const program = projection.programs.find(
      (candidate) => candidate.semanticProgram === "SparseDraw"
    );
    program.entryPoints = program.entryPoints.filter(
      (entry) => entry.stage !== "vertex"
    );
    program.internalBindings.push({
      role: "immediate-data",
      slots: [
        {
          stage: "vertex",
          mode: "direct",
          resourceClass: "buffer",
          component: "buffer",
          index: 30,
          count: 1,
        },
      ],
    });
  },
  "SparseDraw/immediate-data slot stage vertex has no projected entry point",
  "missing-entry internal slot"
);
validateVertexBufferPolicy(artifact.projection);
validateStorageBufferSizeContract(artifact.semantic, artifact.projection);
validateResolvedWorkgroupSizes(artifact.semantic, artifact.projection);
validateShaderInterfaceContract(artifact.semantic, artifact.projection);
const equivalentStageLinkTypes = clone(artifact.semantic);
equivalentStageLinkTypes.types.c3_vec2f_alias = clone(
  equivalentStageLinkTypes.types.vec2f
);
equivalentStageLinkTypes.programs
  .find((program) => program.name === "SparseDraw")
  .entryPoints.fragment.inputs.find((value) => value.location === 2).type =
  "c3_vec2f_alias";
validateShaderInterfaceContract(equivalentStageLinkTypes, artifact.projection);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.programs.push(clone(semantic.programs[0]));
  },
  "semantic contract repeats program Noop",
  "duplicate semantic program name"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.programs[0].name = "\u00e9";
    semantic.programs[1].name = "e\u0301";
  },
  "semantic contract repeats program",
  "NFC-equivalent semantic program names"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.programs[0].name = "e\u0301";
    semantic.programs[1].name = "f";
    semantic.programs[2].name = "z";
  },
  "semantic programs are not canonically name ordered",
  "NFC-normalized semantic program order"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.programs.reverse();
  },
  "semantic programs are not canonically name ordered",
  "reordered semantic programs"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    projection.programs.pop();
  },
  "program sets are not bijective",
  "missing projected program"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    projection.programs.push(clone(projection.programs[0]));
  },
  "Metal projection repeats program Noop",
  "duplicate projected program name"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    projection.programs.reverse();
  },
  "programs are not canonically name ordered",
  "reordered projected programs"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.programs
      .find((program) => program.name === "SparseDraw")
      .entryPoints.vertex.inputs.find((value) => value.location === 3).type =
      "c3_missing_interface_type";
  },
  "references unknown shader interface type c3_missing_interface_type",
  "unknown shader-interface type"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.programs
      .find((program) => program.name === "SparseDraw")
      .entryPoints.vertex.inputs.find((value) => value.location === 3).type =
      "u32x4";
  },
  "must resolve to a scalar or vector of scalars",
  "composite shader-interface leaf"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.types.c3_bool = { kind: "scalar", scalar: "bool" };
    semantic.programs
      .find((program) => program.name === "SparseDraw")
      .entryPoints.vertex.inputs.find((value) => value.location === 3).type =
      "c3_bool";
  },
  "user location 3 cannot use bool",
  "boolean user location"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.programs
      .find((program) => program.name === "SparseDraw")
      .entryPoints.vertex.outputs.find(
        (value) => value.builtin === "position"
      ).type = "vec2f";
  },
  "builtin position requires f32x4, received f32x2",
  "wrong vertex-position builtin type"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    const vertex = semantic.programs.find(
      (program) => program.name === "SparseDraw"
    ).entryPoints.vertex;
    vertex.outputs = vertex.outputs.filter(
      (value) => value.builtin !== "position"
    );
  },
  "vertex entry requires exactly one position output",
  "vertex entry without position output"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.programs
      .find((program) => program.name === "Noop")
      .entryPoints.compute.inputs.push({
        type: "u32",
        invariant: false,
        builtin: "global_invocation_id",
      });
  },
  "builtin global_invocation_id requires u32x3, received u32x1",
  "wrong compute builtin type"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    const outputs = semantic.programs.find(
      (program) => program.name === "SparseDraw"
    ).entryPoints.vertex.outputs;
    outputs.unshift(outputs.pop());
  },
  "shader interface values are not canonically ordered",
  "builtin-first semantic vertex outputs"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.programs
      .find((program) => program.name === "SparseDraw")
      .entryPoints.vertex.inputs.reverse();
  },
  "shader interface values are not canonically ordered",
  "descending semantic vertex input locations"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    projection.programs
      .find((program) => program.semanticProgram === "SparseDraw")
      .entryPoints.find((entry) => entry.stage === "vertex")
      .interface.attributes.pop();
  },
  "vertex attribute map is not bijective",
  "missing vertex attribute projection"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    projection.programs
      .find((program) => program.semanticProgram === "SparseDraw")
      .entryPoints.find((entry) => entry.stage === "vertex")
      .interface.attributes.reverse();
  },
  "vertex attributes are not canonical or exact",
  "reordered sparse vertex attributes"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    projection.programs
      .find((program) => program.semanticProgram === "SparseDraw")
      .entryPoints.find(
        (entry) => entry.stage === "vertex"
      ).interface.attributes[0].metal.attribute = 0;
  },
  "remaps vertex location 3",
  "compacted sparse vertex attribute"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    projection.programs
      .find((program) => program.semanticProgram === "SparseDraw")
      .entryPoints.find((entry) => entry.stage === "fragment")
      .interface.colorOutputs.pop();
  },
  "fragment color map is not bijective",
  "missing fragment color projection"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    projection.programs
      .find((program) => program.semanticProgram === "SparseDraw")
      .entryPoints.find(
        (entry) => entry.stage === "fragment"
      ).interface.colorOutputs[1].metal.color = 2;
  },
  "remaps fragment location 4",
  "compacted sparse fragment color"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.programs
      .find((program) => program.name === "SparseDraw")
      .entryPoints.fragment.inputs.find((value) => value.location === 2).type =
      "f32";
  },
  "location 2 has an incompatible stage link",
  "stage-link type mismatch"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.programs
      .find((program) => program.name === "SparseDraw")
      .entryPoints.fragment.inputs.find(
        (value) => value.location === 2
      ).interpolation.sampling = "sample";
  },
  "location 2 has an incompatible stage link",
  "stage-link interpolation mismatch"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    const program = semantic.programs.find(
      (candidate) => candidate.name === "SparseDraw"
    );
    for (const values of [
      program.entryPoints.vertex.outputs,
      program.entryPoints.fragment.inputs,
    ]) {
      values.find((value) => value.location === 5).interpolation = {
        type: "linear",
        sampling: "center",
      };
    }
  },
  "integer user location 5 requires flat interpolation",
  "linear integer stage link"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    semantic.programs
      .find((program) => program.name === "SparseDraw")
      .entryPoints.vertex.inputs.find(
        (value) => value.location === 7
      ).location = 3;
  },
  "repeats shader interface value location:3",
  "duplicate semantic vertex location"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    const outputs = semantic.programs.find(
      (program) => program.name === "SparseDraw"
    ).entryPoints.fragment.outputs;
    outputs[0].location = 0;
    outputs[0].blendSource = 1;
  },
  "invalid dual-source fragment interface",
  "dual-source one without source zero"
);
requireShaderInterfaceMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    projection.programs
      .find((program) => program.semanticProgram === "SparseDraw")
      .entryPoints.reverse();
  },
  "entry points are not canonically stage ordered",
  "reordered projected stages"
);
requireWorkgroupSizeMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    const program = projection.programs.find(
      (candidate) => candidate.semanticProgram === "Noop"
    );
    program.resolvedWorkgroupSize.x += 1;
  },
  "resolved workgroup size",
  "semantic and projection workgroup mismatch"
);
const runtimeArrayFixtureProjection = artifact.projection.programs.find(
  (program) => program.semanticProgram === "RuntimeArray"
);
const runtimeArrayFixtureImmediateSlots =
  runtimeArrayFixtureProjection?.internalBindings
    .filter((binding) => binding.role === "immediate-data")
    .flatMap((binding) => binding.slots) ?? [];
if (
  artifact.projection.storageBufferSizeModel !==
    options.expectedStorageBufferSizeModel ||
  artifact.projection.vertexBufferPolicy.externalBufferCeiling !== 30 ||
  runtimeArrayFixtureImmediateSlots.length !== 1 ||
  runtimeArrayFixtureImmediateSlots[0].index !== 30
) {
  fail(
    "C3 fixture must cover the selected storage-size model, external vertex ceiling 30, and immediate-data buffer(30)"
  );
}
requireVertexPolicyMutationFailure(
  artifact.projection,
  (projection) => {
    const slot = projection.programs[0].bindings[0].slots[0];
    slot.stage = "vertex";
    slot.index = projection.vertexBufferPolicy.externalBufferCeiling;
  },
  "external vertex buffer interval ends",
  "external vertex buffer interval crossing ceiling"
);
requireVertexPolicyMutationFailure(
  artifact.projection,
  (projection) => {
    projection.programs[0].internalBindings.push({
      role: "fixture-internal",
      slots: [
        {
          stage: "vertex",
          mode: "direct",
          resourceClass: "buffer",
          component: "buffer",
          index: projection.vertexBufferPolicy.externalBufferCeiling - 1,
          count: 1,
        },
      ],
    });
  },
  "internal vertex buffer interval starts",
  "internal vertex interval below ceiling"
);
requireStorageContractMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    const program = projection.programs.find(
      (candidate) => candidate.semanticProgram === "RuntimeArray"
    );
    program.storageBufferSizeRegions[0].immediateDataByteOffset = 2;
  },
  "invalid immediate-data byte offset",
  "misaligned storage-size region"
);
requireStorageContractMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    const program = projection.programs.find(
      (candidate) => candidate.semanticProgram === "RuntimeArray"
    );
    program.storageBufferSizeRegions.push({
      stage: "compute",
      immediateDataByteOffset: 8,
    });
  },
  "repeats storage-buffer-size stage",
  "duplicate storage-size stage"
);
requireStorageContractMutationFailure(
  artifact.semantic,
  artifact.projection,
  (semantic) => {
    const program = semantic.programs.find(
      (candidate) => candidate.name === "RuntimeArray"
    );
    program.entryPoints.compute.bindings = [];
  },
  "no active runtime-sized storage binding",
  "region without active runtime storage"
);
requireStorageContractMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    const program = projection.programs.find(
      (candidate) => candidate.semanticProgram === "RuntimeArray"
    );
    program.internalBindings = [];
  },
  "needs exactly one immediate-data slot",
  "region without immediate data"
);
requireStorageContractMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    const program = projection.programs.find(
      (candidate) => candidate.semanticProgram === "RuntimeArray"
    );
    program.internalBindings[0].slots[0].component = "wrong-immediate-data";
  },
  "incompatible immediate-data slot",
  "region with incompatible immediate-data slot"
);
requireStorageContractMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    const program = projection.programs.find(
      (candidate) => candidate.semanticProgram === "RuntimeArray"
    );
    program.internalBindings[0].slots[0].index = 0;
  },
  "overlaps an external buffer slot",
  "region with overlapping immediate-data slot"
);
requireStorageContractMutationFailure(
  artifact.semantic,
  artifact.projection,
  (_semantic, projection) => {
    const program = projection.programs.find(
      (candidate) => candidate.semanticProgram === "RuntimeArray"
    );
    program.internalBindings.push({
      role: "fixture-other-internal",
      slots: [
        {
          stage: "compute",
          mode: "direct",
          resourceClass: "buffer",
          component: "buffer",
          index: 30,
          count: 1,
        },
      ],
    });
  },
  "overlaps another internal buffer slot",
  "region with overlapping internal slot"
);

const runtimeWithoutRegionProjection = clone(artifact.projection);
const runtimeWithoutRegion = runtimeWithoutRegionProjection.programs.find(
  (candidate) => candidate.semanticProgram === "RuntimeArray"
);
runtimeWithoutRegion.storageBufferSizeRegions = [];
runtimeWithoutRegion.internalBindings = [];
validateStorageBufferSizeContract(
  artifact.semantic,
  runtimeWithoutRegionProjection
);

const immediateWithoutRegionProjection = clone(artifact.projection);
const noopWithImmediate = immediateWithoutRegionProjection.programs.find(
  (candidate) => candidate.semanticProgram === "Noop"
);
noopWithImmediate.internalBindings.push({
  role: "immediate-data",
  slots: [
    {
      stage: "compute",
      mode: "direct",
      resourceClass: "buffer",
      component: "buffer",
      index:
        immediateWithoutRegionProjection.vertexBufferPolicy
          .externalBufferCeiling,
      count: 1,
    },
  ],
});
validateStorageBufferSizeContract(
  artifact.semantic,
  immediateWithoutRegionProjection
);
assertEqual(
  artifact.projection.runtimeFingerprint.sha256,
  runtimeSHA256,
  "runtime projection fingerprint"
);
const changedVertexBufferPolicy = clone(artifact.projection);
changedVertexBufferPolicy.vertexBufferPolicy.externalBufferCeiling -= 1;
if (
  sha256Canonical(
    runtimeProjectionInput(changedVertexBufferPolicy, libraries[0].sha256)
  ) === runtimeSHA256
) {
  fail("runtime projection fingerprint excludes vertex-buffer policy");
}
const changedShaderInterfaceModel = clone(artifact.projection);
changedShaderInterfaceModel.abi.shaderInterfaceModel =
  "vgpu-metal-shader-interface-v2";
if (
  sha256Canonical(
    runtimeProjectionInput(changedShaderInterfaceModel, libraries[0].sha256)
  ) === runtimeSHA256
) {
  fail("runtime projection fingerprint excludes shader-interface model");
}
const changedShaderInterfaceMap = clone(artifact.projection);
changedShaderInterfaceMap.programs
  .find((program) => program.semanticProgram === "SparseDraw")
  .entryPoints.find(
    (entry) => entry.stage === "vertex"
  ).interface.attributes[0].metal.attribute = 0;
if (
  sha256Canonical(
    runtimeProjectionInput(changedShaderInterfaceMap, libraries[0].sha256)
  ) === runtimeSHA256
) {
  fail("runtime projection fingerprint excludes shader-interface maps");
}
const changedStorageBufferSizeModel = clone(artifact.projection);
changedStorageBufferSizeModel.storageBufferSizeModel =
  artifact.projection.storageBufferSizeModel.endsWith("-v2")
    ? "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v3"
    : "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v2";
if (
  sha256Canonical(
    runtimeProjectionInput(changedStorageBufferSizeModel, libraries[0].sha256)
  ) === runtimeSHA256
) {
  fail("runtime projection fingerprint excludes storage-buffer-size model");
}
const changedStorageBufferSizeRegion = clone(artifact.projection);
changedStorageBufferSizeRegion.programs.find(
  (program) => program.semanticProgram === "RuntimeArray"
).storageBufferSizeRegions[0].immediateDataByteOffset += 4;
if (
  sha256Canonical(
    runtimeProjectionInput(changedStorageBufferSizeRegion, libraries[0].sha256)
  ) === runtimeSHA256
) {
  fail("runtime projection fingerprint excludes storage-buffer-size regions");
}
const changedImmediateDataSlot = clone(artifact.projection);
changedImmediateDataSlot.programs
  .find((program) => program.semanticProgram === "RuntimeArray")
  .internalBindings.find(
    (binding) => binding.role === "immediate-data"
  ).slots[0].index -= 1;
if (
  sha256Canonical(
    runtimeProjectionInput(changedImmediateDataSlot, libraries[0].sha256)
  ) === runtimeSHA256
) {
  fail("runtime projection fingerprint excludes immediate-data slot");
}

const semanticPrograms = new Map(
  artifact.semantic.programs.map((program) => [program.name, program])
);
for (const program of artifact.projection.programs) {
  const semanticProgram = semanticPrograms.get(program.semanticProgram);
  if (!semanticProgram) {
    fail(
      `projection references unknown semantic program ${program.semanticProgram}`
    );
  }
  if (program.kind !== semanticProgram.kind) {
    fail(
      `projection kind for ${program.semanticProgram} disagrees with semantic contract`
    );
  }
  const semanticBindings = new Set(
    semanticProgram.bindings.map((binding) => binding.id)
  );
  const projectedBindings = new Set();
  for (const binding of program.bindings) {
    if (!semanticBindings.has(binding.semanticBinding)) {
      fail(
        `projection ${program.semanticProgram} references unknown binding ${binding.semanticBinding}`
      );
    }
    if (projectedBindings.has(binding.semanticBinding)) {
      fail(
        `projection ${program.semanticProgram} repeats binding ${binding.semanticBinding}`
      );
    }
    projectedBindings.add(binding.semanticBinding);
  }
  assertEqual(
    JSON.stringify([...projectedBindings].sort()),
    JSON.stringify([...semanticBindings].sort()),
    `${program.semanticProgram} projected binding set`
  );
  const semanticEntries = Object.values(semanticProgram.entryPoints).map(
    (entry) => ({
      stage: entry.stage,
      wgsl: entry.names.wgsl,
    })
  );
  for (const entry of program.entryPoints) {
    if (
      !semanticEntries.some(
        (candidate) =>
          candidate.stage === entry.stage && candidate.wgsl === entry.wgsl
      )
    ) {
      fail(
        `projection ${program.semanticProgram} references unknown entry ${entry.stage}/${entry.wgsl}`
      );
    }
  }
  assertEqual(
    JSON.stringify(
      program.entryPoints.map((entry) => `${entry.stage}:${entry.wgsl}`).sort()
    ),
    JSON.stringify(
      semanticEntries.map((entry) => `${entry.stage}:${entry.wgsl}`).sort()
    ),
    `${program.semanticProgram} projected entry set`
  );
  const rootDeviceFeatures = new Set(
    artifact.projection.deviceRequirements.features
  );
  for (const feature of program.deviceRequirements.features) {
    if (!rootDeviceFeatures.has(feature)) {
      fail(
        `${program.semanticProgram} Metal feature ${feature} is absent from projection requirements`
      );
    }
  }
}

const buildSHA256 = sha256Canonical({
  compiler: artifact.compiler,
  logicalInputs: artifact.fingerprints.logicalInputs.sha256,
  semantic: semanticSHA256,
  runtimeProjection: runtimeSHA256,
  toolchain: artifact.projection.toolchain,
  files: artifact.files,
});
assertEqual(
  artifact.fingerprints.build.sha256,
  buildSHA256,
  "build fingerprint"
);

const marker = JSON.parse(
  readFileSync(join(packageRoot, ".vgpu-native-output.json"), "utf8")
);
assertEqual(
  marker.manifestSha256,
  sha256Bytes(artifactBytes),
  "raw manifest SHA-256"
);
assertEqual(
  marker.configuration,
  "c3-artifact-swiftpm",
  "ownership configuration"
);

const generatedSwift = readFileSync(
  join(packageRoot, "Sources", "AppShaders", "AppShaders.generated.swift"),
  "utf8"
);
const packageSwift = readFileSync(join(packageRoot, "Package.swift"), "utf8");
const probeSwift = readFileSync(
  join(packageRoot, "Sources", "AppShadersC3MetalProbe", "main.swift"),
  "utf8"
);
const moduleIdentity = artifact.semantic.module;
assertEqual(
  moduleIdentity.swiftName,
  "AppShaders",
  "fixture Swift module identity"
);
assertIncludes(
  packageSwift,
  `name: "${moduleIdentity.swiftName}"`,
  "Package.swift module"
);
assertIncludes(
  packageSwift,
  `.library(name: "${moduleIdentity.swiftName}", targets: ["${moduleIdentity.swiftName}"])`,
  "Package.swift library product"
);
assertIncludes(
  packageSwift,
  '.executable(name: "AppShadersC3MetalProbe", targets: ["AppShadersC3MetalProbe"])',
  "Package.swift C3 probe product"
);
assertIncludes(
  packageSwift,
  'name: "AppShadersC3MetalProbe"',
  "Package.swift C3 probe target"
);
assertIncludes(
  packageSwift,
  '.executableTarget(\n      name: "AppShadersC3MetalProbe"',
  "Package.swift C3 executable target declaration"
);
assertIncludes(
  packageSwift,
  '.process("Resources")',
  "Package.swift resource rule"
);
assertIncludes(
  packageSwift,
  `.product(name: "${artifact.semantic.abi.vgpuABI.product}", package: "RuntimeStub")`,
  "Package.swift VGPUABI dependency"
);

const [minimumMajor, minimumMinor, ...minimumRemainder] =
  artifact.projection.target.minimumOSVersion.split(".").map(Number);
if (
  !Number.isSafeInteger(minimumMajor) ||
  minimumMinor !== 0 ||
  minimumRemainder.some((part) => part !== 0)
) {
  fail(
    "fixture Package.swift cross-check requires a whole-number macOS version"
  );
}
assertIncludes(
  packageSwift,
  `.macOS(.v${minimumMajor})`,
  "Package.swift minimum macOS"
);

const expectedLibraryPath = `Sources/${moduleIdentity.swiftName}/Resources/${moduleIdentity.swiftName}.metallib`;
assertEqual(libraryPath, expectedLibraryPath, "module-derived library path");
for (const [label, expected] of [
  ["module name", `public static let moduleName = "${moduleIdentity.name}"`],
  [
    "Swift module name",
    `public static let swiftModuleName = "${moduleIdentity.swiftName}"`,
  ],
  [
    "minimum OS",
    `public static let minimumOSVersion = "${artifact.projection.target.minimumOSVersion}"`,
  ],
  [
    "semantic schema ABI",
    `semanticSchemaVersion: ${artifact.semantic.schemaVersion}`,
  ],
  [
    "Metal projection ABI",
    `metalProjectionABI: ${artifact.projection.abi.projection}`,
  ],
  [
    "generated Swift ABI",
    `generatedSwiftABI: ${artifact.semantic.abi.generatedSwift}`,
  ],
  [
    "binding layout ABI",
    `bindingLayoutABI: ${artifact.semantic.abi.bindingLayout}`,
  ],
  [
    "VGPUABI version",
    `requiredVGPUABIVersion: ${artifact.semantic.abi.vgpuABI.requiredVersion}`,
  ],
  [
    "binding slots ABI",
    `bindingSlotsABI: ${artifact.projection.abi.bindingSlots}`,
  ],
  ["layout model", `layoutModel: "${artifact.semantic.layoutModel}"`],
  ["binding model", `bindingModel: "${artifact.projection.abi.bindingModel}"`],
  [
    "shader-interface model",
    `shaderInterfaceModel: "${artifact.projection.abi.shaderInterfaceModel}"`,
  ],
  [
    "supported shader-interface model",
    `shaderInterfaceModels: ["${artifact.projection.abi.shaderInterfaceModel}"]`,
  ],
  [
    "vertex-buffer policy model",
    `vertexBufferPolicyModel: "${artifact.projection.vertexBufferPolicy.model}"`,
  ],
  [
    "external buffer ceiling",
    `externalBufferCeiling: ${artifact.projection.vertexBufferPolicy.externalBufferCeiling}`,
  ],
  [
    "storage-buffer-size model",
    `storageBufferSizeModel: "${artifact.projection.storageBufferSizeModel}"`,
  ],
  [
    "supported storage-buffer-size model",
    `storageBufferSizeModels: ["${runtimeSupportedStorageBufferSizeModel}"]`,
  ],
  ["semantic fingerprint", `semanticFingerprint: "${semanticSHA256}"`],
  [
    "projection semantic fingerprint",
    `projectionSemanticFingerprint: "${artifact.projection.semantic.sha256}"`,
  ],
  ["runtime fingerprint", `runtimeFingerprint: "${runtimeSHA256}"`],
  [
    "generated runtime fingerprint",
    `generatedRuntimeFingerprint: "${artifact.projection.runtimeFingerprint.sha256}"`,
  ],
  ["library SHA-256", `librarySHA256: "${libraries[0].sha256}"`],
  [
    "generated library SHA-256",
    `generatedLibrarySHA256: "${libraries[0].sha256}"`,
  ],
  [
    "payload filename",
    `public static let payloadFilename = "${moduleIdentity.swiftName}.metallib"`,
  ],
]) {
  assertIncludes(generatedSwift, expected, `generated Swift ${label}`);
}
for (const [label, expected] of [
  [
    "generated pipeline selection",
    "public struct AppShadersPipelineSelection: Equatable, Sendable",
  ],
  [
    "generated Metal entry interface",
    "public enum AppShadersMetalEntryInterface: Equatable, Sendable",
  ],
  [
    "entry interface descriptor",
    "public let interface: AppShadersMetalEntryInterface",
  ],
  [
    "non-public selection initializer",
    "fileprivate init(\n    program: AppShadersProgramDescriptor,",
  ],
  [
    "required coupled compatibility selection",
    "selection: AppShadersPipelineSelection,",
  ],
  [
    "coupled pipeline closure",
    "createPipeline: (AppShadersPipelineSelection) throws -> Void",
  ],
  ["validated closure argument", "try createPipeline(selection)"],
]) {
  assertIncludes(generatedSwift, expected, `generated Swift ${label}`);
}
if (
  generatedSwift.includes(
    "public init(\n    program: AppShadersProgramDescriptor,"
  ) ||
  generatedSwift.includes("program: AppShadersProgramDescriptor =") ||
  generatedSwift.includes("stage: AppShadersShaderStage =") ||
  generatedSwift.includes(
    "selection: AppShadersPipelineSelection = noopComputeSelection"
  )
) {
  fail(
    "generated Swift exposes a fabricable, defaulted, or decoupled pipeline selection"
  );
}

const noopProjection = artifact.projection.programs.find(
  (program) => program.semanticProgram === "Noop"
);
if (!noopProjection) fail("projection has no Noop program for the C3 probe");
if (
  noopProjection.storageBufferSizeRegions.length !== 0 ||
  noopProjection.internalBindings.some(
    (binding) => binding.role === "immediate-data"
  )
) {
  fail(
    "Noop must remain free of storage-size regions and immediate-data slots"
  );
}
const noopSemantic = semanticPrograms.get(noopProjection.semanticProgram);
const noopComputeEntries = noopProjection.entryPoints.filter(
  (entry) => entry.stage === "compute"
);
if (noopComputeEntries.length !== 1) {
  fail("C3 probe requires exactly one projected compute entry");
}
const noopProjectedBindings = noopProjection.bindings.filter((binding) =>
  binding.slots.some(
    (slot) => slot.stage === "compute" && slot.resourceClass === "buffer"
  )
);
if (noopProjectedBindings.length !== 1) {
  fail("C3 probe requires exactly one projected compute buffer binding");
}
const noopBufferSlots = noopProjectedBindings[0].slots.filter(
  (slot) => slot.stage === "compute" && slot.resourceClass === "buffer"
);
if (noopBufferSlots.length !== 1 || noopBufferSlots[0].count !== 1) {
  fail("C3 probe requires exactly one direct compute buffer slot");
}
assertEqual(noopBufferSlots[0].index, 0, "C3 no-op buffer ABI index");
const noopSemanticBinding = noopSemantic.bindings.find(
  (binding) => binding.id === noopProjectedBindings[0].semanticBinding
);
const noopSemanticType = artifact.semantic.types[noopSemanticBinding?.type];
if (
  !noopSemanticBinding ||
  noopSemanticBinding.kind !== "buffer" ||
  noopSemanticType?.kind !== "array" ||
  !Number.isSafeInteger(noopSemanticType.count)
) {
  fail("C3 probe buffer must map to one fixed semantic array binding");
}
const noopEntry = noopComputeEntries[0];
const noopWorkgroup = noopProjection.resolvedWorkgroupSize;
for (const [label, expected] of [
  ["Metal entry", `metalEntryPoint: "${noopEntry.metal}"`],
  ["buffer slot", `bufferIndex: ${noopBufferSlots[0].index}`],
  ["workgroup width", `workgroupWidth: ${noopWorkgroup.x}`],
  ["workgroup height", `workgroupHeight: ${noopWorkgroup.y}`],
  ["workgroup depth", `workgroupDepth: ${noopWorkgroup.z}`],
  [
    "minimum buffer size",
    `minimumBufferByteCount: ${noopSemanticBinding.minimumBindingSize}`,
  ],
  ["element count", `elementCount: ${noopSemanticType.count}`],
]) {
  assertIncludes(generatedSwift, expected, `generated Swift C3 probe ${label}`);
}
const runtimeArrayProjection = artifact.projection.programs.find(
  (program) => program.semanticProgram === "RuntimeArray"
);
const runtimeArrayRegion = runtimeArrayProjection?.storageBufferSizeRegions[0];
const runtimeArrayEntry = runtimeArrayProjection?.entryPoints.find(
  (entry) => entry.stage === runtimeArrayRegion?.stage
);
const runtimeArrayImmediateSlot = runtimeArrayProjection?.internalBindings
  .filter((binding) => binding.role === "immediate-data")
  .flatMap((binding) => binding.slots)[0];
if (!runtimeArrayRegion || !runtimeArrayEntry || !runtimeArrayImmediateSlot) {
  fail("RuntimeArray descriptor inputs are incomplete");
}
for (const [label, expected] of [
  [
    "Noop empty regions",
    "public static let noopProgram = AppShadersProgramDescriptor(",
  ],
  [
    "runtime program",
    "public static let runtimeArrayProgram = AppShadersProgramDescriptor(",
  ],
  ["runtime Metal entry", `metalName: "${runtimeArrayEntry.metal}"`],
  ["runtime region stage", `stage: .${runtimeArrayRegion.stage}`],
  [
    "runtime region offset",
    `immediateDataByteOffset: ${runtimeArrayRegion.immediateDataByteOffset}`,
  ],
  [
    "runtime immediate role",
    `role: "${runtimeArrayProjection.internalBindings[0].role}"`,
  ],
  ["runtime immediate index", `index: ${runtimeArrayImmediateSlot.index}`],
  ["runtime immediate count", `count: ${runtimeArrayImmediateSlot.count}`],
  [
    "runtime pipeline selection",
    "public static let runtimeArrayComputeSelection = AppShadersPipelineSelection(",
  ],
]) {
  assertIncludes(generatedSwift, expected, `generated Swift ${label}`);
}
const sparseDrawProjection = artifact.projection.programs.find(
  (program) => program.semanticProgram === "SparseDraw"
);
const sparseVertexEntry = sparseDrawProjection?.entryPoints.find(
  (entry) => entry.stage === "vertex"
);
const sparseFragmentEntry = sparseDrawProjection?.entryPoints.find(
  (entry) => entry.stage === "fragment"
);
if (!sparseDrawProjection || !sparseVertexEntry || !sparseFragmentEntry) {
  fail("SparseDraw generated descriptor inputs are incomplete");
}
assertIncludes(
  generatedSwift,
  `semanticProgram: "${sparseDrawProjection.semanticProgram}"`,
  "generated Swift sparse program"
);
for (const attribute of sparseVertexEntry.interface.attributes) {
  assertIncludes(
    generatedSwift,
    `semanticLocation: ${attribute.semantic.location},\n            metalAttribute: ${attribute.metal.attribute}`,
    `generated Swift sparse vertex attribute ${attribute.semantic.location}`
  );
}
for (const color of sparseFragmentEntry.interface.colorOutputs) {
  assertIncludes(
    generatedSwift,
    `semanticLocation: ${color.semantic.location},\n            blendSource: nil,\n            metalColor: ${color.metal.color},\n            metalIndex: nil`,
    `generated Swift sparse fragment color ${color.semantic.location}`
  );
}
for (const [label, expected] of [
  [
    "validated selection",
    "selection == AppShadersArtifact.noopComputeSelection",
  ],
  [
    "entry from validated selection",
    "selection.program.metalEntryPoint(for: selection.stage)",
  ],
  ["entry", "library.makeFunction(name: metalEntryPoint)"],
  ["buffer size", "length: projection.minimumBufferByteCount"],
  ["buffer slot", "index: projection.bufferIndex"],
  ["workgroup width", "width: projection.workgroupWidth"],
  ["workgroup height", "height: projection.workgroupHeight"],
  ["workgroup depth", "depth: projection.workgroupDepth"],
  ["element count", "capacity: projection.elementCount"],
]) {
  assertIncludes(probeSwift, expected, `C3 probe derived ${label}`);
}
if (generatedSwift.includes("__"))
  fail("generated Swift has an unresolved placeholder");

if (
  artifact.extensions["dev.vgpu.c3"].payloadKind ===
  "invalid-structural-sentinel"
) {
  const payload = readFileSync(
    join(packageRoot, ...libraryPath.split("/")),
    "utf8"
  );
  if (!payload.startsWith("VGPU-C3-STRUCTURAL-SENTINEL-NOT-A-METALLIB")) {
    fail("C3a payload does not carry the invalid sentinel marker");
  }
}

console.log(
  `C3 artifact verified: 5 schemas, ${referenceCount} refs, ${artifact.files.length} payload files, program-fingerprint boundary checks for interfaces and retained names, 3 Noop override-fingerprint checks, ${artifact.extensions["dev.vgpu.c3"].payloadKind}.`
);
