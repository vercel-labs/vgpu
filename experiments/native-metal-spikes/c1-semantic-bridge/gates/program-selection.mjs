#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  AuthenticatedInventoryError,
  authenticateSuccessfulInventory,
} from "../lib/authenticated-inventory.mjs";
import {
  encodeInventoryRequest,
  INVENTORY_COMPILER,
  INVENTORY_CONTRACT,
  inventoryRequestIdentity,
  originMapSha256,
  sha256Utf8,
} from "../lib/protocol.mjs";
import {
  FULLSCREEN_TRIANGLE_INJECTION_PROFILE,
  isProgramSelectionPlan,
  isProgramSelectionPlanForInventory,
  ProgramSelectionError,
  selectProgramEntries,
} from "../lib/program-selection.mjs";

function inventoryFixture({ label, text, entryPoints }) {
  const configSource = `Shaders/${label}.wgsl`;
  const virtualPath = `Intermediate/${label}.resolved.wgsl`;
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
  const response = {
    schemaVersion: 1,
    contractId: INVENTORY_CONTRACT,
    ok: true,
    requestIdentity: inventoryRequestIdentity(requestBytes),
    compiler: INVENTORY_COMPILER,
    diagnostics: [],
    result: { entryPoints },
  };
  return {
    configSource,
    request,
    requestBytes,
    response,
    authenticated: authenticateSuccessfulInventory({
      configSource,
      request,
      requestBytes,
      response,
    }),
  };
}

function expectSelectionError(run, code, expected = {}) {
  let received;
  try {
    run();
  } catch (error) {
    received = error;
  }
  assert(received instanceof ProgramSelectionError);
  assert.equal(received.code, code);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(received[key], value, `${code} ${key}`);
  }
  return received;
}

function expectAuthenticationError(run, code) {
  let received;
  try {
    run();
  } catch (error) {
    received = error;
  }
  assert(received instanceof AuthenticatedInventoryError);
  assert.equal(received.code, code);
  return received;
}

const fragmentAndCompute = inventoryFixture({
  label: "fragment-compute",
  text: [
    "@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }",
    "@compute @workgroup_size(1) fn cs_main() {}",
    "",
  ].join("\n"),
  entryPoints: [
    { stage: "fragment", wgsl: "fs_main" },
    { stage: "compute", wgsl: "cs_main" },
  ],
});

const singleRender = inventoryFixture({
  label: "single-render",
  text: [
    "@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }",
    "@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }",
    "",
  ].join("\n"),
  entryPoints: [
    { stage: "vertex", wgsl: "vs_main" },
    { stage: "fragment", wgsl: "fs_main" },
  ],
});

const multiple = inventoryFixture({
  label: "multiple",
  text: [
    "@vertex fn alpha() -> @builtin(position) vec4f { return vec4f(0); }",
    "@vertex fn zebra() -> @builtin(position) vec4f { return vec4f(1); }",
    "@fragment fn beta() -> @location(0) vec4f { return vec4f(0); }",
    "@fragment fn gamma() -> @location(0) vec4f { return vec4f(1); }",
    "@compute @workgroup_size(1) fn zed() {}",
    "@compute @workgroup_size(1) fn zoom() {}",
    "",
  ].join("\n"),
  entryPoints: [
    { stage: "vertex", wgsl: "alpha" },
    { stage: "vertex", wgsl: "zebra" },
    { stage: "fragment", wgsl: "beta" },
    { stage: "fragment", wgsl: "gamma" },
    { stage: "compute", wgsl: "zed" },
    { stage: "compute", wgsl: "zoom" },
  ],
});

const noEntries = inventoryFixture({
  label: "library",
  text: "fn helper() {}\n",
  entryPoints: [],
});

const vertexOnly = inventoryFixture({
  label: "vertex-only",
  text: "@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }\n",
  entryPoints: [{ stage: "vertex", wgsl: "vs_main" }],
});

const computeOnly = inventoryFixture({
  label: "compute-only",
  text: "@compute @workgroup_size(1) fn cs_main() {}\n",
  entryPoints: [{ stage: "compute", wgsl: "cs_main" }],
});

const effectVertexInput = inventoryFixture({
  label: "effect-vertex-input",
  text: [
    "@vertex fn vs_buffer(@location(0) p: vec2f) -> @builtin(position) vec4f { return vec4f(p, 0, 1); }",
    "@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }",
    "",
  ].join("\n"),
  entryPoints: [
    { stage: "vertex", wgsl: "vs_buffer" },
    { stage: "fragment", wgsl: "fs_main" },
  ],
});

for (const mutate of [
  (response) => (response.result.entryPoints[0].wgsl = 1),
  (response) => (response.result.entryPoints[0].unexpected = true),
]) {
  const response = structuredClone(computeOnly.response);
  mutate(response);
  expectAuthenticationError(
    () =>
      authenticateSuccessfulInventory({
        configSource: computeOnly.configSource,
        request: computeOnly.request,
        requestBytes: computeOnly.requestBytes,
        response,
      }),
    "VGPU-C1-INVENTORY-SCHEMA"
  );
}

const failedResponse = structuredClone(computeOnly.response);
failedResponse.ok = false;
delete failedResponse.result;
failedResponse.diagnostics = [
  {
    code: "VGPU-WGSL-INVALID",
    severity: "error",
    phase: "wgsl",
    message: "reviewed failure fixture",
  },
];
expectAuthenticationError(
  () =>
    authenticateSuccessfulInventory({
      configSource: computeOnly.configSource,
      request: computeOnly.request,
      requestBytes: computeOnly.requestBytes,
      response: failedResponse,
    }),
  "VGPU-C1-INVENTORY-NOT-SUCCESS"
);

const reorderedIdentityResponse = structuredClone(computeOnly.response);
reorderedIdentityResponse.requestIdentity = {
  sha256: computeOnly.response.requestIdentity.sha256,
  domain: computeOnly.response.requestIdentity.domain,
};
const reorderedIdentityInventory = authenticateSuccessfulInventory({
  configSource: computeOnly.configSource,
  request: computeOnly.request,
  requestBytes: computeOnly.requestBytes,
  response: reorderedIdentityResponse,
});
assert.equal(
  JSON.stringify(reorderedIdentityInventory.requestIdentity),
  JSON.stringify(computeOnly.authenticated.requestIdentity)
);

const defaultEffect = selectProgramEntries(
  {
    name: "DefaultEffect",
    source: fragmentAndCompute.configSource,
  },
  fragmentAndCompute.authenticated
);
assert.deepEqual(defaultEffect, {
  name: "DefaultEffect",
  source: "Shaders/fragment-compute.wgsl",
  kind: "effect",
  inventoryRequestIdentity: fragmentAndCompute.authenticated.requestIdentity,
  entryPoints: {
    vertex: {
      stage: "vertex",
      origin: "injected",
      injectionProfile: FULLSCREEN_TRIANGLE_INJECTION_PROFILE,
    },
    fragment: { stage: "fragment", origin: "authored", wgsl: "fs_main" },
  },
});
assert(isProgramSelectionPlan(defaultEffect));
assert(!isProgramSelectionPlan(structuredClone(defaultEffect)));
assert(
  isProgramSelectionPlanForInventory(
    defaultEffect,
    fragmentAndCompute.authenticated
  )
);
assert(
  !isProgramSelectionPlanForInventory(
    defaultEffect,
    structuredClone(fragmentAndCompute.authenticated)
  )
);

const authoredEffect = selectProgramEntries(
  {
    name: "AuthoredEffect",
    source: singleRender.configSource,
    kind: "effect",
  },
  singleRender.authenticated
);
assert.deepEqual(authoredEffect, {
  name: "AuthoredEffect",
  source: "Shaders/single-render.wgsl",
  kind: "effect",
  inventoryRequestIdentity: singleRender.authenticated.requestIdentity,
  entryPoints: {
    vertex: { stage: "vertex", origin: "authored", wgsl: "vs_main" },
    fragment: { stage: "fragment", origin: "authored", wgsl: "fs_main" },
  },
});

const explicitEffect = selectProgramEntries(
  {
    name: "ExplicitEffect",
    source: multiple.configSource,
    kind: "effect",
    entryPoints: { vertex: "zebra", fragment: "gamma" },
  },
  multiple.authenticated
);
assert.deepEqual(explicitEffect.entryPoints, {
  vertex: { stage: "vertex", origin: "authored", wgsl: "zebra" },
  fragment: { stage: "fragment", origin: "authored", wgsl: "gamma" },
});

const inferredDraw = selectProgramEntries(
  {
    name: "InferredDraw",
    source: singleRender.configSource,
    kind: "draw",
  },
  singleRender.authenticated
);
assert.deepEqual(inferredDraw.entryPoints, {
  vertex: { stage: "vertex", origin: "authored", wgsl: "vs_main" },
  fragment: { stage: "fragment", origin: "authored", wgsl: "fs_main" },
});

const explicitDraw = selectProgramEntries(
  {
    name: "ExplicitDraw",
    source: multiple.configSource,
    kind: "draw",
    entryPoints: { vertex: "alpha", fragment: "beta" },
  },
  multiple.authenticated
);
assert.deepEqual(explicitDraw.entryPoints, {
  vertex: { stage: "vertex", origin: "authored", wgsl: "alpha" },
  fragment: { stage: "fragment", origin: "authored", wgsl: "beta" },
});

const inferredCompute = selectProgramEntries(
  {
    name: "InferredCompute",
    source: computeOnly.configSource,
    kind: "compute",
  },
  computeOnly.authenticated
);
assert.deepEqual(inferredCompute.entryPoints, {
  compute: { stage: "compute", origin: "authored", wgsl: "cs_main" },
});

assert.equal(
  Object.getOwnPropertyDescriptor(Object.prototype, "compute"),
  undefined
);
Object.defineProperty(Object.prototype, "compute", {
  configurable: true,
  enumerable: true,
  value: "polluted",
});
try {
  assert.deepEqual(
    selectProgramEntries(
      {
        name: "PrototypeSafeCompute",
        source: computeOnly.configSource,
        kind: "compute",
        entryPoints: {},
      },
      computeOnly.authenticated
    ).entryPoints,
    { compute: { stage: "compute", origin: "authored", wgsl: "cs_main" } }
  );
} finally {
  delete Object.prototype.compute;
}

const explicitCompute = selectProgramEntries(
  {
    name: "ExplicitCompute",
    source: multiple.configSource,
    kind: "compute",
    entryPoints: { compute: "zoom" },
  },
  multiple.authenticated
);
assert.deepEqual(explicitCompute.entryPoints, {
  compute: { stage: "compute", origin: "authored", wgsl: "zoom" },
});

// Explicitly naming a sole match is normalized away rather than becoming
// fingerprint-visible selection provenance.
const explicitSingleDraw = selectProgramEntries(
  {
    name: "InferredDraw",
    source: singleRender.configSource,
    kind: "draw",
    entryPoints: { vertex: "vs_main", fragment: "fs_main" },
  },
  singleRender.authenticated
);
assert.deepEqual(explicitSingleDraw, inferredDraw);

// Entry inventory owns discovery only. The effect-specific ban on vertex
// buffers is checked after semantic extraction, not inferred from WGSL here.
assert.deepEqual(
  selectProgramEntries(
    {
      name: "DeferredInterfaceCheck",
      source: effectVertexInput.configSource,
      kind: "effect",
    },
    effectVertexInput.authenticated
  ).entryPoints.vertex,
  { stage: "vertex", origin: "authored", wgsl: "vs_buffer" }
);

expectSelectionError(
  () =>
    selectProgramEntries(
      { name: "MissingFragment", source: noEntries.configSource },
      noEntries.authenticated
    ),
  "VGPU-C1-PROGRAM-ENTRY-MISSING",
  { program: "MissingFragment", kind: "effect", stage: "fragment" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "AmbiguousEffectFragment",
        source: multiple.configSource,
        kind: "effect",
        entryPoints: { vertex: "alpha" },
      },
      multiple.authenticated
    ),
  "VGPU-C1-PROGRAM-ENTRY-AMBIGUOUS",
  { stage: "fragment" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "AmbiguousEffectVertex",
        source: multiple.configSource,
        kind: "effect",
        entryPoints: { fragment: "beta" },
      },
      multiple.authenticated
    ),
  "VGPU-C1-PROGRAM-ENTRY-AMBIGUOUS",
  { stage: "vertex" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "MissingDrawVertex",
        source: fragmentAndCompute.configSource,
        kind: "draw",
      },
      fragmentAndCompute.authenticated
    ),
  "VGPU-C1-PROGRAM-ENTRY-MISSING",
  { stage: "vertex" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "MissingDrawFragment",
        source: vertexOnly.configSource,
        kind: "draw",
      },
      vertexOnly.authenticated
    ),
  "VGPU-C1-PROGRAM-ENTRY-MISSING",
  { stage: "fragment" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "MissingCompute",
        source: singleRender.configSource,
        kind: "compute",
      },
      singleRender.authenticated
    ),
  "VGPU-C1-PROGRAM-ENTRY-MISSING",
  { stage: "compute" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "AmbiguousCompute",
        source: multiple.configSource,
        kind: "compute",
      },
      multiple.authenticated
    ),
  "VGPU-C1-PROGRAM-ENTRY-AMBIGUOUS",
  { stage: "compute" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "UnknownCompute",
        source: computeOnly.configSource,
        kind: "compute",
        entryPoints: { compute: "missing" },
      },
      computeOnly.authenticated
    ),
  "VGPU-C1-PROGRAM-ENTRY-UNKNOWN",
  { stage: "compute", requested: "missing" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "WrongStage",
        source: multiple.configSource,
        kind: "compute",
        entryPoints: { compute: "beta" },
      },
      multiple.authenticated
    ),
  "VGPU-C1-PROGRAM-ENTRY-STAGE",
  { stage: "compute", requested: "beta" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "NoExplicitInjection",
        source: fragmentAndCompute.configSource,
        kind: "effect",
        entryPoints: { vertex: "vgpu_fullscreen_vertex" },
      },
      fragmentAndCompute.authenticated
    ),
  "VGPU-C1-PROGRAM-ENTRY-UNKNOWN",
  { stage: "vertex", requested: "vgpu_fullscreen_vertex" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "ForbiddenStage",
        source: computeOnly.configSource,
        kind: "compute",
        entryPoints: { fragment: "fs_main" },
      },
      computeOnly.authenticated
    ),
  "VGPU-C1-PROGRAM-CONFIG",
  { program: "ForbiddenStage", kind: "compute" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "MalformedName",
        source: computeOnly.configSource,
        kind: "compute",
        entryPoints: { compute: "not-an-identifier" },
      },
      computeOnly.authenticated
    ),
  "VGPU-C1-PROGRAM-CONFIG",
  { stage: "compute" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "NullKind",
        source: computeOnly.configSource,
        kind: null,
      },
      computeOnly.authenticated
    ),
  "VGPU-C1-PROGRAM-CONFIG"
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "NullEntryPoints",
        source: computeOnly.configSource,
        kind: "compute",
        entryPoints: null,
      },
      computeOnly.authenticated
    ),
  "VGPU-C1-PROGRAM-CONFIG"
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "UnprojectedProgram",
        source: computeOnly.configSource,
        kind: "compute",
        overrides: {},
      },
      computeOnly.authenticated
    ),
  "VGPU-C1-PROGRAM-CONFIG"
);

let topLevelGetterRead = false;
const topLevelAccessor = {
  source: computeOnly.configSource,
  kind: "compute",
};
Object.defineProperty(topLevelAccessor, "name", {
  enumerable: true,
  get() {
    topLevelGetterRead = true;
    return "Accessor";
  },
});
expectSelectionError(
  () => selectProgramEntries(topLevelAccessor, computeOnly.authenticated),
  "VGPU-C1-PROGRAM-CONFIG"
);
assert.equal(topLevelGetterRead, false);

let entryGetterRead = false;
const entryAccessor = {};
Object.defineProperty(entryAccessor, "compute", {
  enumerable: true,
  get() {
    entryGetterRead = true;
    return "cs_main";
  },
});
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "EntryAccessor",
        source: computeOnly.configSource,
        kind: "compute",
        entryPoints: entryAccessor,
      },
      computeOnly.authenticated
    ),
  "VGPU-C1-PROGRAM-CONFIG"
);
assert.equal(entryGetterRead, false);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "RawInventory",
        source: computeOnly.configSource,
        kind: "compute",
      },
      {
        configSource: computeOnly.configSource,
        entryPoints: computeOnly.authenticated.entryPoints,
      }
    ),
  "VGPU-C1-PROGRAM-INVENTORY"
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "CrossedInventory",
        source: singleRender.configSource,
        kind: "draw",
      },
      multiple.authenticated
    ),
  "VGPU-C1-PROGRAM-INVENTORY",
  { program: "CrossedInventory", kind: "draw" }
);
expectSelectionError(
  () =>
    selectProgramEntries(
      {
        name: "ClonedInventory",
        source: computeOnly.configSource,
        kind: "compute",
      },
      structuredClone(computeOnly.authenticated)
    ),
  "VGPU-C1-PROGRAM-INVENTORY"
);

const frozenProgram = Object.freeze({
  name: "FrozenCompute",
  source: computeOnly.configSource,
  kind: "compute",
  entryPoints: Object.freeze({ compute: "cs_main" }),
});
const firstFrozenSelection = selectProgramEntries(
  frozenProgram,
  computeOnly.authenticated
);
const secondFrozenSelection = selectProgramEntries(
  frozenProgram,
  computeOnly.authenticated
);
assert.deepEqual(firstFrozenSelection, secondFrozenSelection);
assert.equal(
  JSON.stringify(firstFrozenSelection),
  JSON.stringify(secondFrozenSelection)
);
assert(Object.isFrozen(firstFrozenSelection));
assert(Object.isFrozen(firstFrozenSelection.entryPoints));
assert(Object.isFrozen(firstFrozenSelection.entryPoints.compute));
assert(Object.isFrozen(computeOnly.authenticated));
assert(Object.isFrozen(computeOnly.authenticated.capsule));
assert(Object.isFrozen(computeOnly.authenticated.entryPoints));
assert.deepEqual(frozenProgram, {
  name: "FrozenCompute",
  source: "Shaders/compute-only.wgsl",
  kind: "compute",
  entryPoints: { compute: "cs_main" },
});

process.stdout.write(
  `${JSON.stringify({
    gate: "program-selection",
    status: "passed",
    successCases: 12,
    selectionNegativeCases: 20,
    authenticationNegativeCases: 3,
  })}\n`
);
