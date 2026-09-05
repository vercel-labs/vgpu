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
} from "../lib/authenticated-compiler-translation.mjs";
import { authenticateSuccessfulInventory } from "../lib/authenticated-inventory.mjs";
import {
  authenticateSuccessfulSemanticExtraction,
  semanticExtractionRequestForFinalizedCapsule,
} from "../lib/authenticated-semantic-extraction.mjs";
import { finalizeProgramCapsule } from "../lib/fullscreen-injection.mjs";
import {
  assembleMetalProgramProjection,
  metalSourcesForProgramProjection,
} from "../lib/metal-program-projection.mjs";
import {
  deterministicStringify,
  encodeInventoryRequest,
  INVENTORY_CONTRACT,
  originMapSha256,
} from "../lib/protocol.mjs";
import { selectProgramEntries } from "../lib/program-selection.mjs";
import { resolveVirtualShaderWithDeclarations } from "../lib/resolved-declarations.mjs";
import {
  isRuntimeResourceLayout,
  runtimeResourceLayoutForMetalProgramProjection,
} from "../lib/runtime-resource-layout.mjs";
import {
  allocateMetalSlotsForAssembly,
  assembleSemanticProgram,
  compilerRequestForAssembledEntry,
} from "../lib/semantic-assembly.mjs";
import { encodeSemanticExtractionRequest } from "../lib/semantic-extraction-protocol.mjs";

const gateDirectory = dirname(fileURLToPath(import.meta.url));
const spikeDirectory = resolve(gateDirectory, "..");
const repoRoot = resolve(spikeDirectory, "../../..");
const fixturePath = join(
  repoRoot,
  "experiments/native-metal-spikes/c4-compute-storage/fixtures/compute-storage.wgsl"
);
const semanticSchemaPath = join(
  repoRoot,
  "docs/plans/native/contracts/semantic-v1.schema.json"
);
const configSource = "Shaders/compute-storage.wgsl";
const generatedVirtualPath = "Intermediate/compute-storage.resolved.wgsl";
const sourceInput = "c4-compute-storage-source";
const handoffContract = "vgpu-native-c1-compute-storage-handoff/v1";
const metalTarget = "air64-apple-macos14.0";
const programSpecifications = Object.freeze([
  Object.freeze({
    semanticProgram: "AdvanceState",
    entryPoint: "advance",
    metalEntryPoint: "vgpu_c4_advance",
    bindingIDs: Object.freeze(["g0b0", "g0b1", "g0b2", "g0b3"]),
    workgroupSize: Object.freeze({ x: 2, y: 1, z: 1 }),
    dispatch: Object.freeze({ x: 2, y: 1, z: 2 }),
    expectedAudit: Object.freeze([101, 2, 1, 2]),
  }),
  Object.freeze({
    semanticProgram: "MixState",
    entryPoint: "mix",
    metalEntryPoint: "vgpu_c4_mix",
    bindingIDs: Object.freeze(["g0b0", "g0b1", "g0b2", "g0b4"]),
    workgroupSize: Object.freeze({ x: 1, y: 2, z: 1 }),
    dispatch: Object.freeze({ x: 2, y: 2, z: 1 }),
    expectedAudit: Object.freeze([202, 2, 2, 1]),
  }),
]);

const options = parseArguments(process.argv.slice(2));
const report = await runGate(options);
process.stdout.write(`${deterministicStringify(report)}\n`);

async function runGate(settings) {
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
    "compute-storage inventory is not byte-deterministic"
  );
  assert.deepEqual(
    inventoryAttempts[0].inventory,
    inventoryAttempts[1].inventory
  );
  const inventory = inventoryAttempts[0].inventory;
  assert.deepEqual(
    inventory.entryPoints,
    programSpecifications.map(({ entryPoint }) => ({
      stage: "compute",
      wgsl: entryPoint,
    }))
  );

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

  const scratch = mkdtempSync(join(tmpdir(), "vgpu-c4-c1-compute-storage-"));
  try {
    const libraryPath = compileMetalLibrary(records, scratch);
    const libraryBytes = readFileSync(libraryPath);
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
    const repeatedHandoffBytes = deterministicStringify(
      structuredClone(handoff)
    );
    assert.equal(handoffBytes, repeatedHandoffBytes);
    const handoffPath = join(scratch, "compute-storage-handoff.json");
    writeFileSync(handoffPath, handoffBytes, "utf8");

    const probe = settings.probe
      ? runExternalProbe(settings.probe, libraryPath, handoffPath)
      : { status: "skipped", reason: "no external probe supplied" };

    return {
      schemaVersion: 1,
      gate: "c1-compute-storage",
      status: "passed",
      resolverCalls,
      inventory: {
        deterministicRuns: inventoryAttempts.length,
        requestSha256: sha256(inventoryBytes),
        responseSha256: sha256(inventoryAttempts[0].stdout),
      },
      programs: records.map(({ evidence, projection, specification }) => ({
        semanticProgram: specification.semanticProgram,
        entryPoint: specification.entryPoint,
        bindings: [...specification.bindingIDs],
        resolvedWorkgroupSize: structuredClone(
          projection.resolvedWorkgroupSize
        ),
        dispatch: structuredClone(specification.dispatch),
        expectedAudit: [...specification.expectedAudit],
        deterministicSemanticExtractions: 2,
        deterministicTranslations: 2,
        ...structuredClone(evidence),
      })),
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
      kind: "compute",
      entryPoints: { compute: specification.entryPoint },
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
  const presentation = {
    module: {
      name: "ComputeStorageFixtures",
      swiftName: "ComputeStorageFixtures",
    },
    program: { swiftName: specification.semanticProgram },
  };
  const assembly = assembleSemanticProgram({
    presentation,
    finalized,
    extraction: semanticAttempts[0].extraction,
    declarations,
  });
  const semanticProgram = assembly.semantic.programs[0];
  assert.equal(semanticProgram.name, specification.semanticProgram);
  assert.equal(
    semanticProgram.entryPoints.compute.names.wgsl,
    specification.entryPoint
  );
  assert.deepEqual(
    semanticProgram.entryPoints.compute.bindings,
    specification.bindingIDs
  );
  assert.deepEqual(
    semanticProgram.entryPoints.compute.workgroupSize,
    specification.workgroupSize
  );
  assert.deepEqual(
    semanticProgram.bindings.map(({ id }) => id),
    specification.bindingIDs
  );
  assert.deepEqual(
    semanticProgram.bindings.map(({ access }) => access),
    ["read", "read", "read_write", "read_write"]
  );
  assert.deepEqual(
    semanticProgram.bindings.map(({ swiftName }) => swiftName),
    [
      "src",
      "mask",
      "dst",
      specification.entryPoint === "advance" ? "advanceAudit" : "mixAudit",
    ]
  );

  const allocation = allocateMetalSlotsForAssembly({ assembly });
  const compilerRequest = compilerRequestForAssembledEntry({
    assembly,
    allocation,
    stage: "compute",
    metalEntryPoint: specification.metalEntryPoint,
  });
  const translationAttempts = await Promise.all([
    invokeTranslation(worker, compilerRequest),
    invokeTranslation(worker, compilerRequest),
  ]);
  assert.equal(
    translationAttempts[0].attempt.stdout,
    translationAttempts[1].attempt.stdout,
    `${specification.semanticProgram} translation is not byte-deterministic`
  );
  assert.deepEqual(
    compilerResponseForTranslation(translationAttempts[0].translation),
    compilerResponseForTranslation(translationAttempts[1].translation)
  );
  const projection = assembleMetalProgramProjection({
    assembly,
    allocation,
    translations: [translationAttempts[0].translation],
  });
  assert.equal(projection.semanticProgram, specification.semanticProgram);
  assert.deepEqual(
    projection.bindings.map(({ semanticBinding }) => semanticBinding),
    specification.bindingIDs
  );
  assert.deepEqual(
    projection.resolvedWorkgroupSize,
    specification.workgroupSize
  );
  const runtimeManifest = runtimeManifestForProgram({
    compilerRequest,
    projection,
  });
  return {
    assembly,
    projection,
    runtimeManifest,
    specification,
    evidence: {
      semanticRequestSha256: sha256(semanticRequestBytes),
      semanticResponseSha256: sha256(semanticAttempts[0].stdout),
      requestSha256: sha256(JSON.stringify(compilerRequest)),
      responseSha256: sha256(translationAttempts[0].attempt.stdout),
      mslSha256: sha256(
        compilerResponseForTranslation(translationAttempts[0].translation)
          .result.msl
      ),
    },
  };
}

function runtimeManifestForProgram({ compilerRequest, projection }) {
  const runtimeLayout =
    runtimeResourceLayoutForMetalProgramProjection(projection);
  assert(isRuntimeResourceLayout(runtimeLayout));
  const sources = metalSourcesForProgramProjection(projection);
  const manifest = {
    schemaVersion: 1,
    immediateDataLayoutModel: compilerRequest.metal.immediateDataLayoutModel,
    storageBufferSizeModel: compilerRequest.metal.storageBufferSizes.model,
    semanticProgram: runtimeLayout.semanticProgram,
    kind: runtimeLayout.kind,
    entryPoints: sources.map(({ stage, entryPoint }) => ({
      stage,
      metal: entryPoint,
    })),
    bindings: runtimeLayout.bindings,
    samplingPairs: runtimeLayout.samplingPairs,
    internalBindings: projection.internalBindings,
    storageBufferSizeRegions: projection.storageBufferSizeRegions,
    resolvedWorkgroupSize: projection.resolvedWorkgroupSize,
  };
  assert.deepEqual(manifest.entryPoints, [
    {
      stage: "compute",
      metal: programSpecifications.find(
        ({ semanticProgram }) => semanticProgram === manifest.semanticProgram
      ).metalEntryPoint,
    },
  ]);
  assert.deepEqual(
    manifest.bindings.map(({ descriptor }) => descriptor),
    [
      bufferDescriptor("read"),
      bufferDescriptor("read"),
      bufferDescriptor("read_write"),
      bufferDescriptor("read_write"),
    ]
  );
  assert.deepEqual(manifest.samplingPairs, []);
  return manifest;
}

function bufferDescriptor(access) {
  return {
    kind: "buffer",
    addressSpace: "storage",
    access,
    minimumBindingSize: 4,
    runtimeSized: true,
  };
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
    const [source] = metalSourcesForProgramProjection(projection);
    assert.equal(source.stage, "compute");
    assert.equal(source.entryPoint, specification.metalEntryPoint);
    const sourcePath = join(scratch, `${specification.semanticProgram}.metal`);
    const airPath = join(scratch, `${specification.semanticProgram}.air`);
    writeFileSync(sourcePath, source.msl, "utf8");
    checkedCommand(
      `${specification.semanticProgram} offline Metal compilation`,
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
    assertNonEmptyFile(airPath, `${specification.semanticProgram} AIR`);
    airPaths.push(airPath);
  }
  const libraryPath = join(scratch, "compute-storage.metallib");
  checkedCommand("compute-storage Metal link", "/usr/bin/xcrun", [
    "-sdk",
    "macosx",
    "metallib",
    ...airPaths,
    "-o",
    libraryPath,
  ]);
  assertNonEmptyFile(libraryPath, "compute-storage metallib");
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
  for (const digest of [
    handoff.evidence.sourceSha256,
    handoff.evidence.metallibSha256,
    ...handoff.evidence.programs.flatMap(
      ({
        semanticRequestSha256,
        semanticResponseSha256,
        requestSha256,
        responseSha256,
        mslSha256,
      }) => [
        semanticRequestSha256,
        semanticResponseSha256,
        requestSha256,
        responseSha256,
        mslSha256,
      ]
    ),
  ]) {
    assert.match(digest, /^[a-f0-9]{64}$/u);
  }
  assertNoSourceTextOrPaths(handoff, authoredSource);
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
      commandFailure("C4 compute-storage probe", attempt);
    }
    if (attempt.stderr !== "") {
      fail(`C4 compute-storage probe wrote stderr: ${attempt.stderr.trim()}`);
    }
  }
  assert.equal(
    attempts[0].stdout,
    attempts[1].stdout,
    "C4 compute-storage probe output is not deterministic"
  );
  let report;
  try {
    report = JSON.parse(attempts[0].stdout);
  } catch (error) {
    fail(`C4 compute-storage probe returned invalid JSON: ${error.message}`);
  }
  assert.equal(report?.schemaVersion, 1);
  assert.equal(report?.gate, "c4-compute-storage");
  assert.equal(report?.status, "passed");
  return {
    status: "passed",
    gate: report.gate,
    deterministicProcesses: attempts.length,
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
  if (probe) assertExecutable(probe, "compute-storage probe");
  return { worker, probe };
}

function usage() {
  fail(
    "usage: compute-storage.mjs --worker <executable> [--probe <executable>]"
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
  throw new Error(`C1 compute storage: ${message}`);
}
