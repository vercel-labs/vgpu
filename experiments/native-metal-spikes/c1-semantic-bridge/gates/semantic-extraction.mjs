#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

import { authenticateSuccessfulInventory } from "../lib/authenticated-inventory.mjs";
import {
  authenticatedSemanticExtractionRequestBytes,
  authenticateSuccessfulSemanticExtraction,
  isAuthenticatedSemanticExtraction,
  isSemanticExtractionForFinalizedCapsule,
  semanticExtractionRequestForFinalizedCapsule,
} from "../lib/authenticated-semantic-extraction.mjs";
import { finalizeProgramCapsule } from "../lib/fullscreen-injection.mjs";
import { selectProgramEntries } from "../lib/program-selection.mjs";
import {
  assertSemanticExtractionExecutableProfile,
  assertSemanticExtractionRequestSemantics,
  assertSemanticExtractionResponseSemantics,
  encodeSemanticExtractionRequest,
  SEMANTIC_EXTRACTION_COMPILER,
  semanticExtractionRequestIdentity,
} from "../lib/semantic-extraction-protocol.mjs";
import {
  assertSemanticResourceGraph,
  semanticLayoutId,
  semanticTypeId,
} from "../lib/semantic-resource-graph.mjs";
import {
  encodeInventoryRequest,
  INVENTORY_COMPILER,
  INVENTORY_CONTRACT,
  inventoryRequestIdentity,
  originMapSha256,
  sha256Utf8,
} from "../lib/protocol.mjs";
import {
  decodeTintWorkerResponse,
  startTintWorker,
} from "../../c1-compiler-protocol/lib/native-compiler.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const bridgeDirectory = resolve(directory, "..");
const compilerProtocolDirectory = resolve(
  bridgeDirectory,
  "..",
  "c1-compiler-protocol"
);
const fixtureDirectory = join(
  bridgeDirectory,
  "fixtures",
  "semantic-extraction"
);

function fail(message) {
  throw new Error(`C1 semantic extraction: ${message}`);
}

function parseArguments(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    process.stdout.write(
      "Usage: node gates/semantic-extraction.mjs [--worker <Tint executable>] [--require-worker]\n"
    );
    process.exit(0);
  }
  const options = {
    worker: process.env.C1_SEMANTIC_BRIDGE_WORKER,
    requireWorker: process.env.C1_SEMANTIC_BRIDGE_REQUIRE_WORKER === "1",
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) fail(`${argument} may appear only once`);
    seen.add(argument);
    if (argument === "--require-worker") {
      options.requireWorker = true;
      continue;
    }
    if (argument === "--worker") {
      const value = argv[++index];
      if (!value) fail("--worker requires a value");
      options.worker = resolve(value);
      continue;
    }
    fail(`unknown argument ${argument}`);
  }
  if (options.worker) options.worker = resolve(options.worker);
  if (options.requireWorker && !options.worker) {
    fail("--require-worker requires --worker or C1_SEMANTIC_BRIDGE_WORKER");
  }
  if (options.worker && !existsSync(options.worker)) {
    fail(`worker does not exist: ${options.worker}`);
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fixtureMap(path) {
  return Object.fromEntries(
    readdirSync(path)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => [name.slice(0, -5), readJson(join(path, name))])
  );
}

function loadValidators() {
  const schemas = [
    readJson(
      join(compilerProtocolDirectory, "contracts", "origin-map-v1.schema.json")
    ),
    readJson(
      join(compilerProtocolDirectory, "contracts", "request-v1.schema.json")
    ),
    readJson(
      join(compilerProtocolDirectory, "contracts", "response-v1.schema.json")
    ),
    readJson(
      join(bridgeDirectory, "contracts", "inventory-request-v1.schema.json")
    ),
    readJson(
      join(
        bridgeDirectory,
        "contracts",
        "semantic-extraction-request-v1.schema.json"
      )
    ),
    readJson(
      join(
        bridgeDirectory,
        "contracts",
        "semantic-extraction-response-v1.schema.json"
      )
    ),
  ];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) ajv.addSchema(schema);
  return {
    request: ajv.getSchema(schemas[4].$id),
    response: ajv.getSchema(schemas[5].$id),
  };
}

function assertSchema(validate, value, label) {
  if (!validate(value)) {
    fail(
      `${label} failed schema validation: ${JSON.stringify(validate.errors)}`
    );
  }
}

function expectRejected(run, label, expectedCode) {
  try {
    run();
  } catch (error) {
    if (expectedCode && error?.code !== expectedCode) {
      fail(
        `${label} rejected with ${String(
          error?.code
        )} instead of ${expectedCode}`
      );
    }
    return;
  }
  fail(`${label} escaped its negative gate`);
}

function inventoryRequestFromSemantic(request) {
  return {
    schemaVersion: 1,
    contractId: INVENTORY_CONTRACT,
    source: structuredClone(request.source),
    originMap: structuredClone(request.originMap),
    originMapSha256: request.originMapSha256,
    languageFeatures: [...request.languageFeatures],
  };
}

function finalizedForInterfaceRequest(request, kind) {
  const inventoryRequest = inventoryRequestFromSemantic(request);
  const inventoryBytes = encodeInventoryRequest(inventoryRequest);
  const inventoryResponse = {
    schemaVersion: 1,
    contractId: INVENTORY_CONTRACT,
    ok: true,
    requestIdentity: inventoryRequestIdentity(inventoryBytes),
    compiler: INVENTORY_COMPILER,
    diagnostics: [],
    result: {
      entryPoints: structuredClone(request.entryPoints),
    },
  };
  const configSource = "Shaders/semantic-interface.wgsl";
  const inventory = authenticateSuccessfulInventory({
    configSource,
    request: inventoryRequest,
    requestBytes: inventoryBytes,
    response: inventoryResponse,
  });
  const selection = selectProgramEntries(
    kind === "compute"
      ? {
          name: "ComputeInterface",
          source: configSource,
          kind: "compute",
          entryPoints: { compute: "compute_builtins" },
        }
      : {
          name: "RenderInterface",
          source: configSource,
          kind: "draw",
          entryPoints: {
            vertex: request.entryPoints[0].wgsl,
            fragment: request.entryPoints[1].wgsl,
          },
        },
    inventory
  );
  return finalizeProgramCapsule({ inventory, selection });
}

function finalizedFullscreenEffect() {
  const text = readFileSync(
    join(bridgeDirectory, "fixtures", "fullscreen-metal.wgsl"),
    "utf8"
  );
  const configSource = "Shaders/fullscreen-metal.wgsl";
  const virtualPath = "Intermediate/fullscreen-metal.resolved.wgsl";
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
  const request = {
    schemaVersion: 1,
    contractId: INVENTORY_CONTRACT,
    source: { virtualPath, sha256: sourceSha256, text },
    originMap,
    originMapSha256: originMapSha256(originMap),
    languageFeatures: [],
  };
  const requestBytes = encodeInventoryRequest(request);
  const inventory = authenticateSuccessfulInventory({
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
  const selection = selectProgramEntries(
    {
      name: "FullscreenMetal",
      source: configSource,
      kind: "effect",
    },
    inventory
  );
  return finalizeProgramCapsule({ inventory, selection });
}

function prepareInvocation(request, validators, launch) {
  assertSchema(validators.request, request, "semantic extraction request");
  assertSemanticExtractionExecutableProfile(request);
  return launch(encodeSemanticExtractionRequest(request));
}

function runStaticGate(validators, requests, responses) {
  for (const name of Object.keys(requests)) {
    const request = requests[name];
    const response = responses[name];
    assertSchema(validators.request, request, `${name} request`);
    assertSemanticExtractionRequestSemantics(request);
    const requestBytes = encodeSemanticExtractionRequest(request);
    assert.equal(
      requestBytes,
      encodeSemanticExtractionRequest(structuredClone(request)),
      `${name} request encoding drifted across a clone`
    );
    assertSchema(validators.response, response, `${name} response`);
    assertSemanticExtractionResponseSemantics(request, requestBytes, response);
  }

  const renderFinalized = finalizedForInterfaceRequest(
    requests["render-interface"],
    "draw"
  );
  const computeFinalized = finalizedForInterfaceRequest(
    requests["compute-interface"],
    "compute"
  );
  const resourceFinalized = finalizedForInterfaceRequest(
    requests["active-resource"],
    "draw"
  );
  const finalizedByName = {
    "render-interface": renderFinalized,
    "compute-interface": computeFinalized,
    "active-resource": resourceFinalized,
  };
  const authenticated = {};
  for (const name of [
    "render-interface",
    "compute-interface",
    "active-resource",
  ]) {
    const request = requests[name];
    const expected = semanticExtractionRequestForFinalizedCapsule(
      finalizedByName[name]
    );
    assert.deepEqual(expected, request);
    const requestBytes = encodeSemanticExtractionRequest(request);
    authenticated[name] = authenticateSuccessfulSemanticExtraction({
      finalized: finalizedByName[name],
      request,
      requestBytes,
      response: responses[name],
    });
    assert(isAuthenticatedSemanticExtraction(authenticated[name]));
    assert(
      isSemanticExtractionForFinalizedCapsule(
        authenticated[name],
        finalizedByName[name]
      )
    );
    assert.equal(
      authenticatedSemanticExtractionRequestBytes(authenticated[name]),
      requestBytes
    );
    assert(
      !isAuthenticatedSemanticExtraction(structuredClone(authenticated[name]))
    );
  }

  expectRejected(
    () =>
      authenticateSuccessfulSemanticExtraction({
        finalized: computeFinalized,
        request: requests["render-interface"],
        requestBytes: encodeSemanticExtractionRequest(
          requests["render-interface"]
        ),
        response: responses["render-interface"],
      }),
    "crossed finalized capsule",
    "VGPU-C1-SEMANTIC-CAPSULE"
  );
  expectRejected(
    () =>
      authenticateSuccessfulSemanticExtraction({
        finalized: computeFinalized,
        request: requests["active-override"],
        requestBytes: encodeSemanticExtractionRequest(
          requests["active-override"]
        ),
        response: responses["active-override"],
      }),
    "failed response authentication",
    "VGPU-C1-SEMANTIC-NOT-SUCCESS"
  );

  let launches = 0;
  const baseRequest = requests["render-interface"];
  const prelaunchMutations = [
    ["extra-field", (value) => (value.extra = true), undefined],
    [
      "single-render-entry",
      (value) => (value.entryPoints = [value.entryPoints[0]]),
      undefined,
    ],
    [
      "reversed-render-tuple",
      (value) => value.entryPoints.reverse(),
      undefined,
    ],
    [
      "crossed-source-hash",
      (value) => (value.source.sha256 = "0".repeat(64)),
      "VGPU-C1-SEMANTIC-SOURCE-HASH",
    ],
    [
      "stale-origin-map-hash",
      (value) => (value.originMapSha256 = "0".repeat(64)),
      "VGPU-C1-SEMANTIC-ORIGIN-HASH",
    ],
    [
      "noncanonical-features",
      (value) => (value.languageFeatures = ["f16", "dual_source_blending"]),
      "VGPU-C1-SEMANTIC-FEATURE-ORDER",
    ],
    [
      "duplicate-override-name",
      (value) =>
        (value.overrideConfiguration = [
          { name: "VALUE", value: 1 },
          { name: "VALUE", value: 2 },
        ]),
      "VGPU-C1-SEMANTIC-OVERRIDE-ORDER",
    ],
    [
      "negative-zero-override",
      (value) => (value.overrideConfiguration = [{ name: "VALUE", value: -0 }]),
      "VGPU-C1-SEMANTIC-WIRE",
    ],
    [
      "configured-override-profile",
      (value) => (value.overrideConfiguration = [{ name: "VALUE", value: 1 }]),
      "VGPU-C1-SEMANTIC-CONFIGURATION-UNSUPPORTED",
    ],
  ];
  for (const [name, mutate, expectedCode] of prelaunchMutations) {
    const request = structuredClone(baseRequest);
    mutate(request);
    expectRejected(
      () => prepareInvocation(request, validators, () => (launches += 1)),
      name,
      expectedCode
    );
  }
  assert.equal(launches, 0);

  const responseMutations = [
    ["extra-response-field", (value) => (value.extra = true)],
    [
      "crossed-request-identity",
      (value) => (value.requestIdentity.sha256 = "0".repeat(64)),
    ],
    ["compiler-drift", (value) => (value.compiler.version = "0.1.1")],
    [
      "entry-name-drift",
      (value) => (value.result.entryPoints[0].wgsl = "other_vertex"),
    ],
    [
      "interface-order",
      (value) => value.result.entryPoints[0].semanticInterface.inputs.reverse(),
    ],
    [
      "builtin-type",
      (value) =>
        (value.result.entryPoints[0].semanticInterface.inputs[2].type.width = 2),
    ],
    [
      "diagnostic-name",
      (value) =>
        (value.result.entryPoints[0].semanticInterface.inputs[0].name =
          "model_position"),
    ],
    [
      "render-workgroup-size",
      (value) =>
        (value.result.entryPoints[0].workgroupSize = { x: 1, y: 1, z: 1 }),
    ],
    [
      "entry-binding-in-profile",
      (value) => value.result.entryPoints[0].bindings.push("g0b0"),
    ],
    [
      "type-root-in-profile",
      (value) =>
        (value.result.types[`t_${"0".repeat(64)}`] = {
          kind: "scalar",
          scalar: "u32",
        }),
    ],
    [
      "dual-source-without-feature",
      (value) => {
        const output = value.result.entryPoints[1].semanticInterface.outputs[0];
        output.location = 0;
        output.blendSource = 0;
      },
    ],
    [
      "diagnostic-source-crossing",
      (value) =>
        value.diagnostics.push({
          code: "VGPU-NATIVE-TINT-WARNING",
          severity: "warning",
          phase: "wgsl",
          message: "reviewed warning",
          location: {
            kind: "generated-wgsl",
            virtualPath: "Intermediate/crossed.resolved.wgsl",
            start: { line: 1, column: 1 },
            end: { line: 1, column: 1 },
          },
        }),
    ],
    [
      "negative-zero-location",
      (value) =>
        (value.result.entryPoints[0].semanticInterface.inputs[0].location = -0),
    ],
  ];
  for (const [name, mutate] of responseMutations) {
    const response = structuredClone(responses["render-interface"]);
    mutate(response);
    expectRejected(() => {
      assertSchema(validators.response, response, `${name} response`);
      assertSemanticExtractionResponseSemantics(
        baseRequest,
        encodeSemanticExtractionRequest(baseRequest),
        response
      );
    }, name);
  }

  const resourceResponseMutations = [
    [
      "resource-binding-order",
      (value) => value.result.bindings.reverse(),
      "VGPU-C1-SEMANTIC-BINDING-ORDER",
    ],
    [
      "resource-entry-subset",
      (value) => value.result.entryPoints[1].bindings.pop(),
      "VGPU-C1-SEMANTIC-BINDING-UNION",
    ],
    [
      "uniform-write-access",
      (value) => (value.result.bindings[0].access = "read_write"),
      "VGPU-C1-SEMANTIC-BINDING-SHAPE",
    ],
    [
      "sampling-pair-roles",
      (value) => {
        const pair = value.result.entryPoints[1].samplingPairs[0];
        [pair.texture, pair.sampler] = [pair.sampler, pair.texture];
      },
      "VGPU-C1-SEMANTIC-SAMPLING-PAIR",
    ],
    [
      "sampling-pair-mode",
      (value) =>
        (value.result.entryPoints[1].samplingPairs[0].mode = "comparison"),
      "VGPU-C1-SEMANTIC-SAMPLING-PAIR",
    ],
    [
      "filtering-pair-with-unfilterable-texture",
      (value) => (value.result.bindings[2].sampleType = "unfilterable-float"),
      "VGPU-C1-SEMANTIC-SAMPLING-PAIR",
    ],
    [
      "comparison-pair-with-color-texture",
      (value) => {
        value.result.bindings[3].samplerKind = "comparison";
        value.result.entryPoints[1].samplingPairs[0].mode = "comparison";
      },
      "VGPU-C1-SEMANTIC-SAMPLING-PAIR",
    ],
    [
      "type-content-address",
      (value) => {
        const id = Object.keys(value.result.types).find(
          (candidate) => value.result.types[candidate].kind === "scalar"
        );
        value.result.types[id].scalar = "u32";
      },
      "VGPU-C1-SEMANTIC-TYPE-ID",
    ],
    [
      "layout-content-address",
      (value) => {
        const id = value.result.bindings[0].layout;
        value.result.layouts[id].size += 1;
      },
      "VGPU-C1-SEMANTIC-LAYOUT-ID",
    ],
    [
      "minimum-binding-size",
      (value) => (value.result.bindings[0].minimumBindingSize += 1),
      "VGPU-C1-SEMANTIC-BUFFER-LAYOUT",
    ],
    [
      "unreachable-type",
      (value) => {
        const descriptor = { kind: "scalar", scalar: "u32" };
        value.result.types[semanticTypeId(descriptor)] = descriptor;
        value.result.types = Object.fromEntries(
          Object.entries(value.result.types).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0
          )
        );
      },
      "VGPU-C1-SEMANTIC-GRAPH-CLOSURE",
    ],
    [
      "runtime-layout",
      (value) => {
        const root = value.result.bindings[0];
        const oldRootId = root.layout;
        const rootLayout = value.result.layouts[oldRootId];
        const oldLeafId = rootLayout.members[0].layout;
        const leaf = value.result.layouts[oldLeafId];
        leaf.runtimeSized = true;
        delete leaf.size;
        const newLeafId = semanticLayoutId(leaf);
        delete value.result.layouts[oldLeafId];
        value.result.layouts[newLeafId] = leaf;
        rootLayout.members[0].layout = newLeafId;
        const newRootId = semanticLayoutId(rootLayout);
        delete value.result.layouts[oldRootId];
        value.result.layouts[newRootId] = rootLayout;
        root.layout = newRootId;
        value.result.layouts = Object.fromEntries(
          Object.entries(value.result.layouts).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0
          )
        );
      },
      "VGPU-C1-SEMANTIC-FIXED-LAYOUT",
    ],
    [
      "fixed-layout-minimum-size",
      (value) => {
        const root = value.result.bindings[0];
        const oldRootId = root.layout;
        const rootLayout = value.result.layouts[oldRootId];
        const oldLeafId = rootLayout.members[0].layout;
        const leaf = value.result.layouts[oldLeafId];
        leaf.minimumSize -= 1;
        const newLeafId = semanticLayoutId(leaf);
        delete value.result.layouts[oldLeafId];
        value.result.layouts[newLeafId] = leaf;
        rootLayout.members[0].layout = newLeafId;
        const newRootId = semanticLayoutId(rootLayout);
        delete value.result.layouts[oldRootId];
        value.result.layouts[newRootId] = rootLayout;
        root.layout = newRootId;
        value.result.layouts = Object.fromEntries(
          Object.entries(value.result.layouts).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0
          )
        );
      },
      "VGPU-C1-SEMANTIC-FIXED-LAYOUT",
    ],
    [
      "layout-member-child-type",
      (value) => {
        const root = value.result.bindings[0];
        const oldRootId = root.layout;
        const rootLayout = value.result.layouts[oldRootId];
        rootLayout.members[0].layout = value.result.bindings[4].layout;
        const newRootId = semanticLayoutId(rootLayout);
        delete value.result.layouts[oldRootId];
        value.result.layouts[newRootId] = rootLayout;
        root.layout = newRootId;
        value.result.layouts = Object.fromEntries(
          Object.entries(value.result.layouts).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0
          )
        );
      },
      "VGPU-C1-SEMANTIC-LAYOUT-SHAPE",
    ],
  ];
  for (const [name, mutate, expectedCode] of resourceResponseMutations) {
    const request = requests["active-resource"];
    const response = structuredClone(responses["active-resource"]);
    mutate(response);
    expectRejected(
      () => {
        assertSchema(validators.response, response, `${name} response`);
        assertSemanticExtractionResponseSemantics(
          request,
          encodeSemanticExtractionRequest(request),
          response
        );
      },
      name,
      expectedCode
    );
  }
  const excessivePairs = structuredClone(responses["active-resource"]);
  excessivePairs.result.entryPoints[1].samplingPairs = Array.from(
    { length: 4_097 },
    () => ({ texture: "g0b2", sampler: "g0b3", mode: "filtering" })
  );
  expectRejected(
    () =>
      assertSemanticExtractionResponseSemantics(
        requests["active-resource"],
        encodeSemanticExtractionRequest(requests["active-resource"]),
        excessivePairs
      ),
    "sampling-pair-resource-limit",
    "VGPU-C1-SEMANTIC-RESOURCE-LIMIT"
  );
  const scalarDescriptor = { kind: "scalar", scalar: "f32" };
  const scalarId = semanticTypeId(scalarDescriptor);
  const runtimeArrayDescriptor = { kind: "array", element: scalarId };
  const runtimeArrayId = semanticTypeId(runtimeArrayDescriptor);
  const fixedPretenderLayout = {
    type: runtimeArrayId,
    alignment: 4,
    minimumSize: 4,
    size: 4,
    runtimeSized: false,
    arrayStride: 4,
    members: [],
  };
  const fixedPretenderLayoutId = semanticLayoutId(fixedPretenderLayout);
  expectRejected(
    () =>
      assertSemanticResourceGraph(
        {
          entryPoints: [{ bindings: ["g0b0"], samplingPairs: [] }],
          bindings: [
            {
              id: "g0b0",
              name: "values",
              group: 0,
              binding: 0,
              kind: "buffer",
              addressSpace: "storage",
              access: "read",
              type: runtimeArrayId,
              layout: fixedPretenderLayoutId,
              minimumBindingSize: 4,
            },
          ],
          types: Object.fromEntries(
            [
              [scalarId, scalarDescriptor],
              [runtimeArrayId, runtimeArrayDescriptor],
            ].sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0
            )
          ),
          layouts: { [fixedPretenderLayoutId]: fixedPretenderLayout },
        },
        {
          failWith(code, message) {
            throw Object.assign(new Error(message), { code });
          },
        }
      ),
    "runtime-array-type-with-fixed-layout",
    "VGPU-C1-SEMANTIC-FIXED-LAYOUT"
  );
  const computeWithoutWorkgroup = structuredClone(
    responses["compute-interface"]
  );
  delete computeWithoutWorkgroup.result.entryPoints[0].workgroupSize;
  expectRejected(
    () =>
      assertSchema(
        validators.response,
        computeWithoutWorkgroup,
        "missing compute workgroup response"
      ),
    "missing-compute-workgroup"
  );

  const dualSourceRequest = structuredClone(baseRequest);
  dualSourceRequest.languageFeatures = ["dual_source_blending"];
  const dualSourceRequestBytes =
    encodeSemanticExtractionRequest(dualSourceRequest);
  const incompleteDualSource = structuredClone(responses["render-interface"]);
  incompleteDualSource.requestIdentity = semanticExtractionRequestIdentity(
    dualSourceRequestBytes
  );
  const incompleteOutput =
    incompleteDualSource.result.entryPoints[1].semanticInterface.outputs[0];
  incompleteOutput.location = 0;
  incompleteOutput.blendSource = 0;
  expectRejected(
    () => {
      assertSchema(
        validators.response,
        incompleteDualSource,
        "incomplete dual-source response"
      );
      assertSemanticExtractionResponseSemantics(
        dualSourceRequest,
        dualSourceRequestBytes,
        incompleteDualSource
      );
    },
    "incomplete-dual-source-pair",
    "VGPU-C1-SEMANTIC-INTERFACE"
  );

  return {
    requests: Object.keys(requests).length,
    responses: Object.keys(responses).length,
    prelaunchMutations: prelaunchMutations.length,
    responseMutations:
      responseMutations.length + resourceResponseMutations.length + 4,
    authenticatedSuccesses: Object.keys(authenticated).length,
    workerLaunches: launches,
  };
}

function replaceRequestSource(request, text) {
  request.source.text = text;
  request.source.sha256 = sha256Utf8(text);
  request.originMap.generatedSource.sha256 = request.source.sha256;
  request.originMap.sources[0].sha256 = request.source.sha256;
  request.originMap.segments = [
    {
      generated: { startByte: 0, endByte: Buffer.byteLength(text, "utf8") },
      origin: { input: request.originMap.sources[0].input },
      precision: "module",
    },
  ];
  request.originMapSha256 = originMapSha256(request.originMap);
}

async function invokeSemantic(executable, request, validators) {
  assertSchema(validators.request, request, "native semantic request");
  assertSemanticExtractionRequestSemantics(request);
  const requestBytes = encodeSemanticExtractionRequest(request);
  const worker = startTintWorker({ executable });
  try {
    await worker.write(Buffer.from(requestBytes, "utf8"));
    worker.end();
  } catch (error) {
    worker.terminate(error);
  }
  const attempt = await worker.result;
  const response = decodeTintWorkerResponse(attempt, (value) => {
    assertSchema(validators.response, value, "native semantic response");
    assertSemanticExtractionResponseSemantics(request, requestBytes, value);
    return true;
  });
  return { requestBytes, response, stdout: attempt.stdout };
}

async function invokeRawSemantic(executable, request, validators) {
  const requestBytes = encodeSemanticExtractionRequest(request);
  const worker = startTintWorker({ executable });
  try {
    await worker.write(Buffer.from(requestBytes, "utf8"));
    worker.end();
  } catch (error) {
    worker.terminate(error);
  }
  const attempt = await worker.result;
  const response = decodeTintWorkerResponse(attempt, (value) => {
    assertSchema(validators.response, value, "raw native semantic response");
    assert.deepEqual(
      value.requestIdentity,
      semanticExtractionRequestIdentity(requestBytes)
    );
    return true;
  });
  return { requestBytes, response, stdout: attempt.stdout };
}

async function runNativeGate(executable, validators, requests, responses) {
  if (!executable) {
    return {
      status: "skipped",
      reason: "no semantic extraction worker supplied",
    };
  }
  let invocations = 0;
  const firstRuns = {};
  for (const name of Object.keys(requests)) {
    const run = await invokeSemantic(executable, requests[name], validators);
    invocations += 1;
    assert.deepEqual(run.response, responses[name], `${name} response drifted`);
    firstRuns[name] = run;
  }
  for (const name of ["compute-interface", "render-interface"]) {
    const second = await invokeSemantic(executable, requests[name], validators);
    invocations += 1;
    assert.equal(second.stdout, firstRuns[name].stdout);
  }

  const scalarRender = structuredClone(requests["render-interface"]);
  scalarRender.entryPoints[1].wgsl = "scalar_fragment";
  const scalarRun = await invokeSemantic(executable, scalarRender, validators);
  invocations += 1;
  const scalarOracle = readJson(
    join(
      bridgeDirectory,
      "..",
      "c1-tint-direct-build",
      "fixtures",
      "requests",
      "scalar-fragment.json"
    )
  ).semanticInterface;
  assert.equal(scalarRun.response.ok, true);
  assert.deepEqual(
    scalarRun.response.result.entryPoints[1].semanticInterface,
    scalarOracle
  );

  const fullscreenFinalized = finalizedFullscreenEffect();
  const fullscreenRequest =
    semanticExtractionRequestForFinalizedCapsule(fullscreenFinalized);
  const fullscreenRun = await invokeSemantic(
    executable,
    fullscreenRequest,
    validators
  );
  invocations += 1;
  const fullscreenInterfaces = readJson(
    join(bridgeDirectory, "fixtures", "fullscreen-metal-interfaces.json")
  );
  assert.equal(fullscreenRun.response.ok, true);
  assert.deepEqual(
    fullscreenRun.response.result.entryPoints.map(
      ({ stage, semanticInterface }) => [stage, semanticInterface]
    ),
    [
      ["vertex", fullscreenInterfaces.vertex],
      ["fragment", fullscreenInterfaces.fragment],
    ]
  );

  const authoredMemberSize = structuredClone(requests["active-resource"]);
  replaceRequestSource(
    authoredMemberSize,
    `struct Padded {
  @size(16) value: f32,
}
@group(0) @binding(0) var<uniform> padded: Padded;
@vertex fn vs_main() -> @builtin(position) vec4f {
  return vec4f(0.0);
}
@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(padded.value);
}
`
  );
  const authoredSizeRun = await invokeSemantic(
    executable,
    authoredMemberSize,
    validators
  );
  invocations += 1;
  assert.equal(authoredSizeRun.response.ok, true);
  const authoredSizeBinding = authoredSizeRun.response.result.bindings[0];
  const authoredSizeRoot =
    authoredSizeRun.response.result.layouts[authoredSizeBinding.layout];
  assert.deepEqual(
    {
      bindingMinimum: authoredSizeBinding.minimumBindingSize,
      rootMinimum: authoredSizeRoot.minimumSize,
      rootSize: authoredSizeRoot.size,
      memberMinimum: authoredSizeRoot.members[0].minimumSize,
      memberSize: authoredSizeRoot.members[0].size,
    },
    {
      bindingMinimum: 16,
      rootMinimum: 16,
      rootSize: 16,
      memberMinimum: 16,
      memberSize: 16,
    }
  );

  const storageTexture = structuredClone(requests["active-resource"]);
  replaceRequestSource(
    storageTexture,
    `@group(0) @binding(0) var output_image: texture_storage_2d<rgba8unorm, write>;
@vertex fn vs_main() -> @builtin(position) vec4f {
  return vec4f(0.0);
}
@fragment fn fs_main() -> @location(0) vec4f {
  textureStore(output_image, vec2i(0), vec4f(1.0));
  return vec4f(1.0);
}
`
  );
  const storageTextureRun = await invokeSemantic(
    executable,
    storageTexture,
    validators
  );
  invocations += 1;
  assert.equal(storageTextureRun.response.ok, true);
  assert.deepEqual(storageTextureRun.response.result.bindings, [
    {
      id: "g0b0",
      name: "output_image",
      group: 0,
      binding: 0,
      kind: "storage-texture",
      dimension: "2d",
      format: "rgba8unorm",
      access: "write",
    },
  ]);
  const authenticatedFullscreen = authenticateSuccessfulSemanticExtraction({
    finalized: fullscreenFinalized,
    request: fullscreenRequest,
    requestBytes: fullscreenRun.requestBytes,
    response: fullscreenRun.response,
  });
  assert(isAuthenticatedSemanticExtraction(authenticatedFullscreen));
  assert(
    isSemanticExtractionForFinalizedCapsule(
      authenticatedFullscreen,
      fullscreenFinalized
    )
  );

  const oversizedInterface = structuredClone(requests["render-interface"]);
  const oversizedParameters = Array.from(
    { length: 65 },
    (_, index) => `@location(${index}) input_${index}: f32`
  ).join(", ");
  replaceRequestSource(
    oversizedInterface,
    `@vertex fn vertex_main(${oversizedParameters}) -> @builtin(position) vec4f {
  return vec4f(0.0);
}
@fragment fn fragment_main() -> @location(0) vec4f {
  return vec4f(1.0);
}
`
  );
  const oversizedRun = await invokeSemantic(
    executable,
    oversizedInterface,
    validators
  );
  invocations += 1;
  assert.equal(oversizedRun.response.ok, false);
  assert.equal(
    oversizedRun.response.diagnostics[0].code,
    "VGPU-NATIVE-TINT-INTERFACE"
  );

  const inactiveDeclarations = structuredClone(requests["compute-interface"]);
  replaceRequestSource(
    inactiveDeclarations,
    `@group(0) @binding(0) var<uniform> inactive_resource: vec4f;
override INACTIVE_SIZE: u32;
@compute @workgroup_size(INACTIVE_SIZE) fn inactive_entry() {
  let value = inactive_resource.x;
}
@compute @workgroup_size(2, 3) fn compute_builtins() {}
`
  );
  const inactiveRun = await invokeSemantic(
    executable,
    inactiveDeclarations,
    validators
  );
  invocations += 1;
  assert.equal(inactiveRun.response.ok, true);
  assert.deepEqual(inactiveRun.response.result.entryPoints[0], {
    stage: "compute",
    wgsl: "compute_builtins",
    semanticInterface: { kind: "compute", inputs: [], outputs: [] },
    bindings: [],
    samplingPairs: [],
    overrides: [],
    workgroupSize: { x: 2, y: 3, z: 1 },
  });

  const runtimeArray = structuredClone(requests["active-resource"]);
  replaceRequestSource(
    runtimeArray,
    `struct Values {
  values: array<vec4f>,
}
@group(0) @binding(0) var<storage, read> values: Values;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return values.values[index];
}
@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(1.0);
}
`
  );
  const runtimeArrayRun = await invokeSemantic(
    executable,
    runtimeArray,
    validators
  );
  invocations += 1;
  assert.equal(runtimeArrayRun.response.ok, false);
  assert.equal(
    runtimeArrayRun.response.diagnostics[0].code,
    "VGPU-NATIVE-TINT-SEMANTIC-RESOURCE-UNSUPPORTED"
  );

  const bindingArray = structuredClone(requests["active-resource"]);
  bindingArray.languageFeatures = ["sized_binding_array"];
  replaceRequestSource(
    bindingArray,
    `@group(0) @binding(0) var images: binding_array<texture_2d<f32>, 2>;
@vertex fn vs_main() -> @builtin(position) vec4f {
  return vec4f(0.0);
}
@fragment fn fs_main() -> @location(0) vec4f {
  return textureLoad(images[0], vec2i(0), 0);
}
`
  );
  const bindingArrayRun = await invokeSemantic(
    executable,
    bindingArray,
    validators
  );
  invocations += 1;
  assert.equal(bindingArrayRun.response.ok, false);
  assert.equal(
    bindingArrayRun.response.diagnostics[0].code,
    "VGPU-NATIVE-TINT-SEMANTIC-RESOURCE-UNSUPPORTED"
  );

  const crossStageSampling = structuredClone(requests["active-resource"]);
  replaceRequestSource(
    crossStageSampling,
    `@group(0) @binding(0) var integer_image: texture_2d<i32>;
@group(0) @binding(1) var color_image: texture_2d<f32>;
@group(0) @binding(2) var shared_sampler: sampler;
@vertex fn vs_main() -> @builtin(position) vec4f {
  return textureSampleLevel(color_image, shared_sampler, vec2f(0.5), 0.0);
}
@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(textureGather(0, integer_image, shared_sampler, vec2f(0.5)));
}
`
  );
  const crossStageRun = await invokeSemantic(
    executable,
    crossStageSampling,
    validators
  );
  invocations += 1;
  assert.equal(
    crossStageRun.response.ok,
    true,
    JSON.stringify(crossStageRun.response.diagnostics)
  );
  assert.deepEqual(
    crossStageRun.response.result.bindings.map((binding) => [
      binding.id,
      binding.sampleType ?? binding.samplerKind,
    ]),
    [
      ["g0b0", "sint"],
      ["g0b1", "unfilterable-float"],
      ["g0b2", "non-filtering"],
    ]
  );
  assert.deepEqual(
    crossStageRun.response.result.entryPoints.map((entry) =>
      entry.samplingPairs.map((pair) => [pair.texture, pair.sampler, pair.mode])
    ),
    [[["g0b1", "g0b2", "filtering"]], [["g0b0", "g0b2", "filtering"]]]
  );

  const configured = structuredClone(requests["compute-interface"]);
  configured.overrideConfiguration = [{ name: "VALUE", value: 1 }];
  const configuredRun = await invokeRawSemantic(
    executable,
    configured,
    validators
  );
  invocations += 1;
  assert.equal(
    configuredRun.response.diagnostics[0].code,
    "VGPU-NATIVE-TINT-SEMANTIC-CONFIGURATION-UNSUPPORTED"
  );

  const expression = structuredClone(requests["compute-interface"]);
  replaceRequestSource(
    expression,
    expression.source.text.replace(
      "@compute @workgroup_size(1)",
      "@compute @workgroup_size(1 + 0)"
    )
  );
  const expressionRun = await invokeSemantic(
    executable,
    expression,
    validators
  );
  invocations += 1;
  assert.equal(
    expressionRun.response.diagnostics[0].code,
    "VGPU-NATIVE-TINT-SEMANTIC-WORKGROUP-UNSUPPORTED"
  );

  const unknownEntry = structuredClone(requests["compute-interface"]);
  unknownEntry.entryPoints[0].wgsl = "missing_entry";
  const unknownRun = await invokeSemantic(executable, unknownEntry, validators);
  invocations += 1;
  assert.equal(
    unknownRun.response.diagnostics[0].code,
    "VGPU-NATIVE-TINT-INSPECT"
  );

  const stageMismatch = structuredClone(requests["compute-interface"]);
  stageMismatch.entryPoints[0].wgsl = "vertex_main";
  const stageMismatchRun = await invokeSemantic(
    executable,
    stageMismatch,
    validators
  );
  invocations += 1;
  assert.equal(
    stageMismatchRun.response.diagnostics[0].code,
    "VGPU-NATIVE-TINT-INSPECT"
  );

  const invalidWgsl = structuredClone(requests["compute-interface"]);
  replaceRequestSource(
    invalidWgsl,
    "@compute @workgroup_size(1) fn broken( {\n"
  );
  invalidWgsl.entryPoints[0].wgsl = "broken";
  const invalidRun = await invokeSemantic(executable, invalidWgsl, validators);
  invocations += 1;
  assert.equal(
    invalidRun.response.diagnostics[0].code,
    "VGPU-NATIVE-WGSL-INVALID"
  );

  const staleOriginHash = structuredClone(requests["compute-interface"]);
  staleOriginHash.originMapSha256 = "0".repeat(64);
  const staleRun = await invokeRawSemantic(
    executable,
    staleOriginHash,
    validators
  );
  invocations += 1;
  assert.equal(
    staleRun.response.diagnostics[0].code,
    "VGPU-NATIVE-TINT-PROTOCOL"
  );

  const unknownField = structuredClone(requests["compute-interface"]);
  unknownField.extra = true;
  const unknownFieldRun = await invokeRawSemantic(
    executable,
    unknownField,
    validators
  );
  invocations += 1;
  assert.equal(
    unknownFieldRun.response.diagnostics[0].code,
    "VGPU-NATIVE-TINT-PROTOCOL"
  );

  const unorderedOverrides = structuredClone(requests["compute-interface"]);
  unorderedOverrides.overrideConfiguration = [
    { name: "Z_LAST", value: 1 },
    { name: "A_FIRST", value: 2 },
  ];
  const unorderedRun = await invokeRawSemantic(
    executable,
    unorderedOverrides,
    validators
  );
  invocations += 1;
  assert.equal(
    unorderedRun.response.diagnostics[0].code,
    "VGPU-NATIVE-TINT-PROTOCOL"
  );

  return {
    status: "passed",
    invocations,
    deterministicSuccessRuns: 2,
    nonLinkingExtractionSuccesses: 1,
    fullscreenExtractionSuccesses: 1,
    authenticatedFullscreenSuccesses: 1,
    inactiveDeclarationsSuccesses: 1,
    fixedResourceSuccesses: 4,
    unsupportedResourceFailures: 2,
    interfaceLimitFailures: 1,
    workerProtocolFailures: 3,
    sourceLockedResponses: Object.keys(responses).length,
    profileFailures: 4,
  };
}

const options = parseArguments(process.argv.slice(2));
const validators = loadValidators();
const requests = fixtureMap(join(fixtureDirectory, "requests"));
const responses = fixtureMap(join(fixtureDirectory, "responses"));
assert.deepEqual(Object.keys(requests), Object.keys(responses));
assert.deepEqual(SEMANTIC_EXTRACTION_COMPILER, INVENTORY_COMPILER);
const staticResult = runStaticGate(validators, requests, responses);
const native = await runNativeGate(
  options.worker,
  validators,
  requests,
  responses
);
if (options.requireWorker && native.status !== "passed") {
  fail("native worker was required but did not run");
}

process.stdout.write(
  `${JSON.stringify(
    {
      gate: "semantic-extraction",
      status: native.status === "passed" ? "passed" : "static-passed",
      static: { status: "passed", ...staticResult },
      native,
    },
    null,
    2
  )}\n`
);
