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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  decodeTintWorkerResponse,
  invokeRawTintPrototype,
  runCommand,
  startTintWorker,
} from "../../c1-compiler-protocol/lib/native-compiler.mjs";
import {
  assertRequestSemantics,
  assertResponseSemantics,
  attachDiagnosticOrigins,
  COMPILER_CONTRACT,
  sha256Utf8,
} from "../../c1-compiler-protocol/lib/protocol.mjs";
import { authenticateSuccessfulInventory } from "../lib/authenticated-inventory.mjs";
import {
  finalizeProgramCapsule,
  inventoryRequestForFinalizedCapsule,
} from "../lib/fullscreen-injection.mjs";
import {
  assertInventoryRequestSemantics,
  encodeInventoryRequest,
  INVENTORY_COMPILER,
  INVENTORY_CONTRACT,
  inventoryRequestIdentity,
  originMapSha256,
} from "../lib/protocol.mjs";
import { selectProgramEntries } from "../lib/program-selection.mjs";

const spikeDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(spikeDirectory, "fixtures", "fullscreen-metal.wgsl");
const interfacePath = join(
  spikeDirectory,
  "fixtures",
  "fullscreen-metal-interfaces.json"
);
const swiftProbePath = join(spikeDirectory, "gates", "fullscreen-metal.swift");
const configSource = "Fixtures/fullscreen-metal.wgsl";
const virtualPath = "Intermediate/fullscreen-metal.resolved.wgsl";
const metalTarget = "air64-apple-macos14.0";
const emittedNames = Object.freeze({
  vertex: "vgpu_fullscreen_canary_vertex",
  fragment: "vgpu_fullscreen_canary_fragment",
});
const expectedSnapshots = Object.freeze({
  sourceSha256:
    "059ed1451b4eef55123dd26a7ca13fce4bc71ab3ea96cb313f214ef669c5ae9d",
  interfacesSha256:
    "1ce79b30182ddfdcf93617aeea8d0937cecfbbb6a9ea76389582a6880b19f175",
  runtimeProbeSha256:
    "99f261cb3457e57193fc182e24c9f740041778f19f4cf3aa557caef362380545",
  finalizedSourceSha256:
    "580a5133e4f0a322ea2dc1bc079bcb3c4c49d72c4854c49bb4ea41fa4f17e065",
  vertex: Object.freeze({
    wgsl: "vgpu_fullscreen_vertex_cce722361ea5b6e92c6cf9ef0b196673a5fe112f439f0e835c0d26c742b501f7",
    requestSha256:
      "9d61356fb0cc9ebb7d707dfae1e9764f628ade62a82078b0d8ed2396b7d5b679",
    responseSha256:
      "8bdb212a8799529d95db40474c9478fe71b5b1861fbb8b24b760fefaef5d9783",
    mslSha256:
      "7cb04513be8345f3dc4dc32e466aa32f663ce13bf4b732be10bd2019518ae8a8",
  }),
  fragment: Object.freeze({
    wgsl: "shade",
    requestSha256:
      "527f28fc53d1f6945a4f2358e0f0fbb5b80b8a17eca603b7e7985a393c306c8f",
    responseSha256:
      "1b62d5710d88d9ebcb9887c4bce90adfd4c3749248fc76abdd4a93c0d36acbfa",
    mslSha256:
      "3133d09a7930aa74835ffce45dce438689f684e5f0d2193391520a59fb5ceaf7",
  }),
  rejectedInterface: Object.freeze({
    message: "request semantic interface differs from selected-entry core IR",
    requestSha256:
      "9d255772427c4d4984703a2f8f349abf7b32148a511c53476ab70629fd05763b",
    responseSha256:
      "5e9309a88aaf82dff9e7d67d41b5446ac6df65f334fbeb29ac4750252d637128",
  }),
});
const expectedInternalReservations = Object.freeze([
  Object.freeze({
    role: "immediate-data",
    slots: Object.freeze([
      Object.freeze({
        mode: "direct",
        resourceClass: "buffer",
        component: "buffer",
        index: 30,
        count: 1,
      }),
    ]),
  }),
]);
let compilerWorkerLaunches = 0;

const options = parseArguments(process.argv.slice(2));
const validators = loadCompilerValidators();
const sourceText = readFileSync(fixturePath, "utf8");
const interfaces = JSON.parse(readFileSync(interfacePath, "utf8"));
const inventoryRequest = makeInventoryRequest(sourceText);
assertInventoryRequestSemantics(inventoryRequest);
assertStaticFixture();
const fixtureInventory = authenticateFixtureInventory(inventoryRequest);
const fixtureFinalized = finalizeFixture(fixtureInventory);
const fixtureRequests = translationRequests(fixtureFinalized);
assertFullscreenRenderLink(fixtureRequests);
assertRequestSnapshots(fixtureRequests);
const launchesBeforePreflightFailure = compilerWorkerLaunches;
const noncanonical = structuredClone(fixtureRequests[0]);
noncanonical.semanticInterface.outputs.reverse();
expectProtocolError(
  () => assertRequestSemantics(noncanonical),
  "VGPU-C1-PROTOCOL-CANONICAL"
);
assert.equal(compilerWorkerLaunches, launchesBeforePreflightFailure);

const result = {
  gate: "fullscreen-metal",
  status: "static-passed",
  static: {
    status: "passed",
    sourceSha256: inventoryRequest.source.sha256,
    interfacesSha256: sha256File(interfacePath),
    runtimeProbeSha256: sha256File(swiftProbePath),
    finalizedSourceSha256: fixtureFinalized.capsule.source.sha256,
    translationRequests: fixtureRequests.map((request) => ({
      stage: request.entryPoint.stage,
      sha256: sha256Utf8(JSON.stringify(request)),
    })),
    prelaunchFailures: 1,
    compilerWorkerLaunches: 0,
  },
  translation: { status: "skipped", reason: "no worker supplied" },
  offlineMetal: { status: "skipped", reason: "requires translation" },
  metalRuntime: { status: "skipped", reason: "requires metallib" },
};

if (options.worker) {
  const authoredInventory = await invokeInventory(
    options.worker,
    inventoryRequest
  );
  assert.deepEqual(authoredInventory, fixtureInventory);
  const finalized = finalizeFixture(authoredInventory);
  assert.deepEqual(finalized, fixtureFinalized);

  const requests = translationRequests(finalized);
  assertFullscreenRenderLink(requests);
  assertRequestSnapshots(requests);
  assert.deepEqual(requests, fixtureRequests);

  const translated = [];
  for (const request of requests) {
    translated.push(await translateTwice(options.worker, request));
  }
  assertResponseSnapshots(translated);
  expectProtocolError(
    () => assertResponseSemantics(requests[0], translated[1].response),
    "VGPU-C1-PROTOCOL-ENTRY"
  );
  const rejectedInterface = await rejectMismatchedInterface(
    options.worker,
    requests[0]
  );
  result.translation = {
    status: "passed",
    inventoryInvocations: 1,
    successfulCompilerInvocations: requests.length * 2,
    rejectedCompilerInvocations: 2,
    compilerInvocations: compilerWorkerLaunches,
    totalNativeProcesses: 1 + compilerWorkerLaunches,
    deterministic: true,
    structuredFailures: 1,
    rejectedInterface,
    finalizedSourceSha256: finalized.capsule.source.sha256,
    entries: translated.map(
      ({ request, response, stdoutSha256, mslSha256 }) => ({
        stage: request.entryPoint.stage,
        wgsl: request.entryPoint.wgsl,
        metal: response.result.entryPoint.metal,
        requestSha256: sha256Utf8(JSON.stringify(request)),
        responseSha256: stdoutSha256,
        mslSha256,
      })
    ),
  };

  const scratch = mkdtempSync(join(tmpdir(), "vgpu-fullscreen-metal-"));
  try {
    const offline = compileOfflineMetal(translated, scratch, options);
    result.offlineMetal = offline.report;
    if (offline.libraryPath && !options.skipMetalRuntime) {
      result.metalRuntime = runMetalRuntime(
        offline.libraryPath,
        scratch,
        translated,
        options.requireMetalRuntime
      );
    } else if (options.skipMetalRuntime) {
      result.metalRuntime = { status: "skipped", reason: "requested-by-flag" };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  result.status = "passed";
}

if (options.requireWorker && result.translation.status !== "passed") {
  fail("a native worker was required but translation did not run");
}
if (options.requireOfflineMetal && result.offlineMetal.status !== "passed") {
  fail("offline Metal was required but did not pass");
}
if (options.requireMetalRuntime && result.metalRuntime.status !== "passed") {
  fail("the Metal runtime was required but did not pass");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function parseArguments(argv) {
  const parsed = {
    worker: process.env.C1_SEMANTIC_BRIDGE_FULLSCREEN_METAL_WORKER,
    requireWorker:
      process.env.C1_SEMANTIC_BRIDGE_FULLSCREEN_METAL_REQUIRE_WORKER === "1",
    requireOfflineMetal:
      process.env.C1_SEMANTIC_BRIDGE_FULLSCREEN_REQUIRE_OFFLINE_METAL === "1",
    requireMetalRuntime:
      process.env.C1_SEMANTIC_BRIDGE_FULLSCREEN_REQUIRE_METAL_RUNTIME === "1",
    skipMetalRuntime:
      process.env.C1_SEMANTIC_BRIDGE_FULLSCREEN_SKIP_METAL_RUNTIME === "1",
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--help", "-h"].includes(argument)) {
      process.stdout.write(
        "Usage: node gates/fullscreen-metal.mjs [--worker <compiler>] " +
          "[--require-worker] [--require-offline-metal] " +
          "[--require-metal-runtime] [--skip-metal-runtime]\n"
      );
      process.exit(0);
    }
    if (
      [
        "--require-worker",
        "--require-offline-metal",
        "--require-metal-runtime",
        "--skip-metal-runtime",
      ].includes(argument)
    ) {
      if (seen.has(argument)) fail(`${argument} may appear only once`);
      seen.add(argument);
      parsed[
        {
          "--require-worker": "requireWorker",
          "--require-offline-metal": "requireOfflineMetal",
          "--require-metal-runtime": "requireMetalRuntime",
          "--skip-metal-runtime": "skipMetalRuntime",
        }[argument]
      ] = true;
      continue;
    }
    if (argument === "--worker") {
      if (seen.has(argument)) fail(`${argument} may appear only once`);
      seen.add(argument);
      const worker = argv[++index];
      if (!worker) fail(`${argument} requires a value`);
      parsed.worker = resolve(worker);
      continue;
    }
    fail(`unknown argument ${argument}`);
  }
  if (parsed.worker) parsed.worker = resolve(parsed.worker);
  if (
    parsed.worker &&
    (!existsSync(parsed.worker) || !lstatSync(parsed.worker).isFile())
  ) {
    fail(`worker is not a regular file: ${parsed.worker}`);
  }
  if (parsed.skipMetalRuntime && parsed.requireMetalRuntime) {
    fail("--skip-metal-runtime conflicts with --require-metal-runtime");
  }
  if (parsed.requireMetalRuntime) parsed.requireOfflineMetal = true;
  if (
    !parsed.worker &&
    (parsed.requireWorker ||
      parsed.requireOfflineMetal ||
      parsed.requireMetalRuntime)
  ) {
    fail("required native gates need --worker or its environment equivalent");
  }
  return parsed;
}

function assertStaticFixture() {
  assert.equal(inventoryRequest.source.sha256, expectedSnapshots.sourceSha256);
  assert.equal(sha256File(interfacePath), expectedSnapshots.interfacesSha256);
  assert.equal(
    sha256File(swiftProbePath),
    expectedSnapshots.runtimeProbeSha256
  );
  assert.deepEqual(Object.keys(interfaces), ["fragment", "vertex"]);
  assert.equal(interfaces.vertex.kind, "vertex");
  assert.equal(interfaces.fragment.kind, "fragment");
  assert(
    sourceText.includes("@builtin(front_facing) front_facing: bool") &&
      sourceText.includes("@location(0) uv: vec2f")
  );
  assert.deepEqual(
    interfaces.fragment.inputs.map((value) => value.location ?? value.builtin),
    [0, "front_facing"]
  );
  assert.deepEqual(
    interfaces.vertex.outputs.map((value) => value.location ?? value.builtin),
    [0, "position"]
  );
}

function assertFullscreenRenderLink(requests) {
  const vertex = requests.find(
    (request) => request.entryPoint.stage === "vertex"
  );
  const fragment = requests.find(
    (request) => request.entryPoint.stage === "fragment"
  );
  assert(vertex && fragment);
  const vertexLocations = vertex.semanticInterface.outputs.filter(
    (value) => value.location !== undefined
  );
  const fragmentLocations = fragment.semanticInterface.inputs.filter(
    (value) => value.location !== undefined
  );
  assert.equal(vertexLocations.length, 1);
  assert.equal(fragmentLocations.length, 1);
  assert.deepEqual(fragmentLocations[0], vertexLocations[0]);
}

function makeInventoryRequest(text) {
  const sourceSha256 = sha256Utf8(text);
  const originMap = {
    schemaVersion: 1,
    contractId: "vgpu-native-origin-map/v1",
    generatedSource: { virtualPath, sha256: sourceSha256 },
    sources: [{ input: configSource, sha256: sourceSha256 }],
    segments: [
      {
        generated: {
          startByte: 0,
          endByte: Buffer.byteLength(text, "utf8"),
        },
        origin: { input: configSource },
        precision: "module",
      },
    ],
  };
  return {
    schemaVersion: 1,
    contractId: INVENTORY_CONTRACT,
    source: { virtualPath, sha256: sourceSha256, text },
    originMap,
    originMapSha256: originMapSha256(originMap),
    languageFeatures: [],
  };
}

function authenticateFixtureInventory(request) {
  const requestBytes = encodeInventoryRequest(request);
  return authenticateSuccessfulInventory({
    configSource,
    request,
    requestBytes,
    response: {
      schemaVersion: 1,
      contractId: INVENTORY_CONTRACT,
      ok: true,
      requestIdentity: inventoryRequestIdentity(requestBytes),
      compiler: INVENTORY_COMPILER,
      diagnostics: [],
      result: { entryPoints: [{ stage: "fragment", wgsl: "shade" }] },
    },
  });
}

function finalizeFixture(inventory) {
  assert.deepEqual(inventory.entryPoints, [
    { stage: "fragment", wgsl: "shade" },
  ]);
  const selection = selectProgramEntries(
    { name: "FullscreenMetalCanary", source: configSource, kind: "effect" },
    inventory
  );
  const finalized = finalizeProgramCapsule({ inventory, selection });
  const finalInventoryRequest = inventoryRequestForFinalizedCapsule(finalized);
  assert(Object.isFrozen(finalInventoryRequest));
  assert.equal(
    originMapSha256(finalized.capsule.originMap),
    finalized.capsule.originMapSha256
  );
  assert.equal(
    finalized.capsule.source.sha256,
    expectedSnapshots.finalizedSourceSha256
  );
  return finalized;
}

async function invokeInventory(executable, request) {
  const requestBytes = encodeInventoryRequest(request);
  const worker = startTintWorker({ executable });
  try {
    await worker.write(Buffer.from(requestBytes, "utf8"));
    worker.end();
  } catch (error) {
    worker.terminate(error);
  }
  const attempt = await worker.result;
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
  assert.deepEqual(
    inventory.requestIdentity,
    inventoryRequestIdentity(requestBytes)
  );
  return inventory;
}

function translationRequests(finalized) {
  const common = {
    schemaVersion: 1,
    contractId: COMPILER_CONTRACT,
    source: structuredClone(finalized.capsule.source),
    originMap: structuredClone(finalized.capsule.originMap),
    overrides: [],
    languageFeatures: [...finalized.capsule.languageFeatures],
    metal: {
      bindingModel: "vgpu-metal-binding-slots-v1",
      bindings: [],
      internalReservations: structuredClone(expectedInternalReservations),
      storageBufferSizes: {
        model: "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
        immediateDataByteOffset: 4,
      },
    },
  };
  const requests = [
    {
      ...structuredClone(common),
      entryPoint: {
        stage: "vertex",
        wgsl: finalized.selection.entryPoints.vertex.names.wgsl,
        metal: emittedNames.vertex,
      },
      semanticInterface: structuredClone(interfaces.vertex),
    },
    {
      ...structuredClone(common),
      entryPoint: {
        stage: "fragment",
        wgsl: finalized.selection.entryPoints.fragment.names.wgsl,
        metal: emittedNames.fragment,
      },
      semanticInterface: structuredClone(interfaces.fragment),
    },
  ];
  for (const request of requests) {
    assertSchema(
      validators.request,
      request,
      `${request.entryPoint.stage} request`
    );
    assertRequestSemantics(request);
    freezeJson(request);
  }
  return requests;
}

async function translateTwice(executable, request) {
  const attempts = await Promise.all([
    invokeCompiler(executable, request),
    invokeCompiler(executable, request),
  ]);
  if (attempts[0].stdout !== attempts[1].stdout) {
    fail(`${request.entryPoint.stage} translation is not byte-deterministic`);
  }
  const responses = attempts.map((attempt, index) => {
    const raw = decodeTintWorkerResponse(attempt, (response) =>
      assertSchema(
        validators.response,
        response,
        `${request.entryPoint.stage} response ${index + 1}`
      )
    );
    const response = attachDiagnosticOrigins(request, raw);
    assertSchema(
      validators.response,
      response,
      `${request.entryPoint.stage} enriched response ${index + 1}`
    );
    assertResponseSemantics(request, response);
    if (!response.ok) {
      fail(
        `${request.entryPoint.stage} translation failed: ${JSON.stringify(
          response.diagnostics
        )}`
      );
    }
    assertExactSuccessfulTranslation(request, response);
    return response;
  });
  assert.deepEqual(responses[0], responses[1]);
  return {
    request,
    response: responses[0],
    stdoutSha256: sha256Utf8(attempts[0].stdout),
    mslSha256: sha256Utf8(responses[0].result.msl),
  };
}

function invokeCompiler(executable, request) {
  compilerWorkerLaunches += 1;
  return invokeRawTintPrototype({ executable, request });
}

async function rejectMismatchedInterface(executable, vertexRequest) {
  const request = structuredClone(vertexRequest);
  request.semanticInterface.outputs[0].type.width = 3;
  assertSchema(validators.request, request, "mismatched interface request");
  assertRequestSemantics(request);
  freezeJson(request);
  const attempts = await Promise.all([
    invokeCompiler(executable, request),
    invokeCompiler(executable, request),
  ]);
  assert.equal(attempts[0].stdout, attempts[1].stdout);
  const responses = attempts.map((attempt, index) => {
    const raw = decodeTintWorkerResponse(attempt, (response) =>
      assertSchema(
        validators.response,
        response,
        `mismatched interface response ${index + 1}`
      )
    );
    const response = attachDiagnosticOrigins(request, raw);
    assertSchema(
      validators.response,
      response,
      `mismatched enriched interface response ${index + 1}`
    );
    assertResponseSemantics(request, response);
    assertNoPhysicalPaths(response);
    return response;
  });
  assert.deepEqual(responses[0], responses[1]);
  const response = responses[0];
  assert.equal(response.ok, false);
  assert(!Object.hasOwn(response, "result"));
  assert.equal(response.diagnostics.length, 1);
  const [diagnostic] = response.diagnostics;
  assert.equal(diagnostic.severity, "error");
  assert.equal(diagnostic.phase, "inspect");
  assert.equal(diagnostic.code, "VGPU-NATIVE-TINT-INTERFACE");
  assert.equal(diagnostic.message, expectedSnapshots.rejectedInterface.message);
  const observed = {
    code: diagnostic.code,
    deterministicRuns: attempts.length,
    message: diagnostic.message,
    phase: diagnostic.phase,
    requestSha256: sha256Utf8(JSON.stringify(request)),
    responseSha256: sha256Utf8(attempts[0].stdout),
    workerExitStatus: attempts[0].status,
  };
  assert.equal(
    observed.requestSha256,
    expectedSnapshots.rejectedInterface.requestSha256
  );
  assert.equal(
    observed.responseSha256,
    expectedSnapshots.rejectedInterface.responseSha256
  );
  return observed;
}

function assertExactSuccessfulTranslation(request, response) {
  assert.deepEqual(response.diagnostics, []);
  const expectedInterface =
    request.entryPoint.stage === "vertex"
      ? { kind: "vertex", attributes: [] }
      : {
          kind: "fragment",
          colorOutputs: [
            {
              semantic: { location: 0 },
              metal: { color: 0 },
            },
          ],
        };
  assert.deepEqual(response.result.entryPoint, request.entryPoint);
  assert.deepEqual(response.result.interface, expectedInterface);
  assert.deepEqual(response.result.bindings, []);
  assert.deepEqual(response.result.internalBindings, []);
  assert.deepEqual(response.result.storageBufferSizeRegions, []);
  assert(!Object.hasOwn(response.result, "resolvedWorkgroupSize"));
  assert.equal(typeof response.result.msl, "string");
  assert(response.result.msl.length > 0);
  assertNoPhysicalPaths(response);
}

function assertNoPhysicalPaths(value) {
  assert(
    !/(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\)/u.test(
      JSON.stringify(value)
    )
  );
}

function assertRequestSnapshots(requests) {
  for (const request of requests) {
    const stage = request.entryPoint.stage;
    const expected = expectedSnapshots[stage];
    assert(expected);
    assert.equal(request.entryPoint.wgsl, expected.wgsl);
    assert.equal(sha256Utf8(JSON.stringify(request)), expected.requestSha256);
  }
}

function assertResponseSnapshots(translated) {
  for (const item of translated) {
    const expected = expectedSnapshots[item.request.entryPoint.stage];
    assert.equal(item.stdoutSha256, expected.responseSha256);
    assert.equal(item.mslSha256, expected.mslSha256);
  }
}

function loadCompilerValidators() {
  const contractDirectory = resolve(
    spikeDirectory,
    "../c1-compiler-protocol/contracts"
  );
  const schemas = [
    readJson(join(contractDirectory, "origin-map-v1.schema.json")),
    readJson(join(contractDirectory, "request-v1.schema.json")),
    readJson(join(contractDirectory, "response-v1.schema.json")),
  ];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) ajv.addSchema(schema);
  return {
    request: ajv.getSchema(schemas[1].$id),
    response: ajv.getSchema(schemas[2].$id),
  };
}

function assertSchema(validate, value, label) {
  if (!validate(value)) {
    fail(`${label} failed JSON Schema: ${JSON.stringify(validate.errors)}`);
  }
  return true;
}

function compileOfflineMetal(translated, scratch, settings) {
  if (process.platform !== "darwin") {
    return skippedOffline(settings, "host-is-not-macos");
  }
  const missing = ["metal", "metallib"].filter((tool) => !xcrunToolWorks(tool));
  if (missing.length > 0) {
    return skippedOffline(settings, `missing-xcrun-tools:${missing.join(",")}`);
  }

  const airFiles = [];
  for (const item of translated) {
    const stage = item.request.entryPoint.stage;
    const metalSource = join(scratch, `${stage}.metal`);
    const air = join(scratch, `${stage}.air`);
    writeFileSync(metalSource, item.response.result.msl, "utf8");
    checkedCommand(`offline Metal compilation for ${stage}`, "xcrun", [
      "-sdk",
      "macosx",
      "metal",
      "-c",
      metalSource,
      "-o",
      air,
      "-std=macos-metal2.4",
      "-target",
      metalTarget,
    ]);
    if (
      !existsSync(air) ||
      !lstatSync(air).isFile() ||
      lstatSync(air).size === 0
    ) {
      fail(`offline Metal did not produce a non-empty ${stage} AIR file`);
    }
    airFiles.push(air);
  }
  const libraryPath = join(scratch, "fullscreen.metallib");
  checkedCommand("offline Metal link", "xcrun", [
    "-sdk",
    "macosx",
    "metallib",
    ...airFiles,
    "-o",
    libraryPath,
  ]);
  if (
    !existsSync(libraryPath) ||
    !lstatSync(libraryPath).isFile() ||
    lstatSync(libraryPath).size === 0
  ) {
    fail("offline Metal did not produce a non-empty metallib");
  }
  return {
    libraryPath,
    report: {
      status: "passed",
      shaders: translated.length,
      target: metalTarget,
      libraryBytes: lstatSync(libraryPath).size,
    },
  };
}

function skippedOffline(settings, reason) {
  if (settings.requireOfflineMetal) {
    fail(`offline Metal is required: ${reason}`);
  }
  return { libraryPath: undefined, report: { status: "skipped", reason } };
}

function runMetalRuntime(libraryPath, scratch, translated, required) {
  if (process.platform !== "darwin") {
    if (required) fail("Metal runtime requires macOS");
    return { status: "skipped", reason: "host-is-not-macos" };
  }
  const executable = join(scratch, "fullscreen-metal-probe");
  const architecture = { arm64: "arm64", x64: "x86_64" }[process.arch];
  if (!architecture) {
    if (required)
      fail(`unsupported Metal runtime architecture ${process.arch}`);
    return {
      status: "skipped",
      reason: `unsupported-architecture:${process.arch}`,
    };
  }
  checkedCommand("Swift Metal probe compilation", "xcrun", [
    "swiftc",
    "-O",
    "-target",
    `${architecture}-apple-macosx14.0`,
    "-framework",
    "Foundation",
    "-framework",
    "Metal",
    swiftProbePath,
    "-o",
    executable,
  ]);
  const projectedNames = Object.fromEntries(
    translated.map((item) => [
      item.response.result.entryPoint.stage,
      item.response.result.entryPoint.metal,
    ])
  );
  const args = [libraryPath, projectedNames.vertex, projectedNames.fragment];
  const attempts = [runCommand(executable, args), runCommand(executable, args)];
  if (
    attempts.every(
      (attempt) =>
        attempt.status !== 0 &&
        `${attempt.stdout}${attempt.stderr}`.includes(
          "No default Metal device is available"
        )
    )
  ) {
    if (required) fail("Metal runtime found no default device");
    return { status: "skipped", reason: "no-metal-device" };
  }
  for (const attempt of attempts) {
    if (
      attempt.error ||
      attempt.signal ||
      attempt.status !== 0 ||
      attempt.stderr !== ""
    ) {
      commandFailure("Metal runtime probe", attempt);
    }
  }
  if (attempts[0].stdout !== attempts[1].stdout) {
    fail("Metal runtime output is not deterministic");
  }
  const report = JSON.parse(attempts[0].stdout);
  assert.deepEqual(
    report.counterClockwise,
    [64, 64, 255, 255, 191, 64, 255, 255, 64, 191, 255, 255, 191, 191, 255, 255]
  );
  assert.deepEqual(
    report.clockwise,
    [64, 64, 0, 255, 191, 64, 0, 255, 64, 191, 0, 255, 191, 191, 0, 255]
  );
  if (typeof report.device !== "string" || report.device.length === 0) {
    fail("Metal runtime output omitted the device name");
  }
  return {
    status: "passed",
    deterministicRuns: attempts.length,
    device: report.device,
    readbacks: 2,
    pixelsPerReadback: 4,
    frontFacingWinding: "counter-clockwise",
  };
}

function xcrunToolWorks(tool) {
  const lookup = runCommand("xcrun", ["--find", tool]);
  if (
    lookup.error ||
    lookup.signal ||
    lookup.status !== 0 ||
    lookup.stdout.trim() === ""
  ) {
    return false;
  }
  const version = runCommand("xcrun", [tool, "--version"]);
  return !version.error && !version.signal && version.status === 0;
}

function checkedCommand(owner, command, args) {
  const attempt = runCommand(command, args, { timeout: 120_000 });
  if (attempt.error || attempt.signal || attempt.status !== 0) {
    commandFailure(owner, attempt);
  }
  if (attempt.stderr !== "") {
    fail(`${owner} wrote stderr: ${attempt.stderr.trim()}`);
  }
  return attempt;
}

function commandFailure(owner, attempt) {
  const diagnostic = `${attempt.stdout}${attempt.stderr}`.trim();
  fail(
    `${owner} failed with ${
      attempt.signal ? `signal ${attempt.signal}` : `status ${attempt.status}`
    }${diagnostic ? `: ${diagnostic}` : ""}`
  );
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function freezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function expectProtocolError(run, expectedCode) {
  let received;
  try {
    run();
  } catch (error) {
    received = error;
  }
  assert(received instanceof Error);
  assert.equal(received.code, expectedCode);
}

function fail(message) {
  throw new Error(`C1 full-screen Metal: ${message}`);
}
