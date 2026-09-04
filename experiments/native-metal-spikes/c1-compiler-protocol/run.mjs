#!/usr/bin/env node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  compileTintPrototype,
  invokeTintPrototype,
  runCommand,
} from "./lib/native-compiler.mjs";
import {
  assertRequestSemantics,
  assertResponseSemantics,
  attachDiagnosticOrigins,
  COMPILER_CONTRACT,
  sha256Utf8,
  TINT_REVISION,
} from "./lib/protocol.mjs";
import {
  canonicalRequestHash,
  resolveVirtualShader,
  RESOLVER_REQUEST_HASH_DOMAIN,
} from "./lib/virtual-resolver.mjs";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const expectedInternalReservation = {
  role: "immediate-data",
  slots: [
    {
      mode: "direct",
      resourceClass: "buffer",
      component: "buffer",
      index: 30,
      count: 1,
    },
  ],
};

function fail(message) {
  throw new Error(`C1 compiler protocol: ${message}`);
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArguments(argv) {
  const options = {
    releaseRoot: process.env.C1_COMPILER_PROTOCOL_TINT_RELEASE_ROOT,
    compatInclude: process.env.C1_COMPILER_PROTOCOL_TINT_COMPAT_INCLUDE,
    requireTint: process.env.C1_COMPILER_PROTOCOL_REQUIRE_TINT === "1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: node run.mjs [--release-root <Dawn release>] " +
          "[--compat-include <header overlay>] [--require-tint]\n"
      );
      process.exit(0);
    }
    if (argument === "--require-tint") {
      options.requireTint = true;
      continue;
    }
    if (argument === "--release-root" || argument === "--compat-include") {
      const value = argv[++index];
      if (!value) fail(`${argument} requires a value`);
      options[argument === "--release-root" ? "releaseRoot" : "compatInclude"] =
        resolve(value);
      continue;
    }
    fail(`unknown argument ${argument}`);
  }
  if (options.releaseRoot) options.releaseRoot = resolve(options.releaseRoot);
  if (options.compatInclude)
    options.compatInclude = resolve(options.compatInclude);
  return options;
}

function loadValidators() {
  const schemas = {
    origin: readJSON(
      join(fixtureDirectory, "contracts", "origin-map-v1.schema.json")
    ),
    request: readJSON(
      join(fixtureDirectory, "contracts", "request-v1.schema.json")
    ),
    response: readJSON(
      join(fixtureDirectory, "contracts", "response-v1.schema.json")
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
}

function expectRejected(run, label, expectedCode) {
  try {
    run();
  } catch (error) {
    if (!expectedCode || error?.code !== expectedCode) {
      fail(
        `${label} rejected with ${String(error?.code)} instead of ${String(
          expectedCode
        )}`
      );
    }
    return;
  }
  fail(`${label} escaped its negative gate`);
}

function loadFixtureMap(directory) {
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => [name.slice(0, -5), readJSON(join(directory, name))])
  );
}

function runContractGate(validators) {
  const requests = loadFixtureMap(
    join(fixtureDirectory, "fixtures", "requests")
  );
  const responses = loadFixtureMap(
    join(fixtureDirectory, "fixtures", "responses")
  );
  for (const [id, request] of Object.entries(requests)) {
    assertSchema(validators.request, request, `${id} request`);
    assertRequestSemantics(request);
  }
  for (const [id, response] of Object.entries(responses)) {
    const request = requests[id];
    if (!request) fail(`${id} response has no request fixture`);
    assertSchema(validators.response, response, `${id} response`);
    const enriched = attachDiagnosticOrigins(request, response);
    assertSchema(validators.response, enriched, `${id} enriched response`);
    assertResponseSemantics(request, enriched);
  }
  if (
    JSON.stringify(Object.keys(requests)) !==
    JSON.stringify(Object.keys(responses))
  ) {
    fail("request and response fixtures are not exact named pairs");
  }

  const requestSchemaMutations = [
    ["unknown-property", (value) => (value.unknown = true)],
    [
      "wrong-contract",
      (value) => (value.contractId = "vgpu-native-tint-compiler/v2"),
    ],
    ["reserved-emitted-name", (value) => (value.entryPoint.metal = "thread")],
    [
      "non-finite-f32",
      (value) =>
        (value.overrides = [
          { name: "VALUE", value: { type: "f32", bits: "7f800000" } },
        ]),
    ],
    [
      "expanded-resource",
      (value) =>
        value.metal.bindings[0].slots.push({
          mode: "direct",
          resourceClass: "sampler",
          component: "sampler",
          index: 0,
          count: 1,
        }),
    ],
    [
      "incoherent-component",
      (value) => (value.metal.bindings[0].slots[0].component = "texture"),
    ],
    [
      "internal-slot-drift",
      (value) => (value.metal.internalReservations[0].slots[0].index = 29),
    ],
    [
      "size-offset-drift",
      (value) => (value.metal.storageBufferSizes.immediateDataByteOffset = 8),
    ],
    [
      "absolute-origin-input",
      (value) => (value.originMap.sources[0].input = "/Users/test/shader.wgsl"),
    ],
    [
      "windows-source-path",
      (value) => {
        value.source.virtualPath = "C:/shader.wgsl";
        value.originMap.generatedSource.virtualPath = "C:/shader.wgsl";
      },
    ],
    [
      "file-uri-source-path",
      (value) => {
        value.source.virtualPath = "file:/Users/test/shader.wgsl";
        value.originMap.generatedSource.virtualPath =
          "file:/Users/test/shader.wgsl";
      },
    ],
    [
      "unc-origin-input",
      (value) =>
        (value.originMap.sources[0].input = "\\\\server\\share\\shader.wgsl"),
    ],
  ];
  for (const [id, mutate] of requestSchemaMutations) {
    const request = structuredClone(requests["runtime-array"]);
    mutate(request);
    if (validators.request(request)) fail(`${id} escaped request schema`);
  }

  const requestSemanticMutations = [
    [
      "source-hash",
      "runtime-array",
      (value) => (value.source.sha256 = "0".repeat(64)),
    ],
    [
      "crossed-origin-source",
      "runtime-array",
      (value) => (value.originMap.generatedSource.sha256 = "0".repeat(64)),
    ],
    [
      "origin-overlap",
      "wgsl-error",
      (value) => (value.originMap.segments[1].generated.startByte = 80),
    ],
    [
      "origin-unknown-input",
      "runtime-array",
      (value) => (value.originMap.segments[0].origin.input = "absent-wgsl"),
    ],
    [
      "origin-source-order",
      "wgsl-error",
      (value) => value.originMap.sources.reverse(),
    ],
    [
      "feature-order",
      "noop",
      (value) =>
        (value.languageFeatures = [
          "unrestricted_pointer_parameters",
          "uniform_buffer_standard_layout",
        ]),
    ],
    [
      "duplicate-override-name",
      "noop",
      (value) =>
        (value.overrides = [
          { name: "VALUE", value: { type: "u32", value: 1 } },
          { name: "VALUE", value: { type: "u32", value: 2 } },
        ]),
    ],
    [
      "binding-order",
      "runtime-array",
      (value) =>
        (value.metal.bindings = [
          binding(0, 1, "buffer", 1),
          binding(0, 0, "buffer", 0),
        ]),
    ],
    [
      "duplicate-binding-point",
      "runtime-array",
      (value) =>
        (value.metal.bindings = [
          binding(0, 0, "buffer", 0),
          binding(0, 0, "buffer", 1),
        ]),
    ],
    [
      "slot-collision",
      "runtime-array",
      (value) =>
        (value.metal.bindings = [
          binding(0, 0, "buffer", 0),
          binding(0, 1, "buffer", 0),
        ]),
    ],
    [
      "internal-collision",
      "runtime-array",
      (value) => (value.metal.bindings[0].slots[0].index = 30),
    ],
    [
      "nfd-virtual-path",
      "noop",
      (value) => {
        value.source.virtualPath = "resolved/Cafe\u0301.wgsl";
        value.originMap.generatedSource.virtualPath =
          "resolved/Cafe\u0301.wgsl";
      },
    ],
    [
      "nfd-origin-input",
      "noop",
      (value) => {
        value.originMap.sources[0].input = "Cafe\u0301-wgsl";
        value.originMap.segments[0].origin.input = "Cafe\u0301-wgsl";
      },
    ],
    [
      "split-utf8-origin",
      "noop",
      (value) => {
        value.source.text = `// 😀\n${value.source.text}`;
        value.source.sha256 = sha256Utf8(value.source.text);
        value.originMap.generatedSource.sha256 = value.source.sha256;
        value.originMap.sources[0].sha256 = value.source.sha256;
        value.originMap.segments = [
          {
            generated: {
              startByte: 4,
              endByte: Buffer.byteLength(value.source.text, "utf8"),
            },
            origin: { input: "noop-wgsl" },
            precision: "module",
          },
        ];
      },
    ],
    [
      "adjacent-equal-origin",
      "noop",
      (value) => {
        value.originMap.segments = [
          {
            generated: { startByte: 0, endByte: 10 },
            origin: { input: "noop-wgsl" },
            precision: "module",
          },
          {
            generated: { startByte: 10, endByte: 41 },
            origin: { input: "noop-wgsl" },
            precision: "module",
          },
        ];
      },
    ],
    [
      "isolated-surrogate-source",
      "noop",
      (value) => (value.source.text = "\ud800"),
    ],
  ];
  const requestSemanticCodes = {
    "source-hash": "VGPU-C1-PROTOCOL-SOURCE-HASH",
    "crossed-origin-source": "VGPU-C1-PROTOCOL-ORIGIN-SOURCE",
    "origin-overlap": "VGPU-C1-PROTOCOL-ORIGIN-RANGE",
    "origin-unknown-input": "VGPU-C1-PROTOCOL-ORIGIN-INPUT",
    "origin-source-order": "VGPU-C1-PROTOCOL-CANONICAL",
    "feature-order": "VGPU-C1-PROTOCOL-CANONICAL",
    "duplicate-override-name": "VGPU-C1-PROTOCOL-CANONICAL",
    "binding-order": "VGPU-C1-PROTOCOL-CANONICAL",
    "duplicate-binding-point": "VGPU-C1-PROTOCOL-CANONICAL",
    "slot-collision": "VGPU-C1-PROTOCOL-SLOT-COLLISION",
    "internal-collision": "VGPU-C1-PROTOCOL-INTERNAL-COLLISION",
    "nfd-virtual-path": "VGPU-C1-PROTOCOL-VIRTUAL-PATH",
    "nfd-origin-input": "VGPU-C1-PROTOCOL-INPUT-ID",
    "split-utf8-origin": "VGPU-C1-PROTOCOL-ORIGIN-UTF8",
    "adjacent-equal-origin": "VGPU-C1-PROTOCOL-ORIGIN-CANONICAL",
    "isolated-surrogate-source": "VGPU-C1-PROTOCOL-UNICODE",
  };
  for (const [id, base, mutate] of requestSemanticMutations) {
    const request = structuredClone(requests[base]);
    mutate(request);
    assertSchema(validators.request, request, `${id} mutation precondition`);
    expectRejected(
      () => assertRequestSemantics(request),
      id,
      requestSemanticCodes[id]
    );
  }

  const responseSchemaMutations = [
    [
      "success-with-error",
      "noop",
      (value) =>
        value.diagnostics.push({
          code: "VGPU-NATIVE-TEST",
          severity: "error",
          phase: "internal",
          message: "synthetic",
        }),
    ],
    [
      "failure-without-error",
      "generate-failure",
      (value) => (value.diagnostics = []),
    ],
    [
      "region-without-internal",
      "runtime-array",
      (value) => (value.result.internalBindings = []),
    ],
    [
      "non-wgsl-location",
      "generate-failure",
      (value) =>
        (value.diagnostics[0].location = {
          kind: "generated-wgsl",
          virtualPath: "resolved/generate-failure.wgsl",
          start: { line: 1, column: 1 },
          end: { line: 1, column: 2 },
        }),
    ],
  ];
  for (const [id, base, mutate] of responseSchemaMutations) {
    const response = structuredClone(responses[base]);
    mutate(response);
    if (validators.response(response)) fail(`${id} escaped response schema`);
  }

  const responseSemanticMutations = [
    [
      "response-binding-drift",
      "runtime-array",
      (value) => (value.result.bindings[0].slots[0].index = 1),
      (request, response) => assertResponseSemantics(request, response),
    ],
    [
      "diagnostic-source-drift",
      "wgsl-error",
      (value) =>
        (value.diagnostics[0].location.virtualPath = "resolved/other.wgsl"),
      (request, response) => attachDiagnosticOrigins(request, response),
    ],
    [
      "diagnostic-origin-drift",
      "wgsl-error",
      (value) => (value.diagnostics[0].location.origin.input = "main-wgsl"),
      (request, response) => attachDiagnosticOrigins(request, response),
    ],
    [
      "non-wgsl-location-semantic",
      "generate-failure",
      (value) =>
        (value.diagnostics[0].location = {
          kind: "generated-wgsl",
          virtualPath: "resolved/generate-failure.wgsl",
          start: { line: 1, column: 1 },
          end: { line: 1, column: 2 },
        }),
      (request, response) => assertResponseSemantics(request, response),
      false,
    ],
    [
      "comment-only-entry-name",
      "noop",
      (value) =>
        (value.result.msl =
          "// vgpu_noop is not an entry declaration\nkernel void other() {}\n"),
      (request, response) => assertResponseSemantics(request, response),
    ],
  ];
  const responseSemanticCodes = {
    "response-binding-drift": "VGPU-C1-PROTOCOL-BINDINGS",
    "diagnostic-source-drift": "VGPU-C1-PROTOCOL-DIAGNOSTIC-SOURCE",
    "diagnostic-origin-drift": "VGPU-C1-PROTOCOL-DIAGNOSTIC-ORIGIN",
    "non-wgsl-location-semantic": "VGPU-C1-PROTOCOL-DIAGNOSTIC-PHASE",
    "comment-only-entry-name": "VGPU-C1-PROTOCOL-MSL-ENTRY",
  };
  for (const [
    id,
    base,
    mutate,
    verify,
    schemaPrecondition = true,
  ] of responseSemanticMutations) {
    const response = structuredClone(responses[base]);
    mutate(response);
    if (schemaPrecondition) {
      assertSchema(
        validators.response,
        response,
        `${id} mutation precondition`
      );
    }
    expectRejected(
      () => verify(requests[base], response),
      id,
      responseSemanticCodes[id]
    );
  }

  return {
    requests,
    status: "passed",
    requestFixtures: Object.keys(requests).length,
    responseFixtures: Object.keys(responses).length,
    schemaMutations:
      requestSchemaMutations.length + responseSchemaMutations.length,
    semanticMutations:
      requestSemanticMutations.length + responseSemanticMutations.length,
  };
}

function runResolverGate() {
  const result = runCommand(process.execPath, [
    join(fixtureDirectory, "lib", "self-check.mjs"),
  ]);
  if (result.error || result.signal || result.status !== 0) {
    fail(`virtual resolver gate failed: ${result.stderr || result.stdout}`);
  }
  const summary = result.stdout.trim();
  if (!summary.startsWith("PASS virtual resolver:")) {
    fail(`virtual resolver returned an unexpected summary: ${summary}`);
  }
  return { status: "passed", summary };
}

function binding(group, bindingIndex, resourceClass, index, count = 1) {
  return {
    group,
    binding: bindingIndex,
    slots: [
      {
        mode: "direct",
        resourceClass,
        component: resourceClass,
        index,
        count,
      },
    ],
  };
}

function singleSourceRequest({
  input,
  virtualPath,
  text,
  stage = "compute",
  entryPoint = "main",
  emittedName,
  bindings = [],
  overrides = [],
  languageFeatures = [],
}) {
  const sha256 = sha256Utf8(text);
  return {
    schemaVersion: 1,
    contractId: COMPILER_CONTRACT,
    source: { virtualPath, sha256, text },
    originMap: {
      schemaVersion: 1,
      contractId: "vgpu-native-origin-map/v1",
      generatedSource: { virtualPath, sha256 },
      sources: [{ input, sha256 }],
      segments: [
        {
          generated: { startByte: 0, endByte: Buffer.byteLength(text, "utf8") },
          origin: { input },
          precision: "module",
        },
      ],
    },
    entryPoint: { stage, wgsl: entryPoint, metal: emittedName },
    overrides,
    languageFeatures,
    metal: {
      bindingModel: "vgpu-metal-binding-slots-v1",
      bindings,
      internalReservations: [structuredClone(expectedInternalReservation)],
      storageBufferSizes: {
        model: "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
        immediateDataByteOffset: 4,
      },
    },
  };
}

async function resolverCompilerRequest() {
  const graph = await resolveVirtualShader({
    entry: "Shaders/main.wgsl",
    generatedVirtualPath: "Intermediate/Resolved.compute.wgsl",
    sources: [
      {
        id: "resolved-main-wgsl",
        virtualPath: "Shaders/main.wgsl",
        text: `import { scale } from "./lib/scale.wgsl";

struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> output: array<f32, 1>;

@compute @workgroup_size(1)
fn main() {
  output[0] = scale(params.value);
}`,
      },
      {
        id: "resolved-scale-wgsl",
        virtualPath: "Shaders/lib/scale.wgsl",
        text: "export fn scale(value: f32) -> f32 { return value * 2.0; }",
      },
    ],
  });
  const entryPoint = graph.resolved.reflection.entryPoints.find(
    (candidate) => candidate.name === "main"
  );
  if (!entryPoint || entryPoint.stage !== "compute") {
    fail("resolver integration did not reflect the selected compute entry");
  }
  return {
    request: {
      schemaVersion: 1,
      contractId: COMPILER_CONTRACT,
      source: {
        virtualPath: graph.originMap.generatedSource.virtualPath,
        sha256: graph.originMap.generatedSource.sha256,
        text: graph.resolved.wgsl,
      },
      originMap: graph.originMap,
      entryPoint: {
        stage: "compute",
        wgsl: entryPoint.mangledName,
        metal: "vgpu_resolved_main",
      },
      overrides: [],
      languageFeatures: [],
      metal: {
        bindingModel: "vgpu-metal-binding-slots-v1",
        bindings: [binding(0, 0, "buffer", 0), binding(0, 1, "buffer", 1)],
        internalReservations: [structuredClone(expectedInternalReservation)],
        storageBufferSizes: {
          model: "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
          immediateDataByteOffset: 4,
        },
      },
    },
    resolverRequestHash: graph.requestHash,
  };
}

function nativeFixtureRequests(contractRequests) {
  const fixedPrefix = singleSourceRequest({
    input: "fixed-prefix-wgsl",
    virtualPath: "resolved/fixed-prefix.wgsl",
    emittedName: "vgpu_fixed_prefix",
    bindings: [binding(0, 0, "buffer", 7), binding(0, 1, "buffer", 0)],
    text: `struct RuntimeValues {
  prefix: u32,
  values: array<u32>,
}
@group(0) @binding(0) var<storage, read> values: RuntimeValues;
@group(0) @binding(1) var<storage, read_write> output: array<u32, 1>;
@compute @workgroup_size(1)
fn main() { output[0] = values.prefix; }
`,
  });
  const typedOverrides = singleSourceRequest({
    input: "typed-overrides-wgsl",
    virtualPath: "resolved/typed-overrides.wgsl",
    emittedName: "vgpu_typed_overrides",
    languageFeatures: ["f16"],
    bindings: [binding(0, 0, "buffer", 0)],
    overrides: [
      { name: "FLAG", value: { type: "bool", value: true } },
      { name: "HALF", value: { type: "f16", bits: "3800" } },
      { name: "SIGNED", value: { type: "i32", value: -7 } },
      { name: "SINGLE", value: { type: "f32", bits: "3fc00000" } },
      { name: "UNSIGNED", value: { type: "u32", value: 8 } },
    ],
    text: `enable f16;
override FLAG: bool = false;
override HALF: f16 = 1.0h;
override SIGNED: i32 = 1;
override SINGLE: f32 = 1.0;
override UNSIGNED: u32 = 1u;
struct Output { values: array<f32, 5> }
@group(0) @binding(0) var<storage, read_write> output: Output;
@compute @workgroup_size(UNSIGNED)
fn main() {
  output.values[0] = select(0.0, 1.0, FLAG);
  output.values[1] = f32(SIGNED);
  output.values[2] = f32(HALF);
  output.values[3] = SINGLE;
  output.values[4] = f32(UNSIGNED);
}
`,
  });
  const resources = singleSourceRequest({
    input: "resource-namespaces-wgsl",
    virtualPath: "resolved/resource-namespaces.wgsl",
    emittedName: "vgpu_resource_namespaces",
    bindings: [
      binding(0, 0, "buffer", 0),
      binding(0, 1, "texture", 0),
      binding(0, 2, "sampler", 0),
      binding(0, 3, "buffer", 1),
    ],
    text: `struct Params { uv: vec2f }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var image_sampler: sampler;
@group(0) @binding(3) var<storage, read_write> output: array<vec4f, 1>;
@compute @workgroup_size(1)
fn main() { output[0] = textureSampleLevel(image, image_sampler, params.uv, 0.0); }
`,
  });
  const resourceArray = singleSourceRequest({
    input: "resource-array-wgsl",
    virtualPath: "resolved/resource-array.wgsl",
    emittedName: "vgpu_resource_array",
    languageFeatures: ["sized_binding_array"],
    bindings: [
      binding(0, 0, "texture", 0, 3),
      binding(0, 1, "sampler", 0),
      binding(0, 2, "texture", 3),
      binding(0, 3, "sampler", 1),
    ],
    text: readFileSync(
      join(
        fixtureDirectory,
        "..",
        "c1-binding-slots",
        "canaries",
        "resource-arrays.wgsl"
      ),
      "utf8"
    ),
  });
  const longIdentifier = "a".repeat(20_000);
  const boundedDiagnostic = singleSourceRequest({
    input: "bounded-diagnostic-wgsl",
    virtualPath: "resolved/bounded-diagnostic.wgsl",
    emittedName: "vgpu_bounded_diagnostic",
    text: `@compute @workgroup_size(1)
fn main() {
  let value = ${longIdentifier};
}
`,
  });
  return {
    boundedDiagnostic,
    fixedPrefix,
    typedOverrides,
    resources,
    resourceArray,
    ...contractRequests,
  };
}

function assertExpectedNativeResult(id, response, expectation) {
  if (response.ok !== expectation.ok) {
    fail(
      `${id} returned ok=${response.ok}: ${JSON.stringify(
        response.diagnostics
      )}`
    );
  }
  if (!response.ok) {
    const matchingError = response.diagnostics.find(
      (diagnostic) =>
        diagnostic.severity === "error" &&
        (expectation.phase === undefined ||
          diagnostic.phase === expectation.phase) &&
        (expectation.code === undefined ||
          diagnostic.code === expectation.code) &&
        (expectation.messageIncludes === undefined ||
          diagnostic.message.includes(expectation.messageIncludes)) &&
        (expectation.origin === undefined ||
          diagnostic.location?.origin?.input === expectation.origin) &&
        (expectation.location === undefined ||
          JSON.stringify(diagnostic.location) ===
            JSON.stringify(expectation.location))
    );
    if (!matchingError) {
      fail(
        `${id} omitted its expected error: ${JSON.stringify(
          response.diagnostics
        )}`
      );
    }
    if (
      response.diagnostics.some(
        (diagnostic) => Buffer.byteLength(diagnostic.message, "utf8") > 16_384
      )
    ) {
      fail(`${id} returned an oversized diagnostic message`);
    }
    return;
  }
  if (
    response.result.internalBindings.length !==
      (expectation.internalBindings ?? 0) ||
    response.result.storageBufferSizeRegions.length !==
      (expectation.sizeRegions ?? 0)
  ) {
    fail(
      `${id} returned unexpected effective internal bindings or size regions`
    );
  }
  if (
    expectation.workgroupX !== undefined &&
    response.result.resolvedWorkgroupSize?.x !== expectation.workgroupX
  ) {
    fail(`${id} returned an unexpected resolved workgroup size`);
  }
  const stageKeyword = {
    compute: "kernel",
    fragment: "fragment",
    vertex: "vertex",
  }[response.result.entryPoint.stage];
  if (
    !response.result.msl.includes(
      `${stageKeyword} void ${response.result.entryPoint.metal}(`
    )
  ) {
    fail(`${id} MSL omitted the selected emitted entry declaration`);
  }
  for (const token of expectation.mslIncludes ?? []) {
    if (!response.result.msl.includes(token)) {
      fail(`${id} MSL omitted ${JSON.stringify(token)}`);
    }
  }
}

function runOneNativeCase({
  id,
  request,
  expectation,
  executable,
  scratch,
  validators,
  physicalPaths,
  validateRequest = true,
}) {
  if (validateRequest) {
    assertSchema(validators.request, request, `${id} request`);
    assertRequestSemantics(request);
  }
  const attempts = ["first", "second"].map((suffix) =>
    invokeTintPrototype({ executable, request, scratch, id: `${id}-${suffix}` })
  );
  for (const attempt of attempts) {
    if (attempt.error || attempt.signal || attempt.status === null) {
      fail(`${id} prototype crashed: ${attempt.error ?? attempt.signal}`);
    }
    if (attempt.stderr !== "")
      fail(`${id} wrote outside the JSON channel: ${attempt.stderr}`);
  }
  if (
    attempts[0].status !== attempts[1].status ||
    attempts[0].stdout !== attempts[1].stdout
  ) {
    fail(`${id} prototype response is nondeterministic`);
  }
  let raw;
  try {
    raw = JSON.parse(attempts[0].stdout);
  } catch (error) {
    fail(
      `${id} did not return exactly one trustworthy JSON value: ${error.message}`
    );
  }
  if (
    (raw.ok && attempts[0].status !== 0) ||
    (!raw.ok && attempts[0].status === 0)
  ) {
    fail(
      `${id} prototype exit code disagrees with its temporary typed-CLI convention`
    );
  }
  for (const physicalPath of physicalPaths) {
    if (physicalPath && attempts[0].stdout.includes(physicalPath)) {
      fail(`${id} leaked physical path ${physicalPath}`);
    }
  }
  if (
    /(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\\\)/u.test(
      attempts[0].stdout
    )
  ) {
    fail(`${id} leaked an absolute host path`);
  }
  assertSchema(validators.response, raw, `${id} raw response`);
  const response = attachDiagnosticOrigins(request, raw);
  assertSchema(validators.response, response, `${id} response`);
  assertResponseSemantics(request, response);
  assertExpectedNativeResult(id, response, expectation);
  return { response, exitCode: attempts[0].status };
}

async function runTintGate(options, validators, contractRequests, scratch) {
  if (!options.releaseRoot) {
    if (options.requireTint) fail("Tint gate requires --release-root");
    return { status: "skipped", reason: "release-root-not-provided" };
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    if (options.requireTint)
      fail("the pinned feasibility archive requires Darwin arm64");
    return { status: "skipped", reason: "requires-darwin-arm64" };
  }
  const builds = ["compiler-a", "compiler-b"].map((name) => {
    const buildDirectory = join(scratch, name);
    mkdirSync(buildDirectory);
    return compileTintPrototype({
      fixtureDirectory,
      releaseRoot: options.releaseRoot,
      compatInclude: options.compatInclude,
      scratch: buildDirectory,
    });
  });
  if (builds[0].sha256 !== builds[1].sha256) {
    fail("prototype compiler build is not byte deterministic");
  }
  const executable = builds[0].executable;
  const requests = nativeFixtureRequests(contractRequests);
  const integrated = await resolverCompilerRequest();
  requests.resolverIntegrated = integrated.request;

  const positives = [
    ["noop", requests.noop, { ok: true }],
    [
      "runtime-array",
      requests["runtime-array"],
      {
        ok: true,
        internalBindings: 1,
        sizeRegions: 1,
        mslIncludes: ["[[buffer(0)]]", "[[buffer(30)]]"],
      },
    ],
    [
      "fixed-prefix",
      requests.fixedPrefix,
      { ok: true, mslIncludes: ["[[buffer(0)]]", "[[buffer(7)]]"] },
    ],
    [
      "typed-overrides",
      requests.typedOverrides,
      {
        ok: true,
        workgroupX: 8,
        mslIncludes: [
          "[[buffer(0)]]",
          "= 1.0f;",
          "= -7.0f;",
          "= 0.5f;",
          "= 1.5f;",
          "= 8.0f;",
        ],
      },
    ],
    [
      "resource-namespaces",
      requests.resources,
      {
        ok: true,
        mslIncludes: [
          "[[buffer(0)]]",
          "[[buffer(1)]]",
          "[[texture(0)]]",
          "[[sampler(0)]]",
        ],
      },
    ],
    [
      "resource-array",
      requests.resourceArray,
      {
        ok: true,
        mslIncludes: [
          "array<texture2d<float, access::sample>, 3>",
          "[[texture(0)]]",
          "[[texture(3)]]",
          "[[sampler(0)]]",
          "[[sampler(1)]]",
        ],
      },
    ],
    [
      "resolver-integrated",
      requests.resolverIntegrated,
      { ok: true, mslIncludes: ["[[buffer(0)]]", "[[buffer(1)]]"] },
    ],
  ];
  const results = new Map();
  for (const [id, request, expectation] of positives) {
    results.set(
      id,
      runOneNativeCase({
        id,
        request,
        expectation,
        executable,
        scratch,
        validators,
        physicalPaths: [options.releaseRoot, options.compatInclude, scratch],
      })
    );
  }

  const invalidWgsl = runOneNativeCase({
    id: "wgsl-error",
    request: requests["wgsl-error"],
    expectation: {
      ok: false,
      code: "VGPU-NATIVE-WGSL-INVALID",
      phase: "wgsl",
      origin: "helper-wgsl",
      location: {
        kind: "generated-wgsl",
        virtualPath: "resolved/imported-error.wgsl",
        start: { line: 3, column: 10 },
        end: { line: 3, column: 13 },
        origin: { input: "helper-wgsl", precision: "module" },
      },
    },
    executable,
    scratch,
    validators,
    physicalPaths: [options.releaseRoot, options.compatInclude, scratch],
  });
  results.set("wgsl-error", invalidWgsl);

  results.set(
    "bounded-diagnostic",
    runOneNativeCase({
      id: "bounded-diagnostic",
      request: requests.boundedDiagnostic,
      expectation: {
        ok: false,
        code: "VGPU-NATIVE-WGSL-INVALID",
        phase: "wgsl",
        messageIncludes: " [truncated]",
      },
      executable,
      scratch,
      validators,
      physicalPaths: [options.releaseRoot, options.compatInclude, scratch],
    })
  );

  const negativeCases = [];
  const addNegative = (
    id,
    base,
    mutate,
    phase,
    validateRequest = true,
    messageIncludes
  ) => {
    const request = structuredClone(base);
    mutate(request);
    const code = {
      inspect: "VGPU-NATIVE-TINT-INSPECT",
      protocol: "VGPU-NATIVE-TINT-PROTOCOL",
    }[phase];
    negativeCases.push([
      id,
      request,
      { ok: false, code, phase, messageIncludes },
      validateRequest,
    ]);
  };
  addNegative(
    "stage-mismatch",
    requests.noop,
    (request) => (request.entryPoint.stage = "fragment"),
    "inspect",
    true,
    "selected WGSL entry point has a different stage"
  );
  addNegative(
    "missing-active-override",
    requests.typedOverrides,
    (request) => request.overrides.pop(),
    "inspect",
    true,
    "request override set differs"
  );
  addNegative(
    "wrong-override-type",
    requests.typedOverrides,
    (request) => (request.overrides[3].value = { type: "u32", value: 1 }),
    "inspect",
    true,
    "request override type differs"
  );
  addNegative(
    "unknown-language-feature",
    requests.noop,
    (request) => (request.languageFeatures = ["future_feature"]),
    "protocol",
    true,
    "unsupported language feature"
  );
  addNegative(
    "reserved-emitted-name-core-guard",
    requests.noop,
    (request) => (request.entryPoint.metal = "thread"),
    "protocol",
    false,
    "--emitted-name must use the reserved vgpu_ identifier domain"
  );
  addNegative(
    "internal-slot-collision-core-guard",
    requests["runtime-array"],
    (request) => (request.metal.bindings[0].slots[0].index = 30),
    "protocol",
    false,
    "external buffer binding interval reaches reserved buffer(30)"
  );
  addNegative(
    "duplicate-binding-core-guard",
    requests.fixedPrefix,
    (request) => (request.metal.bindings[1].binding = 0),
    "protocol",
    false,
    "binding mapping repeats a WGSL binding point"
  );
  addNegative(
    "incoherent-component-core-guard",
    requests["runtime-array"],
    (request) => (request.metal.bindings[0].slots[0].component = "texture"),
    "protocol",
    false,
    "binding mapping has an unsupported or incoherent direct component"
  );
  addNegative(
    "missing-reflected-binding",
    requests.resources,
    (request) => request.metal.bindings.pop(),
    "inspect",
    true,
    "binding mapping count differs"
  );
  addNegative(
    "extra-unreflected-binding",
    requests.resources,
    (request) => request.metal.bindings.push(binding(9, 9, "buffer", 2)),
    "inspect",
    true,
    "binding mapping count differs"
  );
  addNegative(
    "wrong-reflected-resource-class",
    requests.resources,
    (request) => {
      request.metal.bindings[0].slots[0] = {
        mode: "direct",
        resourceClass: "texture",
        component: "texture",
        index: 5,
        count: 1,
      };
    },
    "inspect",
    true,
    "binding mapping differs"
  );
  addNegative(
    "wrong-reflected-binding-count",
    requests.resourceArray,
    (request) => (request.metal.bindings[0].slots[0].count = 2),
    "inspect",
    true,
    "binding mapping differs"
  );
  for (const [id, request, expectation, validateRequest] of negativeCases) {
    results.set(
      id,
      runOneNativeCase({
        id,
        request,
        expectation,
        executable,
        scratch,
        validators,
        physicalPaths: [options.releaseRoot, options.compatInclude, scratch],
        validateRequest,
      })
    );
  }

  const runtime = results.get("runtime-array")?.response;
  if (
    !runtime?.result?.msl.includes("[[buffer(30)]]") ||
    !runtime.result.msl.includes("tint_storage_buffer_sizes")
  ) {
    fail("runtime-array MSL omitted the shared immediate size transport");
  }
  const fixed = results.get("fixed-prefix")?.response;
  if (
    fixed?.result?.msl.includes("[[buffer(30)]]") ||
    fixed?.result?.msl.includes("tint_storage_buffer_sizes")
  ) {
    fail("fixed-prefix MSL emitted an unused size transport");
  }
  const arrays = results.get("resource-array")?.response;
  if (
    !arrays?.result?.msl.includes("array<texture2d<float, access::sample>, 3>")
  ) {
    fail(
      "resource-array MSL omitted its three-element sampled texture binding"
    );
  }
  const resolverOutput = results.get("resolver-integrated")?.response;
  if (!resolverOutput || JSON.stringify(resolverOutput).includes("Shaders/")) {
    fail(
      "resolver/compiler boundary leaked an authored virtual module path into its response"
    );
  }

  const compilerRequestHash = canonicalRequestHash(
    requests.resolverIntegrated,
    "vgpu-c1-compiler-request/v1"
  );
  const reordered = structuredClone(requests.resolverIntegrated);
  reordered.metal.bindings.reverse();
  const reorderedCompilerHash = canonicalRequestHash(
    reordered,
    "vgpu-c1-compiler-request/v1"
  );
  const resolverDomainHash = canonicalRequestHash(
    requests.resolverIntegrated,
    RESOLVER_REQUEST_HASH_DOMAIN
  );
  if (
    compilerRequestHash.sha256 === reorderedCompilerHash.sha256 ||
    compilerRequestHash.sha256 === resolverDomainHash.sha256 ||
    integrated.resolverRequestHash.domain !== RESOLVER_REQUEST_HASH_DOMAIN
  ) {
    fail(
      "compiler request hashing collapsed distinct domains or binding order"
    );
  }

  return {
    status: "passed",
    dawnCommit: TINT_REVISION,
    compilerExecutableSha256: builds[0].sha256,
    verifiedHashes: [
      "include/**",
      "lib/libwebgpu_dawn.a",
      "src/utils/compiler.h",
    ],
    positiveCanaries: positives.length,
    negativeCanaries: negativeCases.length + 2,
    deterministicCanaries: results.size,
    moduleAttributedDiagnostics: "passed",
    sharedImmediateData: "passed",
    typedOverrides: 5,
    resolverCompilerBoundary: "passed",
  };
}

const options = parseArguments(process.argv.slice(2));
const validators = loadValidators();
const scratch = mkdtempSync(join(tmpdir(), "vgpu-c1-compiler-protocol-"));

try {
  const contracts = runContractGate(validators);
  const resolver = runResolverGate();
  const tint = await runTintGate(
    options,
    validators,
    contracts.requests,
    scratch
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        contractId: COMPILER_CONTRACT,
        contracts: {
          status: contracts.status,
          requestFixtures: contracts.requestFixtures,
          responseFixtures: contracts.responseFixtures,
          schemaMutations: contracts.schemaMutations,
          semanticMutations: contracts.semanticMutations,
        },
        resolver,
        tint,
      },
      null,
      2
    )}\n`
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
