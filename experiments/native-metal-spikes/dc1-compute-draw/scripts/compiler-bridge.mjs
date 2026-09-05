#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  decodeTintWorkerResponse,
  invokeRawTintPrototype,
  runCommand,
  startTintWorker,
} from "../../c1-compiler-protocol/lib/native-compiler.mjs";
import {
  authenticateSuccessfulCompilerTranslation,
  compilerResponseForTranslation,
} from "../../c1-semantic-bridge/lib/authenticated-compiler-translation.mjs";
import { authenticateSuccessfulInventory } from "../../c1-semantic-bridge/lib/authenticated-inventory.mjs";
import {
  authenticateSuccessfulSemanticExtraction,
  semanticExtractionRequestForFinalizedCapsule,
} from "../../c1-semantic-bridge/lib/authenticated-semantic-extraction.mjs";
import { finalizeProgramCapsule } from "../../c1-semantic-bridge/lib/fullscreen-injection.mjs";
import {
  assembleMetalProgramProjection,
  metalSourcesForProgramProjection,
} from "../../c1-semantic-bridge/lib/metal-program-projection.mjs";
import {
  deterministicStringify,
  encodeInventoryRequest,
  INVENTORY_CONTRACT,
  originMapSha256,
} from "../../c1-semantic-bridge/lib/protocol.mjs";
import { selectProgramEntries } from "../../c1-semantic-bridge/lib/program-selection.mjs";
import { resolveVirtualShaderWithDeclarations } from "../../c1-semantic-bridge/lib/resolved-declarations.mjs";
import {
  isRuntimeResourceLayout,
  runtimeResourceLayoutForMetalProgramProjection,
} from "../../c1-semantic-bridge/lib/runtime-resource-layout.mjs";
import {
  allocateMetalSlotsForAssembly,
  assembleSemanticProgram,
  compilerRequestForAssembledEntry,
} from "../../c1-semantic-bridge/lib/semantic-assembly.mjs";
import { encodeSemanticExtractionRequest } from "../../c1-semantic-bridge/lib/semantic-extraction-protocol.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const spikeDirectory = resolve(scriptDirectory, "..");
const repoRoot = resolve(spikeDirectory, "../../..");
const fixturePath = join(spikeDirectory, "fixtures/compute-draw.wgsl");
const semanticSchemaPath = join(
  repoRoot,
  "docs/plans/native/contracts/semantic-v1.schema.json"
);
const configSource = "Shaders/compute-draw.wgsl";
const generatedVirtualPath = "Intermediate/compute-draw.resolved.wgsl";
const sourceInput = "dc1-compute-draw-source";
const handoffContract = "vgpu-native-dc1-compute-draw-handoff/v1";
const metalTarget = "air64-apple-macos14.0";
const expectedConnectedProbeReport = Object.freeze({
  schemaVersion: 1,
  gate: "dc1-compute-draw",
  status: "passed",
  controls: Object.freeze({
    blue: Object.freeze([0, 0, 255, 255]),
    red: Object.freeze([255, 0, 0, 255]),
    green: Object.freeze([0, 255, 0, 255]),
  }),
  expectedPacket: Object.freeze([3, 1, 0, 0]),
  commitTrace: Object.freeze(["computeCommit", "frameCommit"]),
  viewRange: Object.freeze([16, 32]),
  consumerByteOffset: 0,
  physicalByteOffset: 16,
  directVertexCount: 0,
  sameAllocationGeneration: true,
  cpuPacketReads: 0,
  cpuWaits: 0,
  onErrorCount: 0,
  negativeCases: Object.freeze([
    Object.freeze({
      name: "missingIndirectUsage",
      code: "VGPU-INDIRECT-INVALID",
      acceptedSubmissions: 0,
      submissionTokens: 0,
      onErrorCount: 0,
    }),
    Object.freeze({
      name: "foreignContext",
      code: "VGPU-NATIVE-CONTEXT-MISMATCH",
      acceptedSubmissions: 0,
      submissionTokens: 0,
      onErrorCount: 0,
    }),
    Object.freeze({
      name: "misalignedOffset",
      code: "VGPU-INDIRECT-INVALID",
      acceptedSubmissions: 0,
      submissionTokens: 0,
      onErrorCount: 0,
    }),
    Object.freeze({
      name: "shortRange",
      code: "VGPU-INDIRECT-INVALID",
      acceptedSubmissions: 0,
      submissionTokens: 0,
      onErrorCount: 0,
    }),
  ]),
});
const programSpecifications = Object.freeze([
  Object.freeze({
    semanticProgram: "ConsumePacket",
    kind: "draw",
    entryPoints: Object.freeze({
      vertex: "vertexMain",
      fragment: "fragmentMain",
    }),
    metalEntryPoints: Object.freeze({
      vertex: "vgpu_dc1_vertex",
      fragment: "vgpu_dc1_fragment",
    }),
    bindingIDs: Object.freeze([]),
  }),
  Object.freeze({
    semanticProgram: "ProducePacket",
    kind: "compute",
    entryPoints: Object.freeze({ compute: "produce" }),
    metalEntryPoints: Object.freeze({ compute: "vgpu_dc1_produce" }),
    bindingIDs: Object.freeze(["g0b0"]),
    bindingAccess: "read_write",
    workgroupSize: Object.freeze({ x: 1, y: 1, z: 1 }),
  }),
]);

const options = parseArguments(process.argv.slice(2));
const report = await runBridge(options);
process.stdout.write(`${deterministicStringify(report)}\n`);

async function runBridge(settings) {
  const authoredSource = readFileSync(fixturePath, "utf8");
  let resolverCalls = 0;
  resolverCalls += 1;
  const { graph, declarations } = await resolveVirtualShaderWithDeclarations({
    entry: configSource,
    generatedVirtualPath,
    sources: [
      {
        id: sourceInput,
        virtualPath: configSource,
        text: authoredSource,
        sha256: sha256(authoredSource),
      },
    ],
  });
  assert.equal(resolverCalls, 1);

  const inventoryRequest = {
    schemaVersion: 1,
    contractId: INVENTORY_CONTRACT,
    source: {
      virtualPath: graph.originMap.generatedSource.virtualPath,
      sha256: graph.originMap.generatedSource.sha256,
      text: graph.resolved.wgsl,
    },
    originMap: structuredClone(graph.originMap),
    originMapSha256: originMapSha256(graph.originMap),
    languageFeatures: [],
  };
  const inventoryBytes = encodeInventoryRequest(inventoryRequest);
  const inventoryAttempts = await Promise.all([
    invokeInventory(settings.worker, inventoryRequest, inventoryBytes),
    invokeInventory(settings.worker, inventoryRequest, inventoryBytes),
  ]);
  assert.equal(
    inventoryAttempts[0].stdout,
    inventoryAttempts[1].stdout,
    "inventory is not byte-deterministic"
  );
  assert.deepEqual(
    inventoryAttempts[0].inventory,
    inventoryAttempts[1].inventory
  );
  const inventory = inventoryAttempts[0].inventory;
  assert.deepEqual(inventory.entryPoints, [
    { stage: "vertex", wgsl: "vertexMain" },
    { stage: "fragment", wgsl: "fragmentMain" },
    { stage: "compute", wgsl: "produce" },
  ]);

  const records = [];
  for (const specification of programSpecifications) {
    records.push(
      await assembleProgram({
        declarations,
        inventory,
        specification,
        worker: settings.worker,
      })
    );
  }
  records.sort((left, right) =>
    compare(
      left.specification.semanticProgram,
      right.specification.semanticProgram
    )
  );

  const semantic = mergeSemanticModules(
    records.map(({ assembly }) => assembly.semantic)
  );
  validateSemanticModule(semantic);
  const projections = records.map(({ projection }) =>
    structuredClone(projection)
  );
  const runtimeManifests = records.map(({ runtimeManifest }) =>
    structuredClone(runtimeManifest)
  );

  const scratch = mkdtempSync(join(tmpdir(), "vgpu-dc1-compiler-bridge-"));
  try {
    const libraryPath = compileMetalLibrary(records, scratch);
    const libraryBytes = readFileSync(libraryPath);
    assertSourceFreeMetalLibrary(libraryBytes, authoredSource, scratch);
    const handoff = {
      schemaVersion: 1,
      contractId: handoffContract,
      semantic,
      projections,
      runtimeManifests,
      evidence: {
        sourceSha256: sha256(authoredSource),
        programs: records.map(({ evidence, specification }) => ({
          semanticProgram: specification.semanticProgram,
          ...structuredClone(evidence),
        })),
        metallibSha256: sha256(libraryBytes),
      },
    };
    assertCanonicalHandoff(handoff, authoredSource);
    const handoffBytes = deterministicStringify(handoff);
    assert.equal(
      handoffBytes,
      deterministicStringify(structuredClone(handoff))
    );
    const handoffPath = join(scratch, "compute-draw-handoff.json");
    writeFileSync(handoffPath, handoffBytes, "utf8");

    const probe = settings.probe
      ? runExternalProbe(settings.probe, libraryPath, handoffPath)
      : { status: "skipped", reason: "no external probe supplied" };

    return {
      schemaVersion: 1,
      gate: "dc1-compiler-bridge",
      status: "passed",
      connectedGate: settings.probe !== undefined,
      resolverCalls,
      inventory: {
        deterministicRuns: inventoryAttempts.length,
        requestSha256: sha256(inventoryBytes),
        responseSha256: sha256(inventoryAttempts[0].stdout),
      },
      programs: records.map(({ evidence, projection, specification }) => ({
        semanticProgram: specification.semanticProgram,
        kind: specification.kind,
        entryPoints: structuredClone(specification.entryPoints),
        bindings: [...specification.bindingIDs],
        slots: projection.bindings.flatMap(({ slots }) =>
          slots.map(({ stage, index }) => ({ stage, index }))
        ),
        translations: evidence.translations.length,
        deterministicSemanticExtractions: 2,
        deterministicTranslationRuns: 2,
        evidence: structuredClone(evidence),
      })),
      uniqueTranslations: records.reduce(
        (total, { evidence }) => total + evidence.translations.length,
        0
      ),
      semanticPrograms: semantic.programs.length,
      projections: projections.length,
      runtimeManifests: runtimeManifests.length,
      metallibSha256: handoff.evidence.metallibSha256,
      handoffSha256: sha256(handoffBytes),
      probe,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function assembleProgram({
  declarations,
  inventory,
  specification,
  worker,
}) {
  const selection = selectProgramEntries(
    {
      name: specification.semanticProgram,
      source: configSource,
      kind: specification.kind,
      entryPoints: specification.entryPoints,
    },
    inventory
  );
  const finalized = finalizeProgramCapsule({ inventory, selection });
  const semanticRequest =
    semanticExtractionRequestForFinalizedCapsule(finalized);
  const semanticRequestBytes = encodeSemanticExtractionRequest(semanticRequest);
  const semanticAttempts = await Promise.all([
    invokeSemantic(worker, finalized, semanticRequest, semanticRequestBytes),
    invokeSemantic(worker, finalized, semanticRequest, semanticRequestBytes),
  ]);
  assert.equal(
    semanticAttempts[0].stdout,
    semanticAttempts[1].stdout,
    `${specification.semanticProgram} semantic extraction is not byte-deterministic`
  );
  assert.deepEqual(
    semanticAttempts[0].extraction,
    semanticAttempts[1].extraction
  );

  const assembly = assembleSemanticProgram({
    presentation: {
      module: { name: "ComputeDrawFixtures", swiftName: "ComputeDrawFixtures" },
      program: { swiftName: specification.semanticProgram },
    },
    finalized,
    extraction: semanticAttempts[0].extraction,
    declarations,
  });
  assertSemanticProgram(assembly, specification);

  const allocation = allocateMetalSlotsForAssembly({ assembly });
  const stages = Object.keys(specification.entryPoints);
  const translationRecords = [];
  for (const stage of stages) {
    const compilerRequest = compilerRequestForAssembledEntry({
      assembly,
      allocation,
      stage,
      metalEntryPoint: specification.metalEntryPoints[stage],
    });
    const attempts = await Promise.all([
      invokeTranslation(worker, compilerRequest),
      invokeTranslation(worker, compilerRequest),
    ]);
    assert.equal(
      attempts[0].attempt.stdout,
      attempts[1].attempt.stdout,
      `${specification.semanticProgram}/${stage} translation is not byte-deterministic`
    );
    assert.deepEqual(
      compilerResponseForTranslation(attempts[0].translation),
      compilerResponseForTranslation(attempts[1].translation)
    );
    const response = compilerResponseForTranslation(attempts[0].translation);
    translationRecords.push({
      stage,
      compilerRequest,
      translation: attempts[0].translation,
      evidence: {
        stage,
        requestSha256: sha256(JSON.stringify(compilerRequest)),
        responseSha256: sha256(attempts[0].attempt.stdout),
        mslSha256: sha256(response.result.msl),
      },
    });
  }

  const projection = assembleMetalProgramProjection({
    assembly,
    allocation,
    translations: translationRecords.map(({ translation }) => translation),
  });
  assertProjection(projection, specification);
  const runtimeManifest = runtimeManifestForProgram({
    compilerRequests: translationRecords.map(
      ({ compilerRequest }) => compilerRequest
    ),
    projection,
    specification,
  });

  return {
    assembly,
    projection,
    runtimeManifest,
    specification,
    evidence: {
      semanticRequestSha256: sha256(semanticRequestBytes),
      semanticResponseSha256: sha256(semanticAttempts[0].stdout),
      translations: translationRecords.map(({ evidence }) => evidence),
    },
  };
}

function assertSemanticProgram(assembly, specification) {
  const program = assembly.semantic.programs[0];
  assert.equal(program.name, specification.semanticProgram);
  assert.equal(program.kind, specification.kind);
  assert.deepEqual(
    Object.keys(program.entryPoints),
    Object.keys(specification.entryPoints)
  );
  for (const [stage, wgsl] of Object.entries(specification.entryPoints)) {
    assert.equal(program.entryPoints[stage].names.wgsl, wgsl);
    assert.deepEqual(
      program.entryPoints[stage].bindings,
      stage === "compute" ? specification.bindingIDs : []
    );
  }
  assert.deepEqual(
    program.bindings.map(({ id }) => id),
    specification.bindingIDs
  );
  if (specification.kind === "compute") {
    assert.deepEqual(
      program.bindings.map(({ access }) => access),
      [specification.bindingAccess]
    );
    assert.deepEqual(
      program.bindings.map(({ minimumBindingSize }) => minimumBindingSize),
      [32]
    );
    assert.deepEqual(
      program.bindings.map(({ swiftName }) => swiftName),
      ["produced"]
    );
  } else {
    assert.deepEqual(program.bindings, []);
  }
  if (specification.kind === "compute") {
    assert.deepEqual(
      program.entryPoints.compute.workgroupSize,
      specification.workgroupSize
    );
  } else {
    const vertex = program.entryPoints.vertex;
    const fragment = program.entryPoints.fragment;
    assert.deepEqual(
      normalizeInterfaceFields(vertex.inputs, assembly.semantic.types),
      [
        {
          type: { scalar: "u32", width: 1 },
          invariant: false,
          builtin: "vertex_index",
        },
      ]
    );
    assert.deepEqual(
      normalizeInterfaceFields(vertex.outputs, assembly.semantic.types),
      [
        {
          type: { scalar: "f32", width: 4 },
          invariant: false,
          location: 0,
          interpolation: { type: "perspective", sampling: "center" },
        },
        {
          type: { scalar: "f32", width: 4 },
          invariant: false,
          builtin: "position",
        },
      ]
    );
    assert.deepEqual(
      normalizeInterfaceFields(fragment.inputs, assembly.semantic.types),
      [
        {
          type: { scalar: "f32", width: 4 },
          invariant: false,
          location: 0,
          interpolation: { type: "perspective", sampling: "center" },
        },
      ]
    );
    assert.deepEqual(
      normalizeInterfaceFields(fragment.outputs, assembly.semantic.types),
      [
        {
          type: { scalar: "f32", width: 4 },
          invariant: false,
          location: 0,
        },
      ]
    );
  }
}

function normalizeInterfaceFields(fields, types) {
  return fields.map((field) => ({
    ...field,
    type: normalizeInterfaceType(field.type, types),
  }));
}

function normalizeInterfaceType(type, types) {
  if (typeof type !== "string") return structuredClone(type);
  const descriptor = types[type];
  assert(descriptor, `semantic interface references unknown type ${type}`);
  if (descriptor.kind === "scalar") {
    return { scalar: descriptor.scalar, width: 1 };
  }
  if (descriptor.kind === "vector") {
    const element = normalizeInterfaceType(descriptor.element, types);
    assert.equal(element.width, 1);
    return { scalar: element.scalar, width: descriptor.width };
  }
  fail(`unsupported semantic interface type ${type} (${descriptor.kind})`);
}

function assertProjection(projection, specification) {
  assert.equal(projection.semanticProgram, specification.semanticProgram);
  assert.equal(projection.kind, specification.kind);
  assert.deepEqual(
    projection.entryPoints.map(({ stage, wgsl, metal }) => ({
      stage,
      wgsl,
      metal,
    })),
    Object.keys(specification.entryPoints).map((stage) => ({
      stage,
      wgsl: specification.entryPoints[stage],
      metal: specification.metalEntryPoints[stage],
    }))
  );
  assert.deepEqual(
    projection.bindings.map(({ semanticBinding }) => semanticBinding),
    specification.bindingIDs
  );
  assert.deepEqual(
    projection.bindings.flatMap(({ slots }) =>
      slots.map(({ stage, index }) => ({ stage, index }))
    ),
    specification.kind === "compute" ? [{ stage: "compute", index: 0 }] : []
  );
  assert.deepEqual(projection.internalBindings, []);
  assert.deepEqual(projection.storageBufferSizeRegions, []);
  if (specification.kind === "compute") {
    assert.deepEqual(
      projection.resolvedWorkgroupSize,
      specification.workgroupSize
    );
  } else {
    assert.equal(Object.hasOwn(projection, "resolvedWorkgroupSize"), false);
  }
}

function runtimeManifestForProgram({
  compilerRequests,
  projection,
  specification,
}) {
  const runtimeLayout =
    runtimeResourceLayoutForMetalProgramProjection(projection);
  assert(isRuntimeResourceLayout(runtimeLayout));
  const [baselineRequest] = compilerRequests;
  for (const request of compilerRequests.slice(1)) {
    assert.equal(
      request.metal.immediateDataLayoutModel,
      baselineRequest.metal.immediateDataLayoutModel
    );
    assert.equal(
      request.metal.storageBufferSizes.model,
      baselineRequest.metal.storageBufferSizes.model
    );
  }
  const manifest = {
    schemaVersion: 1,
    immediateDataLayoutModel: baselineRequest.metal.immediateDataLayoutModel,
    storageBufferSizeModel: baselineRequest.metal.storageBufferSizes.model,
    semanticProgram: runtimeLayout.semanticProgram,
    kind: runtimeLayout.kind,
    entryPoints: metalSourcesForProgramProjection(projection).map(
      ({ stage, entryPoint }) => ({ stage, metal: entryPoint })
    ),
    bindings: runtimeLayout.bindings,
    samplingPairs: runtimeLayout.samplingPairs,
    internalBindings: projection.internalBindings,
    storageBufferSizeRegions: projection.storageBufferSizeRegions,
    ...(specification.kind === "compute"
      ? { resolvedWorkgroupSize: projection.resolvedWorkgroupSize }
      : {}),
  };
  assert.deepEqual(
    manifest.bindings,
    specification.kind === "compute"
      ? [
          {
            semanticBinding: "g0b0",
            descriptor: {
              kind: "buffer",
              addressSpace: "storage",
              access: "read_write",
              minimumBindingSize: 32,
              runtimeSized: false,
            },
            slots: projection.bindings[0].slots,
          },
        ]
      : []
  );
  assert.deepEqual(manifest.samplingPairs, []);
  assert.deepEqual(manifest.internalBindings, []);
  assert.deepEqual(manifest.storageBufferSizeRegions, []);
  return manifest;
}

function mergeSemanticModules(modules) {
  assert.equal(modules.length, programSpecifications.length);
  const [baseline] = modules;
  for (const candidate of modules.slice(1)) {
    for (const key of [
      "schemaVersion",
      "contractId",
      "module",
      "abi",
      "layoutModel",
      "capabilities",
    ]) {
      assert.deepEqual(candidate[key], baseline[key]);
    }
  }
  const semantic = {
    schemaVersion: baseline.schemaVersion,
    contractId: baseline.contractId,
    module: structuredClone(baseline.module),
    abi: structuredClone(baseline.abi),
    layoutModel: baseline.layoutModel,
    types: mergeIdentityMaps(
      modules.map(({ types }) => types),
      "type"
    ),
    layouts: mergeIdentityMaps(
      modules.map(({ layouts }) => layouts),
      "layout"
    ),
    programs: modules
      .flatMap(({ programs }) => structuredClone(programs))
      .sort((left, right) => compare(left.name, right.name)),
    capabilities: structuredClone(baseline.capabilities),
  };
  assert.deepEqual(
    semantic.programs.map(({ name }) => name),
    programSpecifications.map(({ semanticProgram }) => semanticProgram)
  );
  return semantic;
}

function mergeIdentityMaps(maps, label) {
  const merged = new Map();
  for (const map of maps) {
    for (const [identity, value] of Object.entries(map)) {
      const previous = merged.get(identity);
      if (previous !== undefined) {
        assert.deepEqual(
          value,
          previous,
          `${label} identity ${identity} has a content collision`
        );
      } else {
        merged.set(identity, structuredClone(value));
      }
    }
  }
  return Object.fromEntries(
    [...merged].sort(([left], [right]) => compare(left, right))
  );
}

function validateSemanticModule(semantic) {
  const schema = JSON.parse(readFileSync(semanticSchemaPath, "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
    schema
  );
  assert.equal(
    validate(semantic),
    true,
    `combined semantic module failed schema validation: ${JSON.stringify(
      validate.errors
    )}`
  );
}

function compileMetalLibrary(records, scratch) {
  for (const tool of ["metal", "metallib"]) {
    const attempt = runCommand("/usr/bin/xcrun", ["-f", tool]);
    if (attempt.error || attempt.signal || attempt.status !== 0) {
      fail(`required Metal tool is unavailable: ${tool}`);
    }
  }
  const airPaths = [];
  for (const { projection, specification } of records) {
    for (const source of metalSourcesForProgramProjection(projection)) {
      const sourcePath = join(
        scratch,
        `${specification.semanticProgram}-${source.stage}.metal`
      );
      const airPath = join(
        scratch,
        `${specification.semanticProgram}-${source.stage}.air`
      );
      writeFileSync(sourcePath, source.msl, "utf8");
      checkedCommand(
        `${specification.semanticProgram}/${source.stage} Metal compilation`,
        "/usr/bin/xcrun",
        [
          "-sdk",
          "macosx",
          "metal",
          "-c",
          sourcePath,
          "-o",
          airPath,
          "-std=macos-metal2.4",
          "-Wno-unused-variable",
          "-target",
          metalTarget,
        ]
      );
      assertNonEmptyFile(
        airPath,
        `${specification.semanticProgram}/${source.stage} AIR`
      );
      airPaths.push(airPath);
    }
  }
  assert.equal(airPaths.length, 3);
  const libraryPath = join(scratch, "compute-draw.metallib");
  checkedCommand("DC1 Metal link", "/usr/bin/xcrun", [
    "-sdk",
    "macosx",
    "metallib",
    ...airPaths,
    "-o",
    libraryPath,
  ]);
  assertNonEmptyFile(libraryPath, "DC1 metallib");
  return libraryPath;
}

function assertCanonicalHandoff(handoff, authoredSource) {
  assert.deepEqual(Object.keys(handoff), [
    "schemaVersion",
    "contractId",
    "semantic",
    "projections",
    "runtimeManifests",
    "evidence",
  ]);
  assert.deepEqual(Object.keys(handoff.evidence), [
    "sourceSha256",
    "programs",
    "metallibSha256",
  ]);
  const expectedNames = programSpecifications.map(
    ({ semanticProgram }) => semanticProgram
  );
  for (const collection of [
    handoff.semantic.programs,
    handoff.projections,
    handoff.runtimeManifests,
    handoff.evidence.programs,
  ]) {
    assert.deepEqual(
      collection.map((value) => value.semanticProgram ?? value.name),
      expectedNames
    );
  }
  for (const projection of handoff.projections) {
    const keys = [
      "semanticProgram",
      "kind",
      "entryPoints",
      "bindings",
      "internalBindings",
      "storageBufferSizeRegions",
      ...(projection.kind === "compute" ? ["resolvedWorkgroupSize"] : []),
      "deviceRequirements",
    ];
    assert.deepEqual(Object.keys(projection), keys);
  }
  for (const manifest of handoff.runtimeManifests) {
    const keys = [
      "schemaVersion",
      "immediateDataLayoutModel",
      "storageBufferSizeModel",
      "semanticProgram",
      "kind",
      "entryPoints",
      "bindings",
      "samplingPairs",
      "internalBindings",
      "storageBufferSizeRegions",
      ...(manifest.kind === "compute" ? ["resolvedWorkgroupSize"] : []),
    ];
    assert.deepEqual(Object.keys(manifest), keys);
    for (const entryPoint of manifest.entryPoints) {
      assert.deepEqual(Object.keys(entryPoint), ["stage", "metal"]);
    }
  }
  for (const program of handoff.evidence.programs) {
    assert.deepEqual(Object.keys(program), [
      "semanticProgram",
      "semanticRequestSha256",
      "semanticResponseSha256",
      "translations",
    ]);
    for (const translation of program.translations) {
      assert.deepEqual(Object.keys(translation), [
        "stage",
        "requestSha256",
        "responseSha256",
        "mslSha256",
      ]);
    }
  }
  assert.equal(
    handoff.evidence.programs.reduce(
      (total, program) => total + program.translations.length,
      0
    ),
    3
  );
  for (const digest of collectDigests(handoff.evidence)) {
    assert.match(digest, /^[a-f0-9]{64}$/u);
  }
  assertNoSourceTextOrPaths(handoff, authoredSource);
}

function assertSourceFreeMetalLibrary(libraryBytes, authoredSource, scratch) {
  const strings =
    libraryBytes.toString("latin1").match(/[\x20-\x7e]{8,}/gu) ?? [];
  const forbiddenPaths = [
    repoRoot,
    spikeDirectory,
    fixturePath,
    scratch,
    configSource,
    generatedVirtualPath,
    "compute-draw.wgsl",
  ];
  for (const value of strings) {
    if (
      forbiddenPaths.some((path) => value.includes(path)) ||
      /(?:^|[\s"'=])\/(?:[^/\s]+\/)+[^/\s]+/u.test(value) ||
      /[A-Za-z]:[\\/](?:[^\\/\s]+[\\/])+[^\\/\s]+/u.test(value) ||
      /file:\/\/[^\s]+/iu.test(value) ||
      /(?:^|[\s"'=])[^\s"']+\.(?:wgsl|metal|msl|air)(?:$|[\s:"'])/iu.test(value)
    ) {
      fail(
        `Metal library contains a path-like string ${JSON.stringify(value)}`
      );
    }
  }
  const recognizableSourceLines = authoredSource
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length >= 16);
  for (const line of recognizableSourceLines) {
    if (libraryBytes.includes(Buffer.from(line, "utf8"))) {
      fail("Metal library contains recognizable authored shader source");
    }
  }
}

function collectDigests(evidence) {
  return [
    evidence.sourceSha256,
    evidence.metallibSha256,
    ...evidence.programs.flatMap((program) => [
      program.semanticRequestSha256,
      program.semanticResponseSha256,
      ...program.translations.flatMap((translation) => [
        translation.requestSha256,
        translation.responseSha256,
        translation.mslSha256,
      ]),
    ]),
  ];
}

function assertNoSourceTextOrPaths(value, authoredSource, key) {
  if (
    key &&
    ["msl", "text", "virtualPath", "originMap", "request", "response"].includes(
      key
    )
  ) {
    fail(
      `source-free handoff contains forbidden property ${JSON.stringify(key)}`
    );
  }
  if (typeof value === "string") {
    if (
      isAbsolute(value) ||
      /^[A-Za-z]:[\\/]/u.test(value) ||
      value === configSource ||
      value === generatedVirtualPath ||
      /\.(?:wgsl|metal|msl|air|metallib)$/iu.test(value)
    ) {
      fail(
        `source-free handoff contains a path-like string ${JSON.stringify(
          value
        )}`
      );
    }
    if (value.length > 32 && authoredSource.includes(value)) {
      fail("source-free handoff contains authored shader text");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSourceTextOrPaths(item, authoredSource);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      assertNoSourceTextOrPaths(child, authoredSource, childKey);
    }
  }
}

function runExternalProbe(executable, libraryPath, handoffPath) {
  const attempts = [
    runCommand(executable, [libraryPath, handoffPath], { timeout: 600_000 }),
    runCommand(executable, [libraryPath, handoffPath], { timeout: 600_000 }),
  ];
  for (const attempt of attempts) {
    if (attempt.error || attempt.signal || attempt.status !== 0) {
      commandFailure("DC1 external probe", attempt);
    }
    if (attempt.stderr !== "") {
      fail(`DC1 external probe wrote stderr: ${attempt.stderr.trim()}`);
    }
  }
  assert.equal(
    attempts[0].stdout,
    attempts[1].stdout,
    "external probe output is not deterministic"
  );
  let report;
  try {
    report = JSON.parse(attempts[0].stdout);
  } catch (error) {
    fail(`external probe returned invalid JSON: ${error.message}`);
  }
  assert.deepEqual(
    report,
    expectedConnectedProbeReport,
    "external probe report does not match the exact DC1 evidence contract"
  );
  return {
    status: "passed",
    gate: report.gate,
    deterministicProcesses: attempts.length,
    reportSha256: sha256(attempts[0].stdout),
  };
}

async function invokeInventory(workerPath, request, requestBytes) {
  const attempt = await invokeEncoded(workerPath, requestBytes);
  let inventory;
  decodeTintWorkerResponse(attempt, (response) => {
    inventory = authenticateSuccessfulInventory({
      configSource,
      request,
      requestBytes,
      response,
    });
    return true;
  });
  assert(inventory);
  return { inventory, stdout: attempt.stdout };
}

async function invokeSemantic(workerPath, finalized, request, requestBytes) {
  const attempt = await invokeEncoded(workerPath, requestBytes);
  let extraction;
  decodeTintWorkerResponse(attempt, (response) => {
    extraction = authenticateSuccessfulSemanticExtraction({
      finalized,
      request,
      requestBytes,
      response,
    });
    return true;
  });
  assert(extraction);
  return { extraction, stdout: attempt.stdout };
}

async function invokeEncoded(workerPath, requestBytes) {
  const worker = startTintWorker({ executable: workerPath });
  try {
    await worker.write(Buffer.from(requestBytes, "utf8"));
    worker.end();
  } catch (error) {
    worker.terminate(error);
  }
  return worker.result;
}

async function invokeTranslation(workerPath, request) {
  const attempt = await invokeRawTintPrototype({
    executable: workerPath,
    request,
  });
  let translation;
  decodeTintWorkerResponse(attempt, (response) => {
    translation = authenticateSuccessfulCompilerTranslation({
      request,
      response,
    });
    return true;
  });
  assert(translation);
  return { attempt, translation };
}

function parseArguments(arguments_) {
  let worker;
  let probe;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--worker" || argument === "--probe") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) usage();
      if (argument === "--worker") {
        if (worker) usage();
        worker = resolve(value);
      } else {
        if (probe) usage();
        probe = resolve(value);
      }
      index += 1;
      continue;
    }
    usage();
  }
  if (!worker) usage();
  assertExecutable(worker, "Tint worker");
  if (probe) assertExecutable(probe, "DC1 external probe");
  return { worker, probe };
}

function usage() {
  fail(
    "usage: compiler-bridge.mjs --worker <executable> [--probe <executable>]"
  );
}

function assertExecutable(path, label) {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    fail(`${label} is not a regular file: ${path}`);
  }
  if ((lstatSync(path).mode & 0o111) === 0) {
    fail(`${label} is not executable: ${path}`);
  }
}

function checkedCommand(label, executable, arguments_) {
  const attempt = runCommand(executable, arguments_, { timeout: 120_000 });
  if (attempt.error || attempt.signal || attempt.status !== 0) {
    commandFailure(label, attempt);
  }
  if (attempt.stderr !== "") {
    fail(`${label} wrote stderr: ${attempt.stderr.trim()}`);
  }
}

function commandFailure(label, attempt) {
  const diagnostic = `${attempt.stdout}${attempt.stderr}`.trim();
  fail(
    `${label} failed with ${
      attempt.signal ? `signal ${attempt.signal}` : `status ${attempt.status}`
    }${diagnostic ? `: ${diagnostic}` : ""}`
  );
}

function assertNonEmptyFile(path, label) {
  if (
    !existsSync(path) ||
    !lstatSync(path).isFile() ||
    lstatSync(path).size === 0
  ) {
    fail(`${label} was not produced as a non-empty file`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`DC1 compiler bridge: ${message}`);
}
