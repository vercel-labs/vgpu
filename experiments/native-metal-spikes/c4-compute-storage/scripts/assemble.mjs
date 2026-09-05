#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HANDOFF_CONTRACT = "vgpu-native-c1-compute-storage-handoff/v1";
const ARTIFACT_CONTRACT = "vgpu-native-c4-compute-storage-artifact/v1";
const ARTIFACT_ID = "c4-compute-storage";
const SHA256 = /^[a-f0-9]{64}$/u;
const SEMANTIC_ID = /^[tl]_[a-f0-9]{64}$/u;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  SCRIPT_DIRECTORY,
  "../fixtures/compute-storage.wgsl"
);
const FORBIDDEN_HANDOFF_KEYS = new Set([
  "msl",
  "text",
  "virtualPath",
  "originMap",
  "request",
  "response",
]);
const PROGRAMS = Object.freeze([
  Object.freeze({
    programID: "AdvanceState",
    entryPointID: "advance",
    metalEntryPoint: "vgpu_c4_advance",
    semanticBindings: Object.freeze([
      Object.freeze({ id: "g0b0", name: "src", binding: 0, access: "read" }),
      Object.freeze({ id: "g0b1", name: "mask", binding: 1, access: "read" }),
      Object.freeze({
        id: "g0b2",
        name: "dst",
        binding: 2,
        access: "read_write",
      }),
      Object.freeze({
        id: "g0b3",
        name: "advanceAudit",
        binding: 3,
        access: "read_write",
      }),
    ]),
    workgroupSize: Object.freeze({ x: 2, y: 1, z: 1 }),
  }),
  Object.freeze({
    programID: "MixState",
    entryPointID: "mix",
    metalEntryPoint: "vgpu_c4_mix",
    semanticBindings: Object.freeze([
      Object.freeze({ id: "g0b0", name: "src", binding: 0, access: "read" }),
      Object.freeze({ id: "g0b1", name: "mask", binding: 1, access: "read" }),
      Object.freeze({
        id: "g0b2",
        name: "dst",
        binding: 2,
        access: "read_write",
      }),
      Object.freeze({
        id: "g0b4",
        name: "mixAudit",
        binding: 4,
        access: "read_write",
      }),
    ]),
    workgroupSize: Object.freeze({ x: 1, y: 2, z: 1 }),
  }),
]);

main();

function main() {
  const options = parseArguments(process.argv.slice(2));
  assertRegularFile(options.library, "Metal library");
  assertRegularFile(options.handoff, "C1 handoff");
  expect(
    !existsSync(options.output),
    `output already exists: ${options.output}`
  );

  const libraryBytes = readFileSync(options.library);
  expect(libraryBytes.length > 0, "Metal library is empty");
  assertRegularFile(FIXTURE_PATH, "canonical compute-storage fixture");
  const fixtureBytes = readFileSync(FIXTURE_PATH);
  const handoff = parseJSON(
    readFileSync(options.handoff, "utf8"),
    "C1 handoff"
  );
  validateHandoff(handoff, libraryBytes, fixtureBytes);

  const semanticSHA256 = sha256(canonicalBytes(handoff.semantic));
  const programs = PROGRAMS.map((specification, index) => ({
    programID: specification.programID,
    entryPointID: specification.entryPointID,
    projection: {
      sha256: sha256(canonicalBytes(handoff.projections[index])),
    },
    runtimeManifest: handoff.runtimeManifests[index],
  }));
  const artifact = {
    schemaVersion: 1,
    contractId: ARTIFACT_CONTRACT,
    artifactID: ARTIFACT_ID,
    abi: {
      semanticSchemaVersion: 1,
      metalProjectionABI: 1,
      generatedSwiftABI: 1,
      bindingLayoutABI: 1,
      requiredVGPUABIVersion: 1,
    },
    semantic: { sha256: semanticSHA256 },
    library: { sha256: handoff.evidence.metallibSha256 },
    programs,
    evidence: handoff.evidence,
  };
  const descriptorBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const descriptorSHA256 = sha256(descriptorBytes);

  mkdirSync(options.output);
  const templates = resolve(SCRIPT_DIRECTORY, "../templates");
  const appShaders = join(options.output, "AppShaders");
  const cleanConsumer = join(options.output, "CleanConsumer");
  cpSync(join(templates, "AppShaders"), appShaders, { recursive: true });
  cpSync(join(templates, "CleanConsumer"), cleanConsumer, { recursive: true });

  const generatedSwiftPath = join(
    appShaders,
    "Sources/AppShaders/AppShaders.generated.swift"
  );
  const generatedSwift = substituteTemplate(
    readFileSync(generatedSwiftPath, "utf8"),
    new Map([
      ["__DESCRIPTOR_SHA256__", descriptorSHA256],
      ["__LIBRARY_SHA256__", handoff.evidence.metallibSha256],
    ])
  );
  writeFileSync(generatedSwiftPath, generatedSwift, "utf8");

  const resources = join(appShaders, "Sources/AppShaders/Resources");
  mkdirSync(resources);
  writeFileSync(join(resources, "AppShaders.artifact.json"), descriptorBytes);
  writeFileSync(join(resources, "AppShaders.metallib"), libraryBytes);

  const report = {
    schemaVersion: 1,
    artifactID: ARTIFACT_ID,
    descriptorSHA256,
    librarySHA256: handoff.evidence.metallibSha256,
    semanticSHA256,
    programs: programs.map(({ programID, projection }) => ({
      programID,
      projectionSHA256: projection.sha256,
    })),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function parseArguments(arguments_) {
  const expected = ["--library", "--handoff", "--output"];
  if (arguments_.length !== expected.length * 2) usage();
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !expected.includes(name) ||
      typeof value !== "string" ||
      value.length === 0
    ) {
      usage();
    }
    const key = name.slice(2);
    if (Object.hasOwn(values, key)) usage();
    values[key] = resolve(value);
  }
  if (!expected.every((name) => Object.hasOwn(values, name.slice(2)))) usage();
  return values;
}

function usage() {
  fail(
    "usage: assemble.mjs --library <library.metallib> --handoff <handoff.json> --output <directory>"
  );
}

function validateHandoff(handoff, libraryBytes, fixtureBytes) {
  expectPlainObject(handoff, "handoff");
  expectKeys(
    handoff,
    [
      "contractId",
      "evidence",
      "projections",
      "runtimeManifests",
      "schemaVersion",
      "semantic",
    ],
    "handoff"
  );
  expect(handoff.schemaVersion === 1, "handoff schemaVersion must be 1");
  expect(
    handoff.contractId === HANDOFF_CONTRACT,
    "handoff contractId is unsupported"
  );
  assertSourceFreeAndPathFree(handoff);
  validateSemantic(handoff.semantic);

  expect(
    Array.isArray(handoff.projections) &&
      handoff.projections.length === PROGRAMS.length,
    "handoff must contain exactly two projections"
  );
  expect(
    Array.isArray(handoff.runtimeManifests) &&
      handoff.runtimeManifests.length === PROGRAMS.length,
    "handoff must contain exactly two runtime manifests"
  );
  for (const [index, specification] of PROGRAMS.entries()) {
    validateProjection(handoff.projections[index], specification);
    validateRuntimeManifest(
      handoff.runtimeManifests[index],
      handoff.projections[index],
      specification
    );
  }
  validateEvidence(handoff.evidence, libraryBytes, fixtureBytes);
}

function validateSemantic(semantic) {
  expectPlainObject(semantic, "semantic model");
  expectKeys(
    semantic,
    [
      "abi",
      "capabilities",
      "contractId",
      "layoutModel",
      "layouts",
      "module",
      "programs",
      "schemaVersion",
      "types",
    ],
    "semantic model"
  );
  expect(semantic.schemaVersion === 1, "semantic schemaVersion must be 1");
  expect(
    semantic.contractId === "vgpu-native-semantic/v1",
    "semantic contractId is unsupported"
  );
  expect(
    deepEqual(semantic.module, {
      name: "ComputeStorageFixtures",
      swiftName: "ComputeStorageFixtures",
    }),
    "semantic module identity drifted"
  );
  expect(
    deepEqual(semantic.abi, {
      bindingLayout: 1,
      generatedSwift: 1,
      vgpuABI: { product: "VGPUABI", requiredVersion: 1 },
    }),
    "semantic ABI drifted"
  );
  expect(
    semantic.layoutModel === "wgsl-host-shareable-v1",
    "semantic layout model drifted"
  );
  expect(
    deepEqual(semantic.capabilities, emptyCapabilities()),
    "semantic capabilities drifted"
  );
  validateSemanticTypesAndLayouts(semantic.types, semantic.layouts);
  expect(
    Array.isArray(semantic.programs) &&
      semantic.programs.length === PROGRAMS.length,
    "semantic model must contain exactly two programs"
  );
  for (const [index, specification] of PROGRAMS.entries()) {
    validateSemanticProgram(semantic.programs[index], specification, semantic);
  }
}

function validateSemanticTypesAndLayouts(types, layouts) {
  expectPlainObject(types, "semantic types");
  expectPlainObject(layouts, "semantic layouts");
  expect(Object.keys(types).length === 3, "semantic type set drifted");
  expect(Object.keys(layouts).length === 2, "semantic layout set drifted");
  for (const identity of Object.keys(types)) {
    expect(
      SEMANTIC_ID.test(identity) && identity.startsWith("t_"),
      `semantic type identity drifted: ${identity}`
    );
  }
  for (const identity of Object.keys(layouts)) {
    expect(
      SEMANTIC_ID.test(identity) && identity.startsWith("l_"),
      `semantic layout identity drifted: ${identity}`
    );
  }

  const scalarEntry = Object.entries(types).find(([, type]) =>
    deepEqual(type, { kind: "scalar", scalar: "u32" })
  );
  expect(scalarEntry !== undefined, "semantic u32 type is missing");
  const [scalarID] = scalarEntry;
  const arrayEntry = Object.entries(types).find(([, type]) =>
    deepEqual(type, { element: scalarID, kind: "array" })
  );
  expect(arrayEntry !== undefined, "semantic runtime array type is missing");
  const [arrayID] = arrayEntry;
  const vectorEntry = Object.entries(types).find(([, type]) =>
    deepEqual(type, { element: scalarID, kind: "vector", width: 3 })
  );
  expect(vectorEntry !== undefined, "semantic vec3<u32> type is missing");

  const scalarLayoutEntry = Object.entries(layouts).find(([, layout]) =>
    deepEqual(layout, {
      alignment: 4,
      members: [],
      minimumSize: 4,
      runtimeSized: false,
      size: 4,
      type: scalarID,
    })
  );
  expect(scalarLayoutEntry !== undefined, "semantic u32 layout is missing");
  const [scalarLayoutID] = scalarLayoutEntry;
  const arrayLayoutEntry = Object.entries(layouts).find(([, layout]) =>
    deepEqual(layout, {
      alignment: 4,
      arrayStride: 4,
      elementLayout: scalarLayoutID,
      members: [],
      minimumSize: 0,
      runtimeSized: true,
      type: arrayID,
    })
  );
  expect(
    arrayLayoutEntry !== undefined,
    "semantic runtime array layout is missing"
  );
}

function validateSemanticProgram(program, specification, semantic) {
  const label = `semantic program ${specification.programID}`;
  expectPlainObject(program, label);
  expectKeys(
    program,
    [
      "bindings",
      "capabilities",
      "entryPoints",
      "fingerprint",
      "kind",
      "name",
      "overrides",
      "sources",
      "swiftName",
    ],
    label
  );
  expect(program.name === specification.programID, `${label} name drifted`);
  expect(
    program.swiftName === specification.programID,
    `${label} Swift name drifted`
  );
  expect(program.kind === "compute", `${label} kind drifted`);
  expect(deepEqual(program.overrides, []), `${label} overrides drifted`);
  expect(
    deepEqual(program.sources, ["c4-compute-storage-source"]),
    `${label} sources drifted`
  );
  expect(
    deepEqual(program.capabilities, emptyCapabilities()),
    `${label} capabilities drifted`
  );
  expectPlainObject(program.fingerprint, `${label} fingerprint`);
  expectKeys(program.fingerprint, ["domain", "sha256"], `${label} fingerprint`);
  expect(
    program.fingerprint.domain === "vgpu-native-program/v1",
    `${label} fingerprint domain drifted`
  );
  expectSHA256(program.fingerprint.sha256, `${label} fingerprint.sha256`);

  expectPlainObject(program.entryPoints, `${label} entry points`);
  expectKeys(program.entryPoints, ["compute"], `${label} entry points`);
  const entry = program.entryPoints.compute;
  expectPlainObject(entry, `${label} compute entry`);
  expectKeys(
    entry,
    [
      "bindings",
      "inputs",
      "names",
      "origin",
      "outputs",
      "overrides",
      "samplingPairs",
      "source",
      "stage",
      "workgroupSize",
    ],
    `${label} compute entry`
  );
  expect(entry.origin === "authored", `${label} entry origin drifted`);
  expect(entry.stage === "compute", `${label} entry stage drifted`);
  expect(
    deepEqual(entry.names, {
      authored: specification.entryPointID,
      wgsl: specification.entryPointID,
    }),
    `${label} entry names drifted`
  );
  expect(
    deepEqual(
      entry.bindings,
      specification.semanticBindings.map(({ id }) => id)
    ),
    `${label} entry bindings drifted`
  );
  expect(
    deepEqual(entry.workgroupSize, specification.workgroupSize),
    `${label} workgroup size drifted`
  );
  expect(deepEqual(entry.outputs, []), `${label} outputs drifted`);
  expect(deepEqual(entry.overrides, []), `${label} entry overrides drifted`);
  expect(deepEqual(entry.samplingPairs, []), `${label} sampling pairs drifted`);
  validateEntryInputs(entry.inputs, semantic.types, label);
  validateSourceSpan(entry.source, specification, label);

  expect(
    Array.isArray(program.bindings) &&
      program.bindings.length === specification.semanticBindings.length,
    `${label} binding count drifted`
  );
  const runtimeArrayLayout = Object.entries(semantic.layouts).find(
    ([, layout]) => layout.runtimeSized === true
  );
  expect(runtimeArrayLayout !== undefined, "runtime array layout is missing");
  const [layoutID, layout] = runtimeArrayLayout;
  for (const [
    index,
    expectedBinding,
  ] of specification.semanticBindings.entries()) {
    const binding = program.bindings[index];
    expectPlainObject(binding, `${label} binding ${expectedBinding.id}`);
    expectKeys(
      binding,
      [
        "access",
        "addressSpace",
        "binding",
        "group",
        "id",
        "kind",
        "layout",
        "minimumBindingSize",
        "name",
        "swiftName",
        "type",
        "visibility",
      ],
      `${label} binding ${expectedBinding.id}`
    );
    expect(
      deepEqual(binding, {
        access: expectedBinding.access,
        addressSpace: "storage",
        binding: expectedBinding.binding,
        group: 0,
        id: expectedBinding.id,
        kind: "buffer",
        layout: layoutID,
        minimumBindingSize: 4,
        name: expectedBinding.name,
        swiftName: expectedBinding.name,
        type: layout.type,
        visibility: ["compute"],
      }),
      `${label} binding ${expectedBinding.id} drifted`
    );
  }
}

function validateEntryInputs(inputs, types, label) {
  expect(
    Array.isArray(inputs) && inputs.length === 2,
    `${label} inputs drifted`
  );
  const vectorType = Object.entries(types).find(
    ([, type]) => type?.kind === "vector" && type?.width === 3
  );
  expect(vectorType !== undefined, "semantic vec3 input type is missing");
  const expected = ["global_invocation_id", "num_workgroups"].map(
    (builtin) => ({ builtin, invariant: false, type: vectorType[0] })
  );
  expect(deepEqual(inputs, expected), `${label} inputs drifted`);
}

function validateSourceSpan(source, specification, label) {
  const lines =
    specification.programID === "AdvanceState"
      ? { start: 7, end: 24 }
      : { start: 26, end: 43 };
  expect(
    deepEqual(source, {
      end: { column: 2, line: lines.end },
      input: "c4-compute-storage-source",
      start: { column: 1, line: lines.start },
    }),
    `${label} source span drifted`
  );
}

function validateProjection(projection, specification) {
  const label = `projection ${specification.programID}`;
  expectPlainObject(projection, label);
  expectKeys(
    projection,
    [
      "bindings",
      "deviceRequirements",
      "entryPoints",
      "internalBindings",
      "kind",
      "resolvedWorkgroupSize",
      "semanticProgram",
      "storageBufferSizeRegions",
    ],
    label
  );
  expect(
    deepEqual(projection, expectedProjection(specification)),
    `${label} drifted`
  );
}

function expectedProjection(specification) {
  return {
    bindings: specification.semanticBindings.map(({ id }, index) => ({
      semanticBinding: id,
      slots: [directBufferSlot(index)],
    })),
    deviceRequirements: { features: [], formats: [], limits: [] },
    entryPoints: [
      {
        interface: { kind: "compute" },
        metal: specification.metalEntryPoint,
        stage: "compute",
        wgsl: specification.entryPointID,
      },
    ],
    internalBindings: immediateDataBindings(),
    kind: "compute",
    resolvedWorkgroupSize: specification.workgroupSize,
    semanticProgram: specification.programID,
    storageBufferSizeRegions: storageBufferSizeRegions(),
  };
}

function validateRuntimeManifest(manifest, projection, specification) {
  const label = `runtime manifest ${specification.programID}`;
  expectPlainObject(manifest, label);
  expectKeys(
    manifest,
    [
      "bindings",
      "entryPoints",
      "immediateDataLayoutModel",
      "internalBindings",
      "kind",
      "resolvedWorkgroupSize",
      "samplingPairs",
      "schemaVersion",
      "semanticProgram",
      "storageBufferSizeModel",
      "storageBufferSizeRegions",
    ],
    label
  );
  const expected = {
    bindings: specification.semanticBindings.map(({ access, id }, index) => ({
      descriptor: {
        access,
        addressSpace: "storage",
        kind: "buffer",
        minimumBindingSize: 4,
        runtimeSized: true,
      },
      semanticBinding: id,
      slots: [directBufferSlot(index)],
    })),
    entryPoints: [{ metal: specification.metalEntryPoint, stage: "compute" }],
    immediateDataLayoutModel: "vgpu-metal-immediate-data-layout-v1",
    internalBindings: immediateDataBindings(),
    kind: "compute",
    resolvedWorkgroupSize: specification.workgroupSize,
    samplingPairs: [],
    schemaVersion: 1,
    semanticProgram: specification.programID,
    storageBufferSizeModel:
      "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
    storageBufferSizeRegions: storageBufferSizeRegions(),
  };
  expect(deepEqual(manifest, expected), `${label} drifted`);
  expect(
    deepEqual(
      manifest.bindings.map(({ semanticBinding, slots }) => ({
        semanticBinding,
        slots,
      })),
      projection.bindings
    ),
    `${label} bindings do not match its projection`
  );
}

function validateEvidence(evidence, libraryBytes, fixtureBytes) {
  expectPlainObject(evidence, "handoff evidence");
  expectKeys(
    evidence,
    ["metallibSha256", "programs", "sourceSha256"],
    "handoff evidence"
  );
  expectSHA256(evidence.metallibSha256, "evidence.metallibSha256");
  expectSHA256(evidence.sourceSha256, "evidence.sourceSha256");
  expect(
    sha256(fixtureBytes) === evidence.sourceSha256,
    "canonical fixture bytes do not match evidence.sourceSha256"
  );
  expect(
    sha256(libraryBytes) === evidence.metallibSha256,
    "Metal library bytes do not match evidence.metallibSha256"
  );
  expect(
    Array.isArray(evidence.programs) &&
      evidence.programs.length === PROGRAMS.length,
    "evidence must contain exactly two programs"
  );
  for (const [index, specification] of PROGRAMS.entries()) {
    const program = evidence.programs[index];
    const label = `evidence program ${specification.programID}`;
    expectPlainObject(program, label);
    expectKeys(
      program,
      [
        "mslSha256",
        "requestSha256",
        "responseSha256",
        "semanticProgram",
        "semanticRequestSha256",
        "semanticResponseSha256",
      ],
      label
    );
    expect(
      program.semanticProgram === specification.programID,
      `${label} identity drifted`
    );
    for (const key of [
      "mslSha256",
      "requestSha256",
      "responseSha256",
      "semanticRequestSha256",
      "semanticResponseSha256",
    ]) {
      expectSHA256(program[key], `${label}.${key}`);
    }
  }
}

function directBufferSlot(index) {
  return {
    component: "buffer",
    count: 1,
    index,
    mode: "direct",
    resourceClass: "buffer",
    stage: "compute",
  };
}

function immediateDataBindings() {
  return [{ role: "immediate-data", slots: [directBufferSlot(30)] }];
}

function storageBufferSizeRegions() {
  return [{ immediateDataByteOffset: 4, stage: "compute" }];
}

function emptyCapabilities() {
  return { features: [], languageFeatures: [], vocabulary: 1 };
}

function assertSourceFreeAndPathFree(value, key) {
  if (key && FORBIDDEN_HANDOFF_KEYS.has(key)) {
    fail(
      `source-free handoff contains forbidden property ${JSON.stringify(key)}`
    );
  }
  if (typeof value === "string") {
    expect(
      !isAbsolute(value) &&
        !/^file:\/\//u.test(value) &&
        !/^[A-Za-z]:[\\/]/u.test(value) &&
        !/^\\\\/u.test(value) &&
        !/\.(?:wgsl|metal|msl|air|metallib)$/iu.test(value) &&
        !value.includes("@compute") &&
        !value.includes("@group") &&
        !value.includes("\n"),
      `source-free handoff contains source text or a path-like string ${JSON.stringify(
        value
      )}`
    );
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSourceFreeAndPathFree(item);
    return;
  }
  if (isPlainObject(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      assertSourceFreeAndPathFree(child, childKey);
    }
  }
}

function substituteTemplate(template, replacements) {
  let result = template;
  for (const [token, value] of replacements) {
    expect(
      result.split(token).length === 2,
      `template token ${token} must occur exactly once`
    );
    result = result.replace(token, value);
  }
  expect(
    !/__[A-Z][A-Z0-9_]*__/u.test(result),
    "generated Swift contains an unsubstituted template token"
  );
  return result;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)));
}

function canonicalValue(value) {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const normalizedKeys = keys.map((key) => key.normalize("NFC"));
    expect(
      keys.every((key, index) => key === normalizedKeys[index]),
      "canonical input contains a non-NFC object key"
    );
    expect(
      new Set(normalizedKeys).size === normalizedKeys.length,
      "canonical input contains colliding normalized object keys"
    );
    return Object.fromEntries(
      normalizedKeys.sort().map((key) => [key, canonicalValue(value[key])])
    );
  }
  return value;
}

function parseJSON(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label} does not exist: ${path}`);
  }
  expect(stat.isFile(), `${label} must be a regular, non-symlink file`);
}

function expectKeys(value, expected, label) {
  expect(
    deepEqual(Object.keys(value), expected),
    `${label} has unexpected or reordered properties`
  );
}

function expectPlainObject(value, label) {
  expect(isPlainObject(value), `${label} must be an object`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectSHA256(value, label) {
  expect(
    typeof value === "string" && SHA256.test(value),
    `${label} must be a lowercase SHA-256 digest`
  );
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  process.stderr.write(`c4-compute-storage assembler: ${message}\n`);
  process.exit(1);
}
