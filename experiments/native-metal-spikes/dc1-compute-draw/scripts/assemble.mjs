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

const HANDOFF_CONTRACT = "vgpu-native-dc1-compute-draw-handoff/v1";
const ARTIFACT_CONTRACT = "vgpu-native-dc1-compute-draw-artifact/v1";
const ARTIFACT_ID = "dc1-compute-draw";
const SOURCE_INPUT = "dc1-compute-draw-source";
const APP_SHADERS_PACKAGE_SHA256 =
  "366c9f4c52baa1ab526d75658bd6bb3c8429835578de750dcf6fbae6b4847f47";
const GENERATED_SWIFT_TEMPLATE_SHA256 =
  "bfac2686eba95f8a5b307a0d2da730328742ba97b54eb3196412b56c40d0256d";
const SHA256 = /^[a-f0-9]{64}$/u;
const TYPE_ID = /^t_[a-f0-9]{64}$/u;
const LAYOUT_ID = /^l_[a-f0-9]{64}$/u;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(SCRIPT_DIRECTORY, "../fixtures/compute-draw.wgsl");
const FORBIDDEN_HANDOFF_KEYS = new Set([
  "msl",
  "originMap",
  "request",
  "response",
  "text",
  "virtualPath",
]);
const PROGRAMS = Object.freeze([
  Object.freeze({
    programID: "ConsumePacket",
    kind: "draw",
    entryPointIDs: Object.freeze({
      fragment: "fragmentMain",
      vertex: "vertexMain",
    }),
    metalEntryPoints: Object.freeze({
      fragment: "vgpu_dc1_fragment",
      vertex: "vgpu_dc1_vertex",
    }),
    stages: Object.freeze(["vertex", "fragment"]),
  }),
  Object.freeze({
    programID: "ProducePacket",
    kind: "compute",
    entryPointIDs: Object.freeze({ compute: "produce" }),
    metalEntryPoints: Object.freeze({ compute: "vgpu_dc1_produce" }),
    stages: Object.freeze(["compute"]),
  }),
]);

main();

function main() {
  const options = parseArguments(process.argv.slice(2));
  assertRegularFile(options.library, "Metal library");
  assertRegularFile(options.handoff, "compiler handoff");
  expect(
    !existsSync(options.output),
    `output already exists: ${options.output}`
  );

  const libraryBytes = readFileSync(options.library);
  expect(libraryBytes.length > 0, "Metal library is empty");
  assertRegularFile(FIXTURE_PATH, "canonical compute-draw fixture");
  const fixtureBytes = readFileSync(FIXTURE_PATH);
  const handoff = parseJSON(
    readFileSync(options.handoff, "utf8"),
    "compiler handoff"
  );
  validateHandoff(handoff, libraryBytes, fixtureBytes);

  const semanticSHA256 = sha256(canonicalBytes(handoff.semantic));
  const programs = PROGRAMS.map((specification, index) => ({
    entryPointIDs: structuredClone(specification.entryPointIDs),
    programID: specification.programID,
    projection: {
      sha256: sha256(canonicalBytes(handoff.projections[index])),
    },
    runtimeManifest: handoff.runtimeManifests[index],
  }));
  const artifact = {
    abi: {
      bindingLayoutABI: 1,
      generatedSwiftABI: 1,
      metalProjectionABI: 1,
      requiredVGPUABIVersion: 1,
      semanticSchemaVersion: 1,
    },
    artifactID: ARTIFACT_ID,
    contractId: ARTIFACT_CONTRACT,
    evidence: handoff.evidence,
    library: { sha256: handoff.evidence.metallibSha256 },
    programs,
    schemaVersion: 1,
    semantic: { sha256: semanticSHA256 },
  };
  const descriptorBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const descriptorSHA256 = sha256(descriptorBytes);

  const template = resolve(SCRIPT_DIRECTORY, "../templates/AppShaders");
  const packageTemplatePath = join(template, "Package.swift");
  const generatedSwiftTemplatePath = join(
    template,
    "Sources/AppShaders/AppShaders.generated.swift"
  );
  assertRegularFile(packageTemplatePath, "AppShaders package template");
  assertRegularFile(generatedSwiftTemplatePath, "generated Swift template");
  const packageTemplate = readFileSync(packageTemplatePath, "utf8");
  const generatedSwiftTemplate = readFileSync(
    generatedSwiftTemplatePath,
    "utf8"
  );
  expect(
    sha256(Buffer.from(packageTemplate)) === APP_SHADERS_PACKAGE_SHA256,
    "AppShaders package template hash drifted"
  );
  expect(
    sha256(Buffer.from(generatedSwiftTemplate)) ===
      GENERATED_SWIFT_TEMPLATE_SHA256,
    "generated Swift template hash drifted"
  );
  assertPackageTemplate(packageTemplate);

  mkdirSync(options.output);
  const appShaders = join(options.output, "AppShaders");
  cpSync(template, appShaders, { recursive: true });

  const generatedSwiftPath = join(
    appShaders,
    "Sources/AppShaders/AppShaders.generated.swift"
  );
  const generatedSwift = substituteTemplate(
    generatedSwiftTemplate,
    new Map([
      ["__DESCRIPTOR_SHA256__", descriptorSHA256],
      ["__LIBRARY_SHA256__", handoff.evidence.metallibSha256],
    ])
  );
  assertGeneratedSwift(
    generatedSwift,
    descriptorSHA256,
    handoff.evidence.metallibSha256
  );
  writeFileSync(generatedSwiftPath, generatedSwift, "utf8");

  const resources = join(appShaders, "Sources/AppShaders/Resources");
  mkdirSync(resources);
  writeFileSync(join(resources, "AppShaders.artifact.json"), descriptorBytes);
  writeFileSync(join(resources, "AppShaders.metallib"), libraryBytes);

  const report = {
    artifactID: ARTIFACT_ID,
    descriptorSHA256,
    librarySHA256: handoff.evidence.metallibSha256,
    programs: programs.map(({ entryPointIDs, programID, projection }) => ({
      entryPointIDs,
      programID,
      projectionSHA256: projection.sha256,
    })),
    schemaVersion: 1,
    semanticSHA256,
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
    if (!expected.includes(name) || !value || value.startsWith("--")) usage();
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
  const semanticEvidence = validateSemantic(handoff.semantic);

  expect(
    Array.isArray(handoff.projections) && handoff.projections.length === 2,
    "handoff must contain exactly two projections"
  );
  expect(
    Array.isArray(handoff.runtimeManifests) &&
      handoff.runtimeManifests.length === 2,
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
  expect(
    semanticEvidence.fixedArrayByteCount === 32,
    "semantic fixed array byte size drifted"
  );
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
      name: "ComputeDrawFixtures",
      swiftName: "ComputeDrawFixtures",
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

  const typeGraph = validateTypesAndLayouts(semantic.types, semantic.layouts);
  expect(
    Array.isArray(semantic.programs) && semantic.programs.length === 2,
    "semantic model must contain exactly two programs"
  );
  validateConsumeProgram(semantic.programs[0], typeGraph);
  validateProduceProgram(semantic.programs[1], typeGraph);
  return { fixedArrayByteCount: typeGraph.arrayLayout.size };
}

function validateTypesAndLayouts(types, layouts) {
  expectPlainObject(types, "semantic types");
  expectPlainObject(layouts, "semantic layouts");
  expect(Object.keys(types).length === 5, "semantic type set drifted");
  expect(Object.keys(layouts).length === 2, "semantic layout set drifted");
  for (const identity of Object.keys(types)) {
    expect(
      TYPE_ID.test(identity),
      `semantic type identity drifted: ${identity}`
    );
  }
  for (const identity of Object.keys(layouts)) {
    expect(
      LAYOUT_ID.test(identity),
      `semantic layout identity drifted: ${identity}`
    );
  }

  const u32 = findIdentity(
    types,
    { kind: "scalar", scalar: "u32" },
    "u32 type"
  );
  const f32 = findIdentity(
    types,
    { kind: "scalar", scalar: "f32" },
    "f32 type"
  );
  const vec3u = findIdentity(
    types,
    { element: u32, kind: "vector", width: 3 },
    "vec3<u32> type"
  );
  const vec4f = findIdentity(
    types,
    { element: f32, kind: "vector", width: 4 },
    "vec4<f32> type"
  );
  const array8u = findIdentity(
    types,
    { count: 8, element: u32, kind: "array" },
    "array<u32,8> type"
  );
  const u32LayoutID = findIdentity(
    layouts,
    {
      alignment: 4,
      members: [],
      minimumSize: 4,
      runtimeSized: false,
      size: 4,
      type: u32,
    },
    "u32 layout"
  );
  const arrayLayoutID = findIdentity(
    layouts,
    {
      alignment: 4,
      arrayStride: 4,
      elementLayout: u32LayoutID,
      members: [],
      minimumSize: 32,
      runtimeSized: false,
      size: 32,
      type: array8u,
    },
    "array<u32,8> layout"
  );
  return {
    arrayLayout: layouts[arrayLayoutID],
    arrayLayoutID,
    arrayTypeID: array8u,
    u32,
    vec3u,
    vec4f,
  };
}

function validateProgramEnvelope(program, specification) {
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
  expect(program.kind === specification.kind, `${label} kind drifted`);
  expect(deepEqual(program.overrides, []), `${label} overrides drifted`);
  expect(
    deepEqual(program.sources, [SOURCE_INPUT]),
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
}

function validateConsumeProgram(program, types) {
  const specification = PROGRAMS[0];
  const label = "semantic program ConsumePacket";
  validateProgramEnvelope(program, specification);
  expect(deepEqual(program.bindings, []), `${label} bindings drifted`);
  expectPlainObject(program.entryPoints, `${label} entry points`);
  expectKeys(
    program.entryPoints,
    ["fragment", "vertex"],
    `${label} entry points`
  );

  const fragment = program.entryPoints.fragment;
  validateEntryEnvelope(fragment, {
    label: `${label} fragment`,
    name: "fragmentMain",
    stage: "fragment",
    startLine: 40,
    endLine: 43,
  });
  expect(
    deepEqual(fragment.bindings, []),
    `${label} fragment bindings drifted`
  );
  expect(
    deepEqual(fragment.inputs, [
      {
        interpolation: { sampling: "center", type: "perspective" },
        invariant: false,
        location: 0,
        type: types.vec4f,
      },
    ]),
    `${label} fragment inputs drifted`
  );
  expect(
    deepEqual(fragment.outputs, [
      {
        invariant: false,
        location: 0,
        type: types.vec4f,
      },
    ]),
    `${label} fragment outputs drifted`
  );

  const vertex = program.entryPoints.vertex;
  validateEntryEnvelope(vertex, {
    label: `${label} vertex`,
    name: "vertexMain",
    stage: "vertex",
    startLine: 21,
    endLine: 38,
  });
  expect(deepEqual(vertex.bindings, []), `${label} vertex bindings drifted`);
  expect(
    deepEqual(vertex.inputs, [
      {
        builtin: "vertex_index",
        invariant: false,
        type: types.u32,
      },
    ]),
    `${label} vertex inputs drifted`
  );
  expect(
    deepEqual(vertex.outputs, [
      {
        interpolation: { sampling: "center", type: "perspective" },
        invariant: false,
        location: 0,
        type: types.vec4f,
      },
      { builtin: "position", invariant: false, type: types.vec4f },
    ]),
    `${label} vertex outputs drifted`
  );
}

function validateProduceProgram(program, types) {
  const specification = PROGRAMS[1];
  const label = "semantic program ProducePacket";
  validateProgramEnvelope(program, specification);
  expectPlainObject(program.entryPoints, `${label} entry points`);
  expectKeys(program.entryPoints, ["compute"], `${label} entry points`);
  const compute = program.entryPoints.compute;
  validateEntryEnvelope(compute, {
    label: `${label} compute`,
    name: "produce",
    stage: "compute",
    startLine: 3,
    endLine: 14,
    extraKeys: ["workgroupSize"],
  });
  expect(
    deepEqual(compute.bindings, ["g0b0"]),
    `${label} compute bindings drifted`
  );
  expect(
    deepEqual(compute.inputs, [
      {
        builtin: "global_invocation_id",
        invariant: false,
        type: types.vec3u,
      },
    ]),
    `${label} compute inputs drifted`
  );
  expect(deepEqual(compute.outputs, []), `${label} compute outputs drifted`);
  expect(
    deepEqual(compute.workgroupSize, { x: 1, y: 1, z: 1 }),
    `${label} workgroup size drifted`
  );
  expect(
    Array.isArray(program.bindings) && program.bindings.length === 1,
    `${label} binding count drifted`
  );
  expect(
    deepEqual(program.bindings[0], {
      access: "read_write",
      addressSpace: "storage",
      binding: 0,
      group: 0,
      id: "g0b0",
      kind: "buffer",
      layout: types.arrayLayoutID,
      minimumBindingSize: 32,
      name: "produced",
      swiftName: "produced",
      type: types.arrayTypeID,
      visibility: ["compute"],
    }),
    `${label} fixed binding drifted`
  );
}

function validateEntryEnvelope(entry, specification) {
  expectPlainObject(entry, specification.label);
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
      ...(specification.extraKeys ?? []),
    ].sort(),
    specification.label
  );
  expect(entry.origin === "authored", `${specification.label} origin drifted`);
  expect(
    entry.stage === specification.stage,
    `${specification.label} stage drifted`
  );
  expect(
    deepEqual(entry.names, {
      authored: specification.name,
      wgsl: specification.name,
    }),
    `${specification.label} names drifted`
  );
  expect(
    deepEqual(entry.overrides, []),
    `${specification.label} overrides drifted`
  );
  expect(
    deepEqual(entry.samplingPairs, []),
    `${specification.label} sampling pairs drifted`
  );
  expect(
    deepEqual(entry.source, {
      end: { column: 2, line: specification.endLine },
      input: SOURCE_INPUT,
      start: { column: 1, line: specification.startLine },
    }),
    `${specification.label} source span drifted`
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
      ...(specification.kind === "compute" ? ["resolvedWorkgroupSize"] : []),
      "semanticProgram",
      "storageBufferSizeRegions",
    ].sort(),
    label
  );
  expect(
    deepEqual(projection, expectedProjection(specification)),
    `${label} drifted`
  );
}

function expectedProjection(specification) {
  const entryPoints = specification.stages.map((stage) => ({
    interface:
      stage === "vertex"
        ? { attributes: [], kind: "vertex" }
        : stage === "fragment"
        ? {
            colorOutputs: [{ metal: { color: 0 }, semantic: { location: 0 } }],
            kind: "fragment",
          }
        : { kind: "compute" },
    metal: specification.metalEntryPoints[stage],
    stage,
    wgsl: specification.entryPointIDs[stage],
  }));
  return {
    bindings:
      specification.kind === "compute"
        ? [{ semanticBinding: "g0b0", slots: [directBufferSlot()] }]
        : [],
    deviceRequirements: { features: [], formats: [], limits: [] },
    entryPoints,
    internalBindings: [],
    kind: specification.kind,
    ...(specification.kind === "compute"
      ? { resolvedWorkgroupSize: { x: 1, y: 1, z: 1 } }
      : {}),
    semanticProgram: specification.programID,
    storageBufferSizeRegions: [],
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
      ...(specification.kind === "compute" ? ["resolvedWorkgroupSize"] : []),
      "samplingPairs",
      "schemaVersion",
      "semanticProgram",
      "storageBufferSizeModel",
      "storageBufferSizeRegions",
    ].sort(),
    label
  );
  const expected = {
    bindings:
      specification.kind === "compute"
        ? [
            {
              descriptor: {
                access: "read_write",
                addressSpace: "storage",
                kind: "buffer",
                minimumBindingSize: 32,
                runtimeSized: false,
              },
              semanticBinding: "g0b0",
              slots: [directBufferSlot()],
            },
          ]
        : [],
    entryPoints: specification.stages.map((stage) => ({
      metal: specification.metalEntryPoints[stage],
      stage,
    })),
    immediateDataLayoutModel: "vgpu-metal-immediate-data-layout-v1",
    internalBindings: [],
    kind: specification.kind,
    ...(specification.kind === "compute"
      ? { resolvedWorkgroupSize: { x: 1, y: 1, z: 1 } }
      : {}),
    samplingPairs: [],
    schemaVersion: 1,
    semanticProgram: specification.programID,
    storageBufferSizeModel:
      "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
    storageBufferSizeRegions: [],
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
    `${label} bindings do not match projection`
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
    Array.isArray(evidence.programs) && evidence.programs.length === 2,
    "evidence must contain exactly two programs"
  );
  for (const [index, specification] of PROGRAMS.entries()) {
    const program = evidence.programs[index];
    const label = `evidence program ${specification.programID}`;
    expectPlainObject(program, label);
    expectKeys(
      program,
      [
        "semanticProgram",
        "semanticRequestSha256",
        "semanticResponseSha256",
        "translations",
      ],
      label
    );
    expect(
      program.semanticProgram === specification.programID,
      `${label} identity drifted`
    );
    expectSHA256(
      program.semanticRequestSha256,
      `${label}.semanticRequestSha256`
    );
    expectSHA256(
      program.semanticResponseSha256,
      `${label}.semanticResponseSha256`
    );
    expect(
      Array.isArray(program.translations) &&
        program.translations.length === specification.stages.length,
      `${label} translation count drifted`
    );
    for (const [translationIndex, stage] of specification.stages.entries()) {
      const translation = program.translations[translationIndex];
      expectKeys(
        translation,
        ["mslSha256", "requestSha256", "responseSha256", "stage"],
        `${label} translation ${stage}`
      );
      expect(translation.stage === stage, `${label} translation stage drifted`);
      for (const key of ["mslSha256", "requestSha256", "responseSha256"]) {
        expectSHA256(translation[key], `${label}.${stage}.${key}`);
      }
    }
  }
}

function directBufferSlot() {
  return {
    component: "buffer",
    count: 1,
    index: 0,
    mode: "direct",
    resourceClass: "buffer",
    stage: "compute",
  };
}

function emptyCapabilities() {
  return { features: [], languageFeatures: [], vocabulary: 1 };
}

function assertPackageTemplate(source) {
  expect(
    deepEqual(source.match(/^import \S+$/gmu), ["import PackageDescription"]),
    "AppShaders package template imports drifted"
  );
  expectOccurrences(source, '.library(name: "AppShaders"', 1);
  expectOccurrences(source, '.target(\n      name: "AppShaders"', 1);
  expectOccurrences(source, '.package(name: "C2GeneratedCompute"', 1);
  expectOccurrences(source, 'path: "../RuntimePrototype"', 1);
  expectOccurrences(
    source,
    '.product(name: "VGPUABI", package: "C2GeneratedCompute")',
    1
  );
  expectOccurrences(source, 'resources: [.process("Resources")]', 1);
  expect(
    (source.match(/\.library\(/gu) ?? []).length === 1,
    "AppShaders package must contain exactly one product"
  );
  expect(
    (source.match(/\.target\(/gu) ?? []).length === 1,
    "AppShaders package must contain exactly one target"
  );
  expect(
    (source.match(/\.package\(/gu) ?? []).length === 1,
    "AppShaders package must contain exactly one package dependency"
  );
  expect(
    (source.match(/\.product\(/gu) ?? []).length === 1,
    "AppShaders target must contain exactly one product dependency"
  );
  expect(
    !source.includes(".executable"),
    "AppShaders package must not contain an executable product or target"
  );
}

function assertGeneratedSwift(source, descriptorSHA256, librarySHA256) {
  expect(
    deepEqual(source.match(/^import \S+$/gmu), [
      "import Foundation",
      "import VGPUABI",
    ]),
    "generated Swift imports drifted"
  );
  expectOccurrences(source, "private enum ArtifactWitness:", 1);
  expectOccurrences(
    source,
    `static let _vgpuDescriptorSHA256 = "${descriptorSHA256}"`,
    1
  );
  expectOccurrences(
    source,
    `static let _vgpuLibrarySHA256 = "${librarySHA256}"`,
    1
  );
  expectOccurrences(
    source,
    "private let sharedArtifact = _VGPUProgramArtifact(ArtifactWitness.self)",
    1
  );
  expectOccurrences(source, "artifact: sharedArtifact", 2);

  const programs = source.match(
    /^public enum \w+: (?:VGPUDrawProgram|VGPUComputeProgram) \{$/gmu
  );
  expect(
    deepEqual(programs, [
      "public enum ConsumePacket: VGPUDrawProgram {",
      "public enum ProducePacket: VGPUComputeProgram {",
    ]),
    "generated Swift program declarations drifted"
  );
  expectOccurrences(source, "_VGPUDrawProgramDescriptor(", 1);
  expectOccurrences(source, "_VGPUProgramDescriptor(", 1);
  expectOccurrences(source, 'artifactID: "dc1-compute-draw"', 2);
  expectOccurrences(source, 'programID: "ConsumePacket"', 1);
  expectOccurrences(source, 'vertexEntryPointID: "vertexMain"', 1);
  expectOccurrences(source, 'fragmentEntryPointID: "fragmentMain"', 1);
  expectOccurrences(source, 'programID: "ProducePacket"', 1);
  expectOccurrences(source, 'entryPointID: "produce"', 1);

  expectOccurrences(source, "public var produced: VGPUStorage<UInt32>", 1);
  expectOccurrences(source, "public init(produced: VGPUStorage<UInt32>)", 1);
  expectOccurrences(source, "self.produced = produced", 1);
  expectOccurrences(source, "try encoder.storage(produced, at: 0)", 1);
  expectOccurrences(
    source,
    "_VGPULogicalBindingDescriptor(ordinal: 0, access: .readWrite, runtimeSized: false)",
    1
  );
  expectOccurrences(source, "workgroupSize: (1, 1, 1)", 1);
  expect(
    !source.includes("runtimeSizedStorage"),
    "generated Swift encoded the fixed array as runtime-sized"
  );
  expect(
    !/__[A-Z][A-Z0-9_]*__/u.test(source),
    "generated Swift contains an unsubstituted template token"
  );
}

function expectOccurrences(source, fragment, expectedCount) {
  const count = source.split(fragment).length - 1;
  expect(
    count === expectedCount,
    `${JSON.stringify(
      fragment
    )} must occur exactly ${expectedCount} times; found ${count}`
  );
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
        !/^\\/u.test(value) &&
        !/\.(?:wgsl|metal|msl|air|metallib)$/iu.test(value) &&
        !value.includes("@compute") &&
        !value.includes("@vertex") &&
        !value.includes("@fragment") &&
        !value.includes("@group") &&
        !value.includes("\n"),
      `source-free handoff contains source text or path-like string ${JSON.stringify(
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

function findIdentity(map, expected, label) {
  const matches = Object.entries(map).filter(([, value]) =>
    deepEqual(value, expected)
  );
  expect(matches.length === 1, `${label} is missing or ambiguous`);
  return matches[0][0];
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)));
}

function canonicalValue(value) {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const normalized = keys.map((key) => key.normalize("NFC"));
    expect(
      keys.every((key, index) => key === normalized[index]),
      "canonical input contains a non-NFC key"
    );
    expect(
      new Set(normalized).size === normalized.length,
      "canonical input contains colliding normalized keys"
    );
    return Object.fromEntries(
      normalized.sort().map((key) => [key, canonicalValue(value[key])])
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
    `${label} has unexpected or reordered properties: ${JSON.stringify(
      Object.keys(value)
    )}`
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
  process.stderr.write(`dc1-compute-draw assembler: ${message}\n`);
  process.exit(1);
}
