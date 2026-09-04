#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

import {
  decodeTintWorkerResponse,
  startTintWorker,
} from "../c1-compiler-protocol/lib/native-compiler.mjs";
import { jsonAllocationUnits } from "../c1-compiler-protocol/lib/protocol.mjs";
import {
  assertInventoryRequestResourceLimits,
  assertInventoryRequestSemantics,
  assertInventoryResponseSemantics,
  deterministicStringify,
  encodeInventoryRequest,
  inventoryRequestIdentity,
  originMapSha256,
  sha256Utf8,
} from "./lib/protocol.mjs";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const compilerProtocolDirectory = resolve(
  fixtureDirectory,
  "..",
  "c1-compiler-protocol"
);

function fail(message) {
  throw new Error(`C1 semantic bridge inventory: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function same(actual, expected, message) {
  assert(isDeepStrictEqual(actual, expected), message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fixtureMap(directory) {
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => [name.slice(0, -5), readJson(join(directory, name))])
  );
}

function parseArguments(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    process.stdout.write(
      "Usage: node run.mjs [--worker <entry-inventory executable>] [--require-worker]\n"
    );
    process.exit(0);
  }
  const options = {
    worker: process.env.C1_SEMANTIC_BRIDGE_INVENTORY_WORKER,
    requireWorker:
      process.env.C1_SEMANTIC_BRIDGE_REQUIRE_INVENTORY_WORKER === "1",
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
    fail(
      "--require-worker requires --worker or C1_SEMANTIC_BRIDGE_INVENTORY_WORKER"
    );
  }
  if (options.worker && !existsSync(options.worker)) {
    fail(`inventory worker does not exist: ${options.worker}`);
  }
  return options;
}

function loadValidators() {
  const schemas = {
    origin: readJson(
      join(compilerProtocolDirectory, "contracts", "origin-map-v1.schema.json")
    ),
    compilerResponse: readJson(
      join(compilerProtocolDirectory, "contracts", "response-v1.schema.json")
    ),
    request: readJson(
      join(fixtureDirectory, "contracts", "inventory-request-v1.schema.json")
    ),
    response: readJson(
      join(fixtureDirectory, "contracts", "inventory-response-v1.schema.json")
    ),
  };
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);
  return {
    request: ajv.getSchema(schemas.request.$id),
    response: ajv.getSchema(schemas.response.$id),
  };
}

function assertSchema(validate, value, label) {
  if (!validate(value)) {
    fail(
      `${label} failed schema validation: ${JSON.stringify(validate.errors)}`
    );
  }
  return true;
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

function prepareInventoryInvocation(request, validators, launch) {
  assertInventoryRequestResourceLimits(request);
  assertSchema(validators.request, request, "inventory request");
  assertInventoryRequestSemantics(request);
  const requestBytes = encodeInventoryRequest(request);
  return launch(requestBytes);
}

function runStaticGate(validators, requests, responses) {
  for (const [name, request] of Object.entries(requests)) {
    assertSchema(validators.request, request, `${name} request`);
    assertInventoryRequestSemantics(request);
    const requestBytes = encodeInventoryRequest(request);
    assert(
      requestBytes === encodeInventoryRequest(structuredClone(request)),
      `${name} request encoding is not deterministic`
    );
    const response = responses[name];
    assertSchema(validators.response, response, `${name} response`);
    assertInventoryResponseSemantics(request, requestBytes, response);
  }

  let launches = 0;
  const prelaunchMutations = [
    ["extra-request-field", (value) => (value.extra = true), undefined],
    [
      "crossed-source-hash",
      (value) => (value.source.sha256 = "0".repeat(64)),
      "VGPU-C1-INVENTORY-SOURCE-HASH",
    ],
    [
      "crossed-origin-source",
      (value) => {
        value.originMap.generatedSource.virtualPath = "Intermediate/other.wgsl";
        value.originMapSha256 = originMapSha256(value.originMap);
      },
      "VGPU-C1-INVENTORY-ORIGIN-SOURCE",
    ],
    [
      "stale-origin-map-hash",
      (value) => (value.originMapSha256 = "0".repeat(64)),
      "VGPU-C1-INVENTORY-ORIGIN-HASH",
    ],
    [
      "source-nul",
      (value) => {
        value.source.text += "\u0000";
      },
      "VGPU-C1-INVENTORY-SOURCE",
    ],
    [
      "noncanonical-feature-order",
      (value) => (value.languageFeatures = ["f16", "dual_source_blending"]),
      "VGPU-C1-INVENTORY-FEATURE-ORDER",
    ],
    [
      "nfd-virtual-path",
      (value) => {
        value.source.virtualPath = "Intermediate/cafe\u0301.wgsl";
        value.originMap.generatedSource.virtualPath = value.source.virtualPath;
        value.originMapSha256 = originMapSha256(value.originMap);
      },
      "VGPU-C1-INVENTORY-SOURCE-PATH",
    ],
    [
      "nfd-origin-input",
      (value) => {
        value.originMap.sources[0].input = "inventario-cafe\u0301";
        value.originMap.segments[0].origin.input =
          value.originMap.sources[0].input;
        value.originMapSha256 = originMapSha256(value.originMap);
      },
      "VGPU-C1-INVENTORY-ORIGIN-INPUT",
    ],
    [
      "adjacent-equal-origin-segments",
      (value) => {
        const end = value.originMap.segments[0].generated.endByte;
        value.originMap.segments = [
          {
            generated: { startByte: 0, endByte: 1 },
            origin: { input: value.originMap.sources[0].input },
            precision: "module",
          },
          {
            generated: { startByte: 1, endByte: end },
            origin: { input: value.originMap.sources[0].input },
            precision: "module",
          },
        ];
        value.originMapSha256 = originMapSha256(value.originMap);
      },
      "VGPU-C1-INVENTORY-ORIGIN-CANONICAL",
    ],
    [
      "origin-source-limit",
      (value) => {
        value.originMap.sources = Array.from({ length: 4_097 }, (_, index) => ({
          input: `inventory-source-${String(index).padStart(4, "0")}`,
          sha256: value.source.sha256,
        }));
        value.originMap.segments[0].origin.input =
          value.originMap.sources[0].input;
      },
      "VGPU-C1-INVENTORY-RESOURCE-LIMIT",
    ],
    [
      "origin-segment-limit",
      (value) => {
        value.source.text = " ".repeat(65_537);
        refreshSingleSourceCapsule(value);
        value.originMap.segments = Array.from(
          { length: 65_537 },
          (_, index) => ({
            generated: { startByte: index, endByte: index + 1 },
            origin: { input: value.originMap.sources[0].input },
            precision: "module",
          })
        );
      },
      "VGPU-C1-INVENTORY-RESOURCE-LIMIT",
    ],
    [
      "json-allocation-unit-limit",
      (value) => {
        value.source.text = " ".repeat(65_536);
        refreshSingleSourceCapsule(value);
        value.originMap.sources = [
          { input: "allocation-a", sha256: value.source.sha256 },
          { input: "allocation-b", sha256: value.source.sha256 },
        ];
        value.originMap.segments = [];
        const segmentTemplate = {
          generated: { startByte: 0, endByte: 1 },
          origin: { input: value.originMap.sources[0].input },
          precision: "module",
        };
        const segmentCount =
          Math.floor(
            (262_144 - jsonAllocationUnits(value)) /
              jsonAllocationUnits(segmentTemplate)
          ) + 1;
        value.originMap.segments = Array.from(
          { length: segmentCount },
          (_, index) => ({
            generated: { startByte: index, endByte: index + 1 },
            origin: {
              input: value.originMap.sources[index % 2].input,
            },
            precision: "module",
          })
        );
      },
      "VGPU-C1-INVENTORY-RESOURCE-LIMIT",
    ],
    [
      "cyclic-request",
      (value) => {
        value.originMap.cycle = value;
      },
      "VGPU-C1-INVENTORY-WIRE-CYCLE",
    ],
  ];
  for (const [label, mutate, code] of prelaunchMutations) {
    const request = structuredClone(requests["multi-stage"]);
    mutate(request);
    expectRejected(
      () =>
        prepareInventoryInvocation(request, validators, () => {
          launches += 1;
        }),
      label,
      code
    );
  }
  assert(launches === 0, "a prelaunch mutation reached the worker boundary");

  const decomposed = structuredClone(requests["library-only"]);
  decomposed.source.text += "// Cafe\u0301\n";
  decomposed.source.sha256 = sha256Utf8(decomposed.source.text);
  decomposed.originMap.generatedSource.sha256 = decomposed.source.sha256;
  decomposed.originMap.sources[0].sha256 = decomposed.source.sha256;
  decomposed.originMap.segments[0].generated.endByte = Buffer.byteLength(
    decomposed.source.text,
    "utf8"
  );
  decomposed.originMapSha256 = originMapSha256(decomposed.originMap);
  assertSchema(validators.request, decomposed, "decomposed Unicode request");
  assertInventoryRequestSemantics(decomposed);
  const decomposedWire = encodeInventoryRequest(decomposed);
  same(
    JSON.parse(decomposedWire).source.text,
    decomposed.source.text,
    "wire encoding normalized decomposed source code units"
  );
  assert(
    Buffer.from(decomposedWire, "utf8").includes(
      Buffer.from("Cafe\u0301", "utf8")
    ) &&
      !Buffer.from(decomposedWire, "utf8").includes(
        Buffer.from("Caf\u00e9", "utf8")
      ),
    "wire encoding changed decomposed source UTF-8 bytes"
  );
  expectRejected(
    () => deterministicStringify({ value: Number.NaN }),
    "non-finite wire number",
    "VGPU-C1-INVENTORY-WIRE-NUMBER"
  );

  const maximumCodePointPath = structuredClone(requests["library-only"]);
  const pathPrefix = "I/";
  const pathSuffix = ".wgsl";
  maximumCodePointPath.source.virtualPath = `${pathPrefix}${"😀".repeat(
    4_096 - [...pathPrefix, ...pathSuffix].length
  )}${pathSuffix}`;
  maximumCodePointPath.originMap.generatedSource.virtualPath =
    maximumCodePointPath.source.virtualPath;
  maximumCodePointPath.originMapSha256 = originMapSha256(
    maximumCodePointPath.originMap
  );
  assertSchema(
    validators.request,
    maximumCodePointPath,
    "maximum code-point virtual path"
  );
  assertInventoryRequestSemantics(maximumCodePointPath);

  const responseMutations = [
    [
      "response-request-identity",
      (value) => (value.requestIdentity.sha256 = "0".repeat(64)),
      "VGPU-C1-INVENTORY-REQUEST-IDENTITY",
    ],
    [
      "response-compiler-identity",
      (value) => (value.compiler.version = "0.1.1"),
      "VGPU-C1-INVENTORY-COMPILER",
    ],
    [
      "response-entry-order",
      (value) => value.result.entryPoints.reverse(),
      "VGPU-C1-INVENTORY-ENTRY-ORDER",
    ],
    [
      "response-duplicate-entry",
      (value) => value.result.entryPoints.push(value.result.entryPoints[0]),
      undefined,
    ],
    [
      "failure-with-result",
      (value) => (value.result = { entryPoints: [] }),
      undefined,
      "invalid-wgsl",
    ],
  ];
  for (const [
    label,
    mutate,
    code,
    requestName = "multi-stage",
  ] of responseMutations) {
    const response = structuredClone(responses[requestName]);
    mutate(response);
    expectRejected(
      () => {
        assertSchema(validators.response, response, label);
        assertInventoryResponseSemantics(
          requests[requestName],
          encodeInventoryRequest(requests[requestName]),
          response
        );
      },
      label,
      code
    );
  }

  const changedRequest = structuredClone(requests["multi-stage"]);
  changedRequest.languageFeatures = ["f16"];
  expectRejected(
    () =>
      assertInventoryResponseSemantics(
        changedRequest,
        encodeInventoryRequest(requests["multi-stage"]),
        responses["multi-stage"]
      ),
    "retained request changed after encoding",
    "VGPU-C1-INVENTORY-REQUEST-BYTES"
  );

  return {
    status: "passed",
    requests: Object.keys(requests).length,
    responses: Object.keys(responses).length,
    prelaunchMutations: prelaunchMutations.length,
    responseMutations: responseMutations.length,
    associationMutations: 1,
    workerLaunches: launches,
  };
}

async function invokeInventoryWorker(executable, request, validators) {
  const requestBytes = prepareInventoryInvocation(
    request,
    validators,
    (bytes) => bytes
  );
  return invokeRawInventoryWorker(
    executable,
    request,
    requestBytes,
    validators
  );
}

async function invokeRawInventoryWorker(
  executable,
  request,
  requestBytes,
  validators
) {
  const worker = startTintWorker({ executable });
  try {
    await worker.write(Buffer.from(requestBytes, "utf8"));
    worker.end();
  } catch (error) {
    worker.terminate(error);
  }
  const attempt = await worker.result;
  const response = decodeTintWorkerResponse(attempt, (value) =>
    assertSchema(validators.response, value, "worker response")
  );
  assertInventoryResponseSemantics(request, requestBytes, response);
  return { attempt, response };
}

function refreshSingleSourceCapsule(request) {
  request.source.sha256 = sha256Utf8(request.source.text);
  request.originMap.generatedSource.sha256 = request.source.sha256;
  request.originMap.sources[0].sha256 = request.source.sha256;
  request.originMap.segments[0].generated.endByte = Buffer.byteLength(
    request.source.text,
    "utf8"
  );
  request.originMapSha256 = originMapSha256(request.originMap);
  return request;
}

function assertWorkerProtocolFailure(request, requestBytes, run, label) {
  const { response } = run;
  same(
    response.requestIdentity,
    inventoryRequestIdentity(requestBytes),
    `${label} returned the wrong raw request identity`
  );
  assert(response.ok === false, `${label} did not return ok:false`);
  assert(!Object.hasOwn(response, "result"), `${label} returned a result`);
  assert(
    response.diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" && diagnostic.phase === "protocol"
    ),
    `${label} omitted its structured protocol error`
  );
  return request;
}

async function runNativeGate(executable, validators, requests, responses) {
  if (!executable)
    return { status: "skipped", reason: "no inventory worker supplied" };
  const results = {};
  const fixtureNames = Object.keys(requests).sort();
  for (const name of fixtureNames) {
    const first = await invokeInventoryWorker(
      executable,
      requests[name],
      validators
    );
    const second = await invokeInventoryWorker(
      executable,
      requests[name],
      validators
    );
    assert(
      first.attempt.stdout === second.attempt.stdout &&
        isDeepStrictEqual(first.response, second.response),
      `${name} worker response is not byte deterministic`
    );
    same(
      first.response.ok,
      responses[name].ok,
      `${name} returned the wrong outcome`
    );
    if (name !== "invalid-wgsl") {
      same(
        first.response.result.entryPoints,
        responses[name].result.entryPoints,
        "worker returned a different canonical entry inventory"
      );
    } else {
      assert(
        first.response.diagnostics.some(
          (diagnostic) =>
            diagnostic.severity === "error" && diagnostic.phase === "wgsl"
        ),
        "invalid WGSL did not return a structured WGSL error"
      );
    }
    results[name] = { ok: first.response.ok, deterministic: true };
  }

  const protocolMutations = [
    ["unknown-top-level-field", (value) => (value.unknown = true)],
    [
      "stale-origin-map-hash",
      (value) => (value.originMapSha256 = "0".repeat(64)),
    ],
    [
      "source-nul",
      (value) => {
        value.source.text += "\u0000";
        refreshSingleSourceCapsule(value);
      },
    ],
    [
      "unordered-features",
      (value) => (value.languageFeatures = ["f16", "dual_source_blending"]),
    ],
  ];
  for (const [label, mutate] of protocolMutations) {
    const request = structuredClone(requests["library-only"]);
    mutate(request);
    const requestBytes = encodeInventoryRequest(request);
    const run = await invokeRawInventoryWorker(
      executable,
      request,
      requestBytes,
      validators
    );
    assertWorkerProtocolFailure(request, requestBytes, run, label);
  }

  const unicodeOrigin = structuredClone(requests["library-only"]);
  unicodeOrigin.originMap.sources[0].input = "inventario-caf\u00e9";
  unicodeOrigin.originMap.segments[0].origin.input = "inventario-caf\u00e9";
  unicodeOrigin.originMapSha256 = originMapSha256(unicodeOrigin.originMap);
  const unicodeRun = await invokeInventoryWorker(
    executable,
    unicodeOrigin,
    validators
  );
  assert(unicodeRun.response.ok === true, "NFC Unicode origin was rejected");

  return {
    status: "passed",
    invocations: fixtureNames.length * 2 + protocolMutations.length + 1,
    fixtureInvocations: fixtureNames.length * 2,
    workerProtocolMutations: protocolMutations.length,
    transientInvocations: 1,
    results,
  };
}

const options = parseArguments(process.argv.slice(2));
const validators = loadValidators();
const requests = fixtureMap(join(fixtureDirectory, "fixtures", "requests"));
const responses = fixtureMap(join(fixtureDirectory, "fixtures", "responses"));
const staticGate = runStaticGate(validators, requests, responses);
const nativeGate = await runNativeGate(
  options.worker,
  validators,
  requests,
  responses
);
if (options.requireWorker && nativeGate.status !== "passed") {
  fail("inventory worker was required but did not pass");
}
process.stdout.write(
  `${JSON.stringify(
    {
      status: nativeGate.status === "passed" ? "passed" : "static-passed",
      contract: "vgpu-native-tint-entry-inventory/v1",
      static: staticGate,
      native: nativeGate,
    },
    null,
    2
  )}\n`
);
