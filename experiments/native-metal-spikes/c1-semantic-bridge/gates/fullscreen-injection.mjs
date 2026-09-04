#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  decodeTintWorkerResponse,
  startTintWorker,
} from "../../c1-compiler-protocol/lib/native-compiler.mjs";
import { attachDiagnosticOrigins } from "../../c1-compiler-protocol/lib/protocol.mjs";
import {
  authenticateSuccessfulInventory,
  isAuthenticatedEntryInventory,
} from "../lib/authenticated-inventory.mjs";
import {
  finalizeProgramCapsule,
  FullscreenInjectionError,
  FULLSCREEN_TRIANGLE_NAME_DOMAIN,
  FULLSCREEN_TRIANGLE_TEMPLATE,
  FULLSCREEN_TRIANGLE_TEMPLATE_BYTES,
  FULLSCREEN_TRIANGLE_TEMPLATE_SHA256,
  fullscreenEntryPointForSource,
  inventoryRequestForFinalizedCapsule,
  isFinalizedProgramCapsule,
  renderFullscreenInjection,
} from "../lib/fullscreen-injection.mjs";
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
  selectProgramEntries,
} from "../lib/program-selection.mjs";

const options = parseArguments(process.argv.slice(2));

function parseArguments(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    process.stdout.write(
      "Usage: node gates/fullscreen-injection.mjs [--worker <inventory executable>] [--require-worker]\n"
    );
    process.exit(0);
  }
  const parsed = {
    worker: process.env.C1_SEMANTIC_BRIDGE_FULLSCREEN_WORKER,
    requireWorker:
      process.env.C1_SEMANTIC_BRIDGE_FULLSCREEN_REQUIRE_WORKER === "1",
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-worker") {
      if (seen.has(argument)) fail(`${argument} may appear only once`);
      seen.add(argument);
      parsed.requireWorker = true;
      continue;
    }
    if (argument === "--worker") {
      if (seen.has(argument)) fail(`${argument} may appear only once`);
      seen.add(argument);
      const value = argv[++index];
      if (!value) fail(`${argument} requires a value`);
      parsed.worker = resolve(value);
      continue;
    }
    fail(`unknown argument ${argument}`);
  }
  if (parsed.worker) parsed.worker = resolve(parsed.worker);
  if (parsed.worker && !existsSync(parsed.worker)) {
    fail(`inventory worker does not exist: ${parsed.worker}`);
  }
  if (parsed.requireWorker && !parsed.worker) {
    fail("--require-worker requires --worker or its environment equivalent");
  }
  return parsed;
}

function fail(message) {
  throw new Error(`C1 full-screen injection: ${message}`);
}

function fixture({ label, text, entryPoints, configSource }) {
  const sourceIdentity = configSource ?? `Shaders/${label}.wgsl`;
  const virtualPath = `Intermediate/${label}.resolved.wgsl`;
  const sourceSha256 = sha256Utf8(text);
  const originMap = {
    schemaVersion: 1,
    contractId: "vgpu-native-origin-map/v1",
    generatedSource: { virtualPath, sha256: sourceSha256 },
    sources: [{ input: sourceIdentity, sha256: sourceSha256 }],
    segments: [
      {
        generated: {
          startByte: 0,
          endByte: Buffer.byteLength(text, "utf8"),
        },
        origin: { input: sourceIdentity },
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
  const inventory = authenticateSuccessfulInventory({
    configSource: sourceIdentity,
    request,
    requestBytes,
    response,
  });
  return { configSource: sourceIdentity, request, requestBytes, inventory };
}

function selectEffect(sourceFixture, entryPoints) {
  return selectProgramEntries(
    {
      name: "FullscreenEffect",
      source: sourceFixture.configSource,
      kind: "effect",
      ...(entryPoints === undefined ? {} : { entryPoints }),
    },
    sourceFixture.inventory
  );
}

function expectInjectionError(run, code) {
  let received;
  try {
    run();
  } catch (error) {
    received = error;
  }
  assert(received instanceof FullscreenInjectionError);
  assert.equal(received.code, code);
}

const authoredText =
  "// 😀 Cafe\u0301\n@fragment fn shade(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.0, 1.0); }";
const authored = fixture({
  label: "unicode-effect",
  text: authoredText,
  entryPoints: [{ stage: "fragment", wgsl: "shade" }],
});
const selection = selectEffect(authored);
const first = finalizeProgramCapsule({
  inventory: authored.inventory,
  selection,
});
const second = finalizeProgramCapsule({
  inventory: authored.inventory,
  selection,
});

assert.equal(
  FULLSCREEN_TRIANGLE_NAME_DOMAIN,
  "vgpu-native-fullscreen-triangle-name/v1"
);
assert.equal(FULLSCREEN_TRIANGLE_TEMPLATE_BYTES, 562);
assert.equal(
  FULLSCREEN_TRIANGLE_TEMPLATE_SHA256,
  "1df2bf26698725848906383255e92b9a8a4b76c896db33fb6f2566f8031982f6"
);
assert.equal(Buffer.byteLength(FULLSCREEN_TRIANGLE_TEMPLATE, "ascii"), 562);
assert.equal(
  sha256Utf8(FULLSCREEN_TRIANGLE_TEMPLATE),
  FULLSCREEN_TRIANGLE_TEMPLATE_SHA256
);
assert.equal(
  fullscreenEntryPointForSource("0".repeat(64)),
  "vgpu_fullscreen_vertex_19be0484eb77bd42af2ebdc4c72d6a0a3450a14b8121e31d55f1c967e7d40a69"
);
assert(isFinalizedProgramCapsule(first));
assert(!isFinalizedProgramCapsule(structuredClone(first)));
assert.deepEqual(first, second);
assert.equal(JSON.stringify(first), JSON.stringify(second));
assert.equal(
  authored.request.source.sha256,
  "2badeb062e70466559e64504cf2be1b51dabf9ebbb7b77d5312458fbacc86160"
);
assert.equal(
  first.selection.entryPoints.vertex.names.wgsl,
  "vgpu_fullscreen_vertex_9fb88032be7e3ed4db2dd8a0d2d8ad0eac1292e0ea2839b6d0588a8cf2d56ce1"
);
assert.equal(
  first.capsule.source.sha256,
  "f06854d9bc4c0104b902e7d058eed8149537179dcc479194cbe1862990cf620b"
);
assert.equal(
  first.capsule.originMapSha256,
  "68a293647dcffb74ff64b6622aca714eadbbc759b1494eef74e8f23033f32290"
);
assert.equal(first.injection.profile, FULLSCREEN_TRIANGLE_INJECTION_PROFILE);
assert.deepEqual(first.injection.generated, { startByte: 111, endByte: 903 });
assert.equal(authoredText.length, 108);
assert.equal(Buffer.byteLength(authoredText, "utf8"), 111);
assert(first.capsule.source.text.startsWith(`${authoredText}\n`));
assert(first.capsule.source.text.includes("Cafe\u0301"));
assert(!first.capsule.source.text.includes("Caf\u00e9"));
assert.deepEqual(
  first.capsule.originMap.sources,
  authored.request.originMap.sources
);
assert.deepEqual(
  first.capsule.originMap.segments,
  authored.request.originMap.segments
);
assert.equal(
  first.capsule.originMap.generatedSource.virtualPath,
  authored.request.originMap.generatedSource.virtualPath
);
assert.equal(
  first.capsule.originMap.generatedSource.sha256,
  first.capsule.source.sha256
);
assert(
  first.capsule.originMap.segments.every(
    (segment) =>
      segment.generated.endByte <= first.injection.generated.startByte
  )
);

const finalRequest = inventoryRequestForFinalizedCapsule(first);
assert(Object.isFrozen(finalRequest));
assert(Object.isFrozen(finalRequest.source));
assert(Object.isFrozen(finalRequest.originMap));
assert.equal(finalRequest.source.sha256, sha256Utf8(finalRequest.source.text));
assert.equal(
  finalRequest.originMapSha256,
  originMapSha256(finalRequest.originMap)
);
expectInjectionError(
  () => inventoryRequestForFinalizedCapsule(structuredClone(first)),
  "VGPU-C1-FULLSCREEN-CAPSULE"
);

const generatedHeaderLine = authoredText.split("\n").length + 1;
const generatedDiagnostic = {
  diagnostics: [
    {
      phase: "wgsl",
      location: {
        kind: "generated-wgsl",
        virtualPath: finalRequest.source.virtualPath,
        start: { line: generatedHeaderLine, column: 1 },
        end: { line: generatedHeaderLine, column: 2 },
      },
    },
  ],
};
const enriched = attachDiagnosticOrigins(finalRequest, generatedDiagnostic);
assert.equal(enriched.diagnostics[0].location.origin, undefined);
const overstated = structuredClone(generatedDiagnostic);
overstated.diagnostics[0].location.origin = {
  input: authored.configSource,
  precision: "module",
};
assert.throws(
  () => attachDiagnosticOrigins(finalRequest, overstated),
  (error) => error?.code === "VGPU-C1-PROTOCOL-DIAGNOSTIC-ORIGIN"
);

const withLf = fixture({
  label: "trailing-lf",
  text: "@fragment fn shade() -> @location(0) vec4f { return vec4f(1); }\n",
  entryPoints: [{ stage: "fragment", wgsl: "shade" }],
});
const withLfFinal = finalizeProgramCapsule({
  inventory: withLf.inventory,
  selection: selectEffect(withLf),
});
const withLfStart = withLfFinal.injection.generated.startByte;
assert.equal(
  Buffer.from(withLfFinal.capsule.source.text, "utf8")
    .subarray(withLfStart - 1, withLfStart + 1)
    .toString("utf8"),
  "\n\n"
);

const twoFragments = fixture({
  label: "two-fragments",
  text: [
    "@fragment fn alpha() -> @location(0) vec4f { return vec4f(0); }",
    "@fragment fn zeta() -> @location(0) vec4f { return vec4f(1); }",
  ].join("\n"),
  entryPoints: [
    { stage: "fragment", wgsl: "alpha" },
    { stage: "fragment", wgsl: "zeta" },
  ],
});
const alpha = finalizeProgramCapsule({
  inventory: twoFragments.inventory,
  selection: selectEffect(twoFragments, { fragment: "alpha" }),
});
const zeta = finalizeProgramCapsule({
  inventory: twoFragments.inventory,
  selection: selectEffect(twoFragments, { fragment: "zeta" }),
});
assert.deepEqual(alpha.capsule, zeta.capsule);
assert.equal(
  alpha.selection.entryPoints.vertex.names.wgsl,
  zeta.selection.entryPoints.vertex.names.wgsl
);

const authoredVertex = fixture({
  label: "authored-vertex",
  text: [
    "@vertex fn vertex() -> @builtin(position) vec4f { return vec4f(0); }",
    "@fragment fn shade() -> @location(0) vec4f { return vec4f(1); }",
  ].join("\n"),
  entryPoints: [
    { stage: "vertex", wgsl: "vertex" },
    { stage: "fragment", wgsl: "shade" },
  ],
});
const authoredVertexFinal = finalizeProgramCapsule({
  inventory: authoredVertex.inventory,
  selection: selectEffect(authoredVertex),
});
assert.equal(authoredVertexFinal.injection, undefined);
assert.equal(
  encodeInventoryRequest(
    inventoryRequestForFinalizedCapsule(authoredVertexFinal)
  ),
  authoredVertex.requestBytes
);
assert.deepEqual(authoredVertexFinal.selection.entryPoints.vertex, {
  stage: "vertex",
  origin: "authored",
  names: { wgsl: "vertex" },
});

expectInjectionError(
  () =>
    finalizeProgramCapsule({
      inventory: authored.inventory,
      selection: structuredClone(selection),
    }),
  "VGPU-C1-FULLSCREEN-PLAN"
);
expectInjectionError(
  () =>
    finalizeProgramCapsule({
      inventory: structuredClone(authored.inventory),
      selection,
    }),
  "VGPU-C1-FULLSCREEN-PLAN"
);
const sameRequestDifferentInventory = authenticateSuccessfulInventory({
  configSource: authored.configSource,
  request: authored.request,
  requestBytes: authored.requestBytes,
  response: {
    schemaVersion: 1,
    contractId: INVENTORY_CONTRACT,
    ok: true,
    requestIdentity: inventoryRequestIdentity(authored.requestBytes),
    compiler: INVENTORY_COMPILER,
    diagnostics: [],
    result: {
      entryPoints: [
        { stage: "vertex", wgsl: "other_vertex" },
        { stage: "fragment", wgsl: "shade" },
      ],
    },
  },
});
expectInjectionError(
  () =>
    finalizeProgramCapsule({
      inventory: sameRequestDifferentInventory,
      selection,
    }),
  "VGPU-C1-FULLSCREEN-PLAN"
);
const crossed = fixture({
  label: "unicode-effect-crossed",
  configSource: authored.configSource,
  text: `${authoredText} `,
  entryPoints: [{ stage: "fragment", wgsl: "shade" }],
});
expectInjectionError(
  () =>
    finalizeProgramCapsule({
      inventory: crossed.inventory,
      selection,
    }),
  "VGPU-C1-FULLSCREEN-PLAN"
);
expectInjectionError(
  () =>
    renderFullscreenInjection(
      "vgpu-native-fullscreen-triangle/v2",
      authored.request.source.sha256
    ),
  "VGPU-C1-FULLSCREEN-PROFILE"
);
expectInjectionError(
  () => renderFullscreenInjection(FULLSCREEN_TRIANGLE_INJECTION_PROFILE, "0"),
  "VGPU-C1-FULLSCREEN-CAPSULE"
);

const collisionText =
  "@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }";
const collisionName = fullscreenEntryPointForSource(sha256Utf8(collisionText));
const collision = fixture({
  label: "collision",
  text: collisionText,
  entryPoints: [
    { stage: "fragment", wgsl: "fs_main" },
    { stage: "fragment", wgsl: collisionName },
  ],
});
expectInjectionError(
  () =>
    finalizeProgramCapsule({
      inventory: collision.inventory,
      selection: selectEffect(collision, { fragment: "fs_main" }),
    }),
  "VGPU-C1-FULLSCREEN-ENTRY"
);

const sourceLimitBytes = 16 * 1024 * 1024;
const hugePrefix =
  "@fragment fn shade() -> @location(0) vec4f { return vec4f(1); }\n//";
const hugeRemainderBytes =
  sourceLimitBytes - Buffer.byteLength(hugePrefix, "utf8");
const hugeText = `${hugePrefix}${"😀".repeat(
  Math.floor(hugeRemainderBytes / 4)
)}${" ".repeat(hugeRemainderBytes % 4)}`;
assert.equal(Buffer.byteLength(hugeText, "utf8"), sourceLimitBytes);
const atLimit = fixture({
  label: "source-limit",
  text: hugeText,
  entryPoints: [{ stage: "fragment", wgsl: "shade" }],
});
expectInjectionError(
  () =>
    finalizeProgramCapsule({
      inventory: atLimit.inventory,
      selection: selectEffect(atLimit),
    }),
  "VGPU-C1-FULLSCREEN-RESOURCE-LIMIT"
);

const positions = [
  [-1, -1],
  [3, -1],
  [-1, 3],
];
const twiceSignedArea =
  (positions[1][0] - positions[0][0]) * (positions[2][1] - positions[0][1]) -
  (positions[1][1] - positions[0][1]) * (positions[2][0] - positions[0][0]);
assert.equal(twiceSignedArea, 16);
assert.deepEqual(
  positions.map(([x, y]) => [x * 0.5 + 0.5, y * -0.5 + 0.5]),
  [
    [0, 1],
    [2, 1],
    [0, -1],
  ]
);
const typescriptEffect = readFileSync(
  resolve("packages/vgpu-api/src/effect.ts"),
  "utf8"
);
for (const lockedLine of [
  "var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));",
  "var uv = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));",
]) {
  assert(FULLSCREEN_TRIANGLE_TEMPLATE.includes(lockedLine));
  assert(typescriptEffect.includes(lockedLine));
}

const native = await runNativeGate(options.worker, authored);
if (options.requireWorker && native.status !== "passed") {
  fail("native inventory worker was required but did not pass");
}

process.stdout.write(
  `${JSON.stringify(
    {
      gate: "fullscreen-injection",
      status: native.status === "passed" ? "passed" : "static-passed",
      static: {
        status: "passed",
        positiveCases: 8,
        negativeCases: 10,
        sourceLimitBytes,
      },
      native,
    },
    null,
    2
  )}\n`
);

async function runNativeGate(executable, sourceFixture) {
  if (!executable) {
    return { status: "skipped", reason: "no inventory worker supplied" };
  }
  const authoredRun = await invokeInventory(executable, {
    configSource: sourceFixture.configSource,
    request: sourceFixture.request,
  });
  assert.deepEqual(authoredRun.response.result.entryPoints, [
    { stage: "fragment", wgsl: "shade" },
  ]);
  assert(isAuthenticatedEntryInventory(authoredRun.inventory));

  const nativeSelection = selectProgramEntries(
    {
      name: "NativeFullscreenEffect",
      source: sourceFixture.configSource,
      kind: "effect",
    },
    authoredRun.inventory
  );
  const finalized = finalizeProgramCapsule({
    inventory: authoredRun.inventory,
    selection: nativeSelection,
  });
  const request = inventoryRequestForFinalizedCapsule(finalized);
  const firstRun = await invokeInventory(executable, {
    configSource: sourceFixture.configSource,
    request,
  });
  const secondRun = await invokeInventory(executable, {
    configSource: sourceFixture.configSource,
    request,
  });
  assert.equal(firstRun.stdout, secondRun.stdout);
  assert(isDeepStrictEqual(firstRun.response, secondRun.response));
  assert.deepEqual(firstRun.response.result.entryPoints, [
    {
      stage: "vertex",
      wgsl: finalized.selection.entryPoints.vertex.names.wgsl,
    },
    { stage: "fragment", wgsl: "shade" },
  ]);
  return {
    status: "passed",
    invocations: 3,
    finalInventoryRuns: 2,
    deterministic: true,
    entries: firstRun.response.result.entryPoints,
  };
}

async function invokeInventory(executable, { configSource, request }) {
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
  const response = decodeTintWorkerResponse(attempt, (value) => {
    inventory = authenticateSuccessfulInventory({
      configSource,
      request,
      requestBytes,
      response: value,
    });
    return true;
  });
  assert(inventory);
  return { inventory, requestBytes, response, stdout: attempt.stdout };
}
