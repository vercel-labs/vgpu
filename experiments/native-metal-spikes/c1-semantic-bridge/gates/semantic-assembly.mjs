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
import { assertResponseSemantics } from "../../c1-compiler-protocol/lib/protocol.mjs";
import { authenticateSuccessfulInventory } from "../lib/authenticated-inventory.mjs";
import {
  authenticateSuccessfulSemanticExtraction,
  semanticExtractionRequestForFinalizedCapsule,
} from "../lib/authenticated-semantic-extraction.mjs";
import { finalizeProgramCapsule } from "../lib/fullscreen-injection.mjs";
import {
  encodeInventoryRequest,
  INVENTORY_COMPILER,
  INVENTORY_CONTRACT,
  inventoryRequestIdentity,
  originMapSha256,
} from "../lib/protocol.mjs";
import { selectProgramEntries } from "../lib/program-selection.mjs";
import {
  isResolvedDeclarationIndex,
  resolvedResourcePresentationForExtraction,
  resolveVirtualShaderWithDeclarations,
  validateResolvedDeclarationCandidate,
} from "../lib/resolved-declarations.mjs";
import {
  allocateMetalSlotsForAssembly,
  assembleSemanticProgram,
  compilerRequestForAssembledEntry,
  isMetalSlotAllocation,
  isSemanticProgramAssembly,
  semanticLayoutId,
  semanticModuleForAssembly,
  semanticTypeId,
} from "../lib/semantic-assembly.mjs";
import { assertSwiftPresentationForProgramAssembly } from "../lib/swift-presentation.mjs";
import {
  encodeSemanticExtractionRequest,
  SEMANTIC_EXTRACTION_COMPILER,
  SEMANTIC_EXTRACTION_CONTRACT,
  semanticExtractionRequestIdentity,
} from "../lib/semantic-extraction-protocol.mjs";

const spikeDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(spikeDirectory, "fixtures", "semantic-assembly");
const compilerResponseValidator = loadCompilerResponseValidator();
const generatedPath = "Intermediate/semantic-assembly.resolved.wgsl";
const metalTarget = "air64-apple-macos14.0";
const expectedSnapshots = Object.freeze({
  effect: Object.freeze({
    programFingerprint:
      "aa8cb703d9eb09320f37e3ff89856625d662fc1f950f3212fdd7a15facfaff6d",
    resolvedSourceSha256:
      "c65624bf6dff3255ae2da0ec055d8810810185e5cf51284a4bacf625ac192627",
    semanticRequestSha256:
      "510f396dae9be6a86387805178e28376ee5b458ca48e620e430271638cea7fd3",
    nativeResponseSha256:
      "52531cfe25ec126e724adb03e0e44759bfa8da66488a9b28b9b3c112256c3dcb",
  }),
  draw: Object.freeze({
    programFingerprint:
      "8bb06404a2c4f490e5a959b58b4f9abfc4c583caff76c226bc950f745d858810",
    resolvedSourceSha256:
      "78ac180f55f95c1ed894fade30eb14ab0ad3d9a5c8075241addf0c55d39c735f",
    semanticRequestSha256:
      "db2d6d0cfc87ef29ac161bbea0510c22590435149e647c3b8a5d7bbbcab28f2e",
    nativeResponseSha256:
      "2b5a709642f2e0677a54ac9ad153f5d5f764b5b1f9dbc960e470929d311495e9",
  }),
  compute: Object.freeze({
    programFingerprint:
      "21c4ce880f30b107e8540c9c977f9425e628057a365ecd8775ea456ad1824a3b",
    resolvedSourceSha256:
      "fa3de3a17d1ef58d68bd67f66af3aa9a5217043962bd98db5235aa34aa18cef3",
    semanticRequestSha256:
      "83f6298c4b2ce7f0bcfddac99c0455f0208d3d24303332a25712b7476169f664",
    nativeResponseSha256:
      "b5546fbc7111ac9565268c726027113b0d3ee6cea00b67531af636f6a44b4f6e",
  }),
  resource: Object.freeze({
    programFingerprint:
      "49b77712d6d6a5f3a0011fd132149f4aa9a1b6c5a3a991384c6ebaacd8ec7e85",
    resolvedSourceSha256:
      "e60666167ae415d142aaaac8789abb65f4ceb93b213649e551202193fe3b5ba3",
    semanticRequestSha256:
      "87b0038071d35f5cfe3d458d51ff7e786cf59d22fad99f04abebbdaf7583529a",
    nativeResponseSha256:
      "087864dfa7fb592686bb146469935235606d7b433deea804f938049a311124cb",
    translations: Object.freeze({
      vertex: Object.freeze({
        requestSha256:
          "6a7910a70cb21c137284dea08476a4d6d9658a087c36e50978a2af93ff935baf",
        responseSha256:
          "cfec82e2db84a13a8b37509779078e97e39e150a293bb38c8a43cd2bb1836c25",
        mslSha256:
          "09c3bd882d760973cec7c00e124fbce0804186ff174ec2955e4ce7154c223f56",
      }),
      fragment: Object.freeze({
        requestSha256:
          "9be658b82cd0bab6a8cbe05a14d6ed8a8da95b0e8cfbe8a8b84e4ff23cc10e11",
        responseSha256:
          "2c9cea9098c73ec00c14f695219e5b5f7342de28fe06bba239f68b1d15eb9ca0",
        mslSha256:
          "d5f73664b2feb9c9f693622cef7c76699b6f70d41e05f35156c8b47322f1c64b",
      }),
    }),
  }),
});
const options = parseArguments(process.argv.slice(2));
let semanticWorkerLaunches = 0;
let translationWorkerLaunches = 0;

const effect = await makeFixture({
  label: "effect",
  file: "fullscreen-effect.wgsl",
  input: "semantic-assembly-effect-wgsl",
  configSource: "Shaders/fullscreen-effect.wgsl",
  selection: {
    name: "AssemblyEffect",
    source: "Shaders/fullscreen-effect.wgsl",
    kind: "effect",
  },
  expectedInventory: [{ stage: "fragment", wgsl: "shade" }],
  result(finalized) {
    return {
      entryPoints: [
        {
          stage: "vertex",
          wgsl: finalized.selection.entryPoints.vertex.names.wgsl,
          semanticInterface: {
            kind: "vertex",
            inputs: [
              {
                type: { scalar: "u32", width: 1 },
                invariant: false,
                builtin: "vertex_index",
              },
            ],
            outputs: [
              {
                type: { scalar: "f32", width: 2 },
                invariant: false,
                location: 0,
                interpolation: { type: "perspective", sampling: "center" },
              },
              {
                type: { scalar: "f32", width: 4 },
                invariant: false,
                builtin: "position",
              },
            ],
          },
          bindings: [],
          samplingPairs: [],
          overrides: [],
        },
        {
          stage: "fragment",
          wgsl: "shade",
          semanticInterface: {
            kind: "fragment",
            inputs: [
              {
                type: { scalar: "f32", width: 2 },
                invariant: false,
                location: 0,
                interpolation: { type: "perspective", sampling: "center" },
              },
            ],
            outputs: [
              {
                type: { scalar: "f32", width: 4 },
                invariant: false,
                location: 0,
              },
            ],
          },
          bindings: [],
          samplingPairs: [],
          overrides: [],
        },
      ],
      bindings: [],
      overrides: [],
      types: {},
      layouts: {},
    };
  },
});

const compute = await makeFixture({
  label: "compute",
  file: "compute.wgsl",
  input: "semantic-assembly-compute-wgsl",
  configSource: "Shaders/compute.wgsl",
  selection: {
    name: "AssemblyCompute",
    source: "Shaders/compute.wgsl",
    kind: "compute",
  },
  expectedInventory: [{ stage: "compute", wgsl: "step" }],
  result() {
    return {
      entryPoints: [
        {
          stage: "compute",
          wgsl: "step",
          semanticInterface: {
            kind: "compute",
            inputs: [
              {
                type: { scalar: "u32", width: 3 },
                invariant: false,
                builtin: "global_invocation_id",
              },
            ],
            outputs: [],
          },
          bindings: [],
          samplingPairs: [],
          overrides: [],
          workgroupSize: { x: 4, y: 2, z: 1 },
        },
      ],
      bindings: [],
      overrides: [],
      types: {},
      layouts: {},
    };
  },
});

const draw = await makeFixture({
  label: "draw",
  configSource: "Shaders/draw/main.wgsl",
  generatedVirtualPath: "Intermediate/semantic-draw.resolved.wgsl",
  sources: [
    {
      file: "draw/main.wgsl",
      input: "draw-main-wgsl",
      virtualPath: "Shaders/draw/main.wgsl",
    },
    {
      file: "draw/fragment.wgsl",
      input: "draw-fragment-wgsl",
      virtualPath: "Shaders/draw/fragment.wgsl",
    },
  ],
  selection: {
    name: "AssemblyDraw",
    source: "Shaders/draw/main.wgsl",
    kind: "draw",
  },
  expectedInventory: [
    { stage: "vertex", wgsl: "draw_vertex" },
    { stage: "fragment", wgsl: "draw_fragment" },
  ],
  result() {
    return {
      entryPoints: [
        {
          stage: "vertex",
          wgsl: "draw_vertex",
          semanticInterface: {
            kind: "vertex",
            inputs: [
              {
                type: { scalar: "u32", width: 1 },
                invariant: false,
                builtin: "vertex_index",
              },
            ],
            outputs: [
              {
                type: { scalar: "f32", width: 2 },
                invariant: false,
                location: 0,
                interpolation: { type: "perspective", sampling: "center" },
              },
              {
                type: { scalar: "f32", width: 4 },
                invariant: false,
                builtin: "position",
              },
            ],
          },
          bindings: [],
          samplingPairs: [],
          overrides: [],
        },
        {
          stage: "fragment",
          wgsl: "draw_fragment",
          semanticInterface: {
            kind: "fragment",
            inputs: [
              {
                type: { scalar: "f32", width: 2 },
                invariant: false,
                location: 0,
                interpolation: { type: "perspective", sampling: "center" },
              },
            ],
            outputs: [
              {
                type: { scalar: "f32", width: 4 },
                invariant: false,
                location: 0,
              },
            ],
          },
          bindings: [],
          samplingPairs: [],
          overrides: [],
        },
      ],
      bindings: [],
      overrides: [],
      types: {},
      layouts: {},
    };
  },
});

const resource = await makeFixture({
  label: "resource",
  configSource: "Shaders/resource/main.wgsl",
  generatedVirtualPath: "Intermediate/semantic-resource.resolved.wgsl",
  sources: [
    {
      file: "resource/main.wgsl",
      input: "resource-main-wgsl",
      virtualPath: "Shaders/resource/main.wgsl",
    },
    {
      file: "resource/types.wgsl",
      input: "resource-types-wgsl",
      virtualPath: "Shaders/resource/types.wgsl",
    },
  ],
  selection: {
    name: "AssemblyResources",
    source: "Shaders/resource/main.wgsl",
    kind: "draw",
  },
  expectedInventory: [
    { stage: "vertex", wgsl: "resource_vertex" },
    { stage: "fragment", wgsl: "resource_fragment" },
  ],
  result() {
    return JSON.parse(
      readFileSync(join(fixtureDirectory, "resource-result.json"), "utf8")
    );
  },
});

for (const fixture of [effect, draw, compute, resource]) {
  assertAcceptedFixture(fixture);
}
assertNominalFailures(effect, compute);
assertDeclarationFailures(effect);
assertCrossModuleDeclarationFailure(draw);
assertResolverSymbolFailures(resource);
assertRetainedResolverResourceSymbols(resource);
assertResolverResourceJoinFailures(resource);
assertProfileFailures(effect);
assertLinkFailure(effect);
assertFingerprintRules(effect);
assertResourceFingerprintRules(resource);
assertSwiftNameFailures(resource);
assertResourceSlotAllocation(resource);
assertStageLocalSlotAllocation(resource);
assertSlotAllocationFailures(effect, resource);
assertProjectionFailures(effect);

const native = options.worker
  ? {
      status: "passed",
      semanticExtraction: await assertNativeExtractions(options.worker, [
        effect,
        draw,
        compute,
        resource,
      ]),
      resourceTranslation: await assertNativeResourceTranslations(
        options.worker,
        resource,
        options
      ),
    }
  : { status: "skipped", reason: "no Tint worker supplied" };
if (options.requireWorker && native.status !== "passed") {
  fail("a native semantic extraction worker was required");
}

process.stdout.write(
  `${JSON.stringify(
    {
      gate: "semantic-assembly",
      status: options.worker ? "passed" : "static-passed",
      fixtures: [effect, draw, compute, resource].map((fixture) => ({
        label: fixture.label,
        programFingerprint:
          fixture.assembly.semantic.programs[0].fingerprint.sha256,
        resolvedSourceSha256: fixture.request.source.sha256,
        semanticRequestSha256: sha256(fixture.semanticRequestBytes),
        semanticTypes: Object.keys(fixture.assembly.semantic.types).length,
        projectedEntries: fixture.compilerRequests.length,
      })),
      static: {
        assemblies: 4,
        slotAllocations: 4,
        compilerRequests: 7,
        nominalFailures: 5,
        declarationFailures: 5,
        resolverSymbolFailures: 3,
        resolverResourceJoinFailures: 3,
        retainedResolverSnapshotChecks: 2,
        profileFailures: 1,
        linkFailures: 1,
        fingerprintChecks: 5,
        swiftNameFailures: 12,
        slotStageIsolationChecks: 1,
        slotAllocationFailures: 4,
        projectionFailures: 2,
        translatorLaunches: 0,
      },
      native,
    },
    null,
    2
  )}\n`
);

async function makeFixture({
  label,
  file,
  input,
  configSource,
  generatedVirtualPath = generatedPath,
  sources,
  selection,
  expectedInventory,
  result,
}) {
  const authoredSources = sources ?? [
    { file, input, virtualPath: configSource },
  ];
  const resolverInput = {
    entry: configSource,
    generatedVirtualPath,
    sources: authoredSources.map((source) => {
      const text = readFileSync(
        join(fixtureDirectory, "authored", source.file),
        "utf8"
      );
      return {
        id: source.input,
        virtualPath: source.virtualPath,
        text,
        sha256: sha256(text),
      };
    }),
  };
  const { graph, declarations } = await resolveVirtualShaderWithDeclarations(
    resolverInput
  );
  assert(isResolvedDeclarationIndex(declarations));
  const request = inventoryRequest(graph);
  const inventory = authenticateSuccessfulInventory({
    configSource,
    request,
    requestBytes: encodeInventoryRequest(request),
    response: inventorySuccess(request, expectedInventory),
  });
  const plan = selectProgramEntries(selection, inventory);
  const finalized = finalizeProgramCapsule({ inventory, selection: plan });
  const semanticRequest =
    semanticExtractionRequestForFinalizedCapsule(finalized);
  const semanticRequestBytes = encodeSemanticExtractionRequest(semanticRequest);
  const expectedResult = result(finalized);
  const response = semanticSuccess(
    semanticRequestBytes,
    structuredClone(expectedResult)
  );
  const extraction = authenticateSuccessfulSemanticExtraction({
    finalized,
    request: semanticRequest,
    requestBytes: semanticRequestBytes,
    response,
  });
  const presentation = {
    module: { name: "AssemblyFixtures", swiftName: "AssemblyFixtures" },
    program: { swiftName: selection.name },
  };
  const assembly = assembleSemanticProgram({
    presentation,
    finalized,
    extraction,
    declarations,
  });
  const allocation = allocateMetalSlotsForAssembly({ assembly });
  const compilerRequests = Object.keys(
    assembly.semantic.programs[0].entryPoints
  ).map((stage) =>
    compilerRequestForAssembledEntry({
      assembly,
      allocation,
      stage,
      metalEntryPoint: `vgpu_assembly_${label}_${stage}`,
    })
  );
  return {
    label,
    resolverInput,
    graph,
    declarations,
    request,
    inventory,
    plan,
    finalized,
    semanticRequest,
    semanticRequestBytes,
    expectedResult,
    response,
    extraction,
    presentation,
    assembly,
    allocation,
    compilerRequests,
  };
}

function assertAcceptedFixture(fixture) {
  const snapshot = expectedSnapshots[fixture.label];
  assert(snapshot);
  assert(isSemanticProgramAssembly(fixture.assembly));
  assert(isMetalSlotAllocation(fixture.allocation));
  assert(Object.isFrozen(fixture.assembly));
  assert(Object.isFrozen(fixture.assembly.semantic));
  assert(Object.isFrozen(fixture.allocation));
  assert(Object.isFrozen(fixture.allocation.bindings));
  assert.equal(
    semanticModuleForAssembly(fixture.assembly),
    fixture.assembly.semantic
  );
  assert.equal(fixture.assembly.semantic.contractId, "vgpu-native-semantic/v1");
  if (fixture.label === "resource") {
    assert.deepEqual(
      fixture.assembly.semantic.layouts,
      fixture.expectedResult.layouts
    );
  } else {
    assert.deepEqual(fixture.assembly.semantic.layouts, {});
  }
  assert.deepEqual(fixture.assembly.semantic.capabilities, {
    vocabulary: 1,
    languageFeatures: [],
    features: [],
  });
  const program = fixture.assembly.semantic.programs[0];
  assert.equal(program.name, fixture.plan.name);
  assert.equal(fixture.allocation.semanticProgram, program.name);
  assert.equal(fixture.allocation.bindingModel, "vgpu-metal-binding-slots-v1");
  if (fixture.label !== "resource") assert.deepEqual(program.bindings, []);
  assert.deepEqual(program.overrides, []);
  assert.match(program.fingerprint.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(program.fingerprint.sha256, snapshot.programFingerprint);
  assert.equal(fixture.request.source.sha256, snapshot.resolvedSourceSha256);
  assert.equal(
    sha256(fixture.semanticRequestBytes),
    snapshot.semanticRequestSha256
  );
  for (const [id, definition] of Object.entries(
    fixture.assembly.semantic.types
  )) {
    assert.equal(id, semanticTypeId(definition));
  }
  for (const request of fixture.compilerRequests) {
    const extracted = fixture.expectedResult.entryPoints.find(
      (entry) => entry.stage === request.entryPoint.stage
    );
    assert(extracted);
    assert.deepEqual(request.semanticInterface, extracted.semanticInterface);
    assert.deepEqual(request.overrides, []);
    assert.equal(request.source.text, fixture.finalized.capsule.source.text);
    assert.deepEqual(request.originMap, fixture.finalized.capsule.originMap);
  }
  if (fixture.label === "effect") {
    const { vertex, fragment } = program.entryPoints;
    assert.equal(vertex.origin, "injected");
    assert(!Object.hasOwn(vertex, "source"));
    assert(!Object.hasOwn(vertex.names, "authored"));
    assert.equal(fragment.origin, "authored");
    assert.equal(fragment.names.authored, "shade");
    assert.equal(fragment.source.input, "semantic-assembly-effect-wgsl");
    assert.deepEqual(fragment.source.start, { line: 5, column: 1 });
    assert.deepEqual(fragment.source.end, { line: 8, column: 2 });
    assert.equal(Object.keys(fixture.assembly.semantic.types).length, 4);
  } else if (fixture.label === "draw") {
    const { vertex, fragment } = program.entryPoints;
    assert.equal(fixture.finalized.injection, undefined);
    assert.deepEqual(program.sources, ["draw-fragment-wgsl", "draw-main-wgsl"]);
    assert.equal(vertex.origin, "authored");
    assert.deepEqual(vertex.names, {
      authored: "draw_vertex",
      wgsl: "draw_vertex",
    });
    assert.deepEqual(vertex.source, {
      input: "draw-main-wgsl",
      start: { line: 8, column: 1 },
      end: { line: 14, column: 2 },
    });
    assert.equal(fragment.origin, "authored");
    assert.deepEqual(fragment.names, {
      authored: "draw_fragment",
      wgsl: "draw_fragment",
    });
    assert.deepEqual(fragment.source, {
      input: "draw-fragment-wgsl",
      start: { line: 5, column: 1 },
      end: { line: 8, column: 2 },
    });
    assert.match(fixture.graph.resolved.wgsl, /_vgsl_0c4135c9__VertexOutput/u);
    assert.match(fixture.graph.resolved.wgsl, /_vgsl_b2a98c8f__shade/u);
    assert.match(fixture.graph.resolved.wgsl, /fn draw_vertex\(/u);
    assert.match(fixture.graph.resolved.wgsl, /fn draw_fragment\(/u);
    assert.equal(Object.keys(fixture.assembly.semantic.types).length, 4);
  } else if (fixture.label === "compute") {
    const { compute: entry } = program.entryPoints;
    assert.equal(entry.origin, "authored");
    assert.equal(entry.names.authored, "step");
    assert.deepEqual(entry.source, {
      input: "semantic-assembly-compute-wgsl",
      start: { line: 1, column: 1 },
      end: { line: 4, column: 2 },
    });
    assert.deepEqual(entry.workgroupSize, { x: 4, y: 2, z: 1 });
    assert.equal(Object.keys(fixture.assembly.semantic.types).length, 2);
  } else {
    assertResourceAssembly(fixture, program);
  }
  const repeated = assembleSemanticProgram({
    presentation: fixture.presentation,
    finalized: fixture.finalized,
    extraction: fixture.extraction,
    declarations: fixture.declarations,
  });
  assert.deepEqual(repeated, fixture.assembly);
  assert(isSemanticProgramAssembly(repeated));
  const repeatedAllocation = allocateMetalSlotsForAssembly({
    assembly: repeated,
  });
  assert.deepEqual(repeatedAllocation, fixture.allocation);
  assert(isMetalSlotAllocation(repeatedAllocation));
}

function assertResourceAssembly(fixture, program) {
  assert.deepEqual(program.sources, [
    "resource-main-wgsl",
    "resource-types-wgsl",
  ]);
  assert.deepEqual(
    program.bindings.map((binding) => binding.id),
    ["g0b0", "g0b1", "g0b2", "g0b3", "g0b10"]
  );
  assert.deepEqual(
    Object.fromEntries(
      program.bindings.map((binding) => [binding.id, binding.visibility])
    ),
    {
      g0b0: ["vertex", "fragment"],
      g0b1: ["vertex"],
      g0b2: ["fragment"],
      g0b3: ["fragment"],
      g0b10: ["fragment"],
    }
  );
  assert.deepEqual(
    program.bindings.map(({ name, swiftName }) => [name, swiftName]),
    [
      ["frame", "frame"],
      ["vertices", "vertices"],
      ["albedo", "albedo"],
      ["albedo_sampler", "albedo_sampler"],
      ["material", "material"],
    ]
  );
  assert.deepEqual(program.entryPoints.vertex.bindings, ["g0b0", "g0b1"]);
  assert.deepEqual(program.entryPoints.vertex.samplingPairs, []);
  assert.deepEqual(program.entryPoints.fragment.bindings, [
    "g0b0",
    "g0b2",
    "g0b3",
    "g0b10",
  ]);
  assert.deepEqual(program.entryPoints.fragment.samplingPairs, [
    { texture: "g0b2", sampler: "g0b3", mode: "filtering" },
  ]);
  assert.deepEqual(program.entryPoints.vertex.source, {
    input: "resource-main-wgsl",
    start: { line: 9, column: 1 },
    end: { line: 12, column: 2 },
  });
  assert.deepEqual(program.entryPoints.fragment.source, {
    input: "resource-main-wgsl",
    start: { line: 14, column: 1 },
    end: { line: 18, column: 2 },
  });

  assert.equal(Object.keys(fixture.expectedResult.types).length, 7);
  assert.equal(Object.keys(fixture.assembly.semantic.types).length, 8);
  assert.equal(Object.keys(fixture.assembly.semantic.layouts).length, 6);
  const structs = Object.values(fixture.assembly.semantic.types).filter(
    (type) => type.kind === "struct"
  );
  assert.deepEqual(structs.map((type) => type.swiftName).sort(), [
    "Frame",
    "Material",
    "Vertices",
  ]);
  for (const type of structs) {
    assert.match(type.wgslName, /^_vgsl_[a-f0-9]{8}__/u);
    assert.equal(type.wgslName.endsWith(type.swiftName), true);
    for (const member of type.members) {
      assert.equal(member.swiftName, member.name);
    }
  }
  assert.deepEqual(
    program.bindings
      .filter((binding) => binding.kind === "buffer")
      .map((binding) => binding.minimumBindingSize),
    [8, 24, 16]
  );
  assert.deepEqual(
    fixture.declarations.structs.map((type) => type.names.authored).sort(),
    ["Frame", "Material", "Vertices"]
  );
  assert.equal(fixture.declarations.schemaVersion, 2);
  assert.equal(
    fixture.declarations.contractId,
    "vgpu-c1-resolved-declarations/v2"
  );
}

function assertResourceSlotAllocation(fixture) {
  for (const binding of fixture.allocation.bindings) {
    assert(Object.isFrozen(binding));
    assert(Object.isFrozen(binding.slots));
    for (const slot of binding.slots) assert(Object.isFrozen(slot));
  }
  assert.deepEqual(fixture.allocation, {
    bindingModel: "vgpu-metal-binding-slots-v1",
    semanticProgram: "AssemblyResources",
    bindings: [
      {
        semanticBinding: "g0b0",
        slots: [
          directSlot("vertex", "buffer", 0),
          directSlot("fragment", "buffer", 0),
        ],
      },
      {
        semanticBinding: "g0b1",
        slots: [directSlot("vertex", "buffer", 1)],
      },
      {
        semanticBinding: "g0b2",
        slots: [directSlot("fragment", "texture", 0)],
      },
      {
        semanticBinding: "g0b3",
        slots: [directSlot("fragment", "sampler", 0)],
      },
      {
        semanticBinding: "g0b10",
        slots: [directSlot("fragment", "buffer", 1)],
      },
    ],
  });

  const requests = Object.fromEntries(
    fixture.compilerRequests.map((request) => [
      request.entryPoint.stage,
      request,
    ])
  );
  assert.deepEqual(requests.vertex.metal.bindings, [
    compilerBinding(0, 0, "buffer", 0),
    compilerBinding(0, 1, "buffer", 1),
  ]);
  assert.deepEqual(requests.fragment.metal.bindings, [
    compilerBinding(0, 0, "buffer", 0),
    compilerBinding(0, 2, "texture", 0),
    compilerBinding(0, 3, "sampler", 0),
    compilerBinding(0, 10, "buffer", 1),
  ]);
  for (const request of Object.values(requests)) {
    assert.deepEqual(request.metal.internalReservations, [
      {
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
      },
    ]);
    assert.deepEqual(request.metal.storageBufferSizes, {
      model: "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
      immediateDataByteOffset: 4,
    });
  }
}

function assertStageLocalSlotAllocation(fixture) {
  const stageLocal = assembleResourceMutation(fixture, (result) => {
    result.entryPoints
      .find((entry) => entry.stage === "vertex")
      .bindings.push("g0b10");
  });
  const allocation = allocateMetalSlotsForAssembly({ assembly: stageLocal });
  const shared = allocation.bindings.find(
    (binding) => binding.semanticBinding === "g0b10"
  );
  assert.deepEqual(shared.slots, [
    directSlot("vertex", "buffer", 2),
    directSlot("fragment", "buffer", 1),
  ]);
}

function directSlot(stage, resourceClass, index) {
  return {
    stage,
    mode: "direct",
    resourceClass,
    component: resourceClass,
    index,
    count: 1,
  };
}

function compilerBinding(group, binding, resourceClass, index) {
  const { stage: _stage, ...slot } = directSlot(
    "compiler-entry-stage",
    resourceClass,
    index
  );
  return { group, binding, slots: [slot] };
}

function assertNominalFailures(effectFixture, computeFixture) {
  expectCode(
    () => semanticModuleForAssembly(structuredClone(effectFixture.assembly)),
    "VGPU-C1-ASSEMBLY-BRAND"
  );
  expectCode(
    () =>
      assembleSemanticProgram({
        presentation: effectFixture.presentation,
        finalized: effectFixture.finalized,
        extraction: structuredClone(effectFixture.extraction),
        declarations: effectFixture.declarations,
      }),
    "VGPU-C1-ASSEMBLY-EXTRACTION"
  );
  expectCode(
    () =>
      assembleSemanticProgram({
        presentation: effectFixture.presentation,
        finalized: effectFixture.finalized,
        extraction: effectFixture.extraction,
        declarations: structuredClone(effectFixture.declarations),
      }),
    "VGPU-C1-ASSEMBLY-DECLARATIONS"
  );
  expectCode(
    () =>
      assembleSemanticProgram({
        presentation: effectFixture.presentation,
        finalized: effectFixture.finalized,
        extraction: computeFixture.extraction,
        declarations: effectFixture.declarations,
      }),
    "VGPU-C1-ASSEMBLY-EXTRACTION"
  );

  const nonNfcPlan = selectProgramEntries(
    {
      name: "Cafe\u0301",
      source: effectFixture.plan.source,
      kind: "effect",
    },
    effectFixture.inventory
  );
  const nonNfcFinalized = finalizeProgramCapsule({
    inventory: effectFixture.inventory,
    selection: nonNfcPlan,
  });
  const nonNfcRequest =
    semanticExtractionRequestForFinalizedCapsule(nonNfcFinalized);
  const nonNfcBytes = encodeSemanticExtractionRequest(nonNfcRequest);
  const nonNfcExtraction = authenticateSuccessfulSemanticExtraction({
    finalized: nonNfcFinalized,
    request: nonNfcRequest,
    requestBytes: nonNfcBytes,
    response: semanticSuccess(
      nonNfcBytes,
      structuredClone(effectFixture.expectedResult)
    ),
  });
  expectCode(
    () =>
      assembleSemanticProgram({
        presentation: effectFixture.presentation,
        finalized: nonNfcFinalized,
        extraction: nonNfcExtraction,
        declarations: effectFixture.declarations,
      }),
    "VGPU-C1-ASSEMBLY-PRESENTATION"
  );
}

function assertDeclarationFailures(fixture) {
  const missingGraph = structuredClone(fixture.graph);
  missingGraph.resolved.ast.modules[0].entryPointDeclarations = [];
  expectCode(
    () => validateResolvedDeclarationCandidate(missingGraph),
    "VGPU-C1-DECLARATIONS-RESOLVER"
  );

  const duplicateGraph = structuredClone(fixture.graph);
  duplicateGraph.resolved.ast.modules[0].entryPointDeclarations.push(
    structuredClone(
      duplicateGraph.resolved.ast.modules[0].entryPointDeclarations[0]
    )
  );
  expectCode(
    () => validateResolvedDeclarationCandidate(duplicateGraph),
    "VGPU-C1-DECLARATIONS-RESOLVER"
  );

  const outOfBoundsGraph = structuredClone(fixture.graph);
  outOfBoundsGraph.resolved.ast.modules[0].entryPointDeclarations[0].span.end =
    {
      line: 4_000_000,
      column: 1,
    };
  expectCode(
    () => validateResolvedDeclarationCandidate(outOfBoundsGraph),
    "VGPU-C1-DECLARATIONS-SPAN"
  );

  const wrongStageGraph = structuredClone(fixture.graph);
  wrongStageGraph.resolved.ast.modules[0].entryPointDeclarations[0].stage =
    "vertex";
  expectCode(
    () => validateResolvedDeclarationCandidate(wrongStageGraph),
    "VGPU-C1-DECLARATIONS-RESOLVER"
  );

  const originalText = fixture.graph.sources[0].text;
  const originalHash = fixture.graph.sources[0].sha256;
  const originalSpan = structuredClone(
    fixture.graph.resolved.ast.modules[0].entryPointDeclarations[0].span
  );
  fixture.graph.sources[0].text = "post-mint mutation";
  fixture.graph.sources[0].sha256 = "f".repeat(64);
  fixture.graph.resolved.ast.modules[0].entryPointDeclarations[0].span.end = {
    line: 9_000_000,
    column: 1,
  };
  try {
    const repeated = assembleSemanticProgram({
      presentation: fixture.presentation,
      finalized: fixture.finalized,
      extraction: fixture.extraction,
      declarations: fixture.declarations,
    });
    assert.deepEqual(repeated, fixture.assembly);
  } finally {
    fixture.graph.sources[0].text = originalText;
    fixture.graph.sources[0].sha256 = originalHash;
    fixture.graph.resolved.ast.modules[0].entryPointDeclarations[0].span =
      originalSpan;
  }
}

function assertCrossModuleDeclarationFailure(fixture) {
  const crossed = structuredClone(fixture.graph);
  const main = crossed.resolved.ast.modules.find(
    (module) => module.path === "Shaders/draw/main.wgsl"
  );
  const fragment = crossed.resolved.ast.modules.find(
    (module) => module.path === "Shaders/draw/fragment.wgsl"
  );
  assert(main);
  assert(fragment);
  [main.entryPointDeclarations, fragment.entryPointDeclarations] = [
    fragment.entryPointDeclarations,
    main.entryPointDeclarations,
  ];
  expectCode(
    () => validateResolvedDeclarationCandidate(crossed),
    "VGPU-C1-DECLARATIONS-SPAN"
  );
}

function assertResolverSymbolFailures(fixture) {
  const unorderedBindings = structuredClone(fixture.graph);
  unorderedBindings.resolved.reflection.bindings.reverse();
  expectCode(
    () => validateResolvedDeclarationCandidate(unorderedBindings),
    "VGPU-C1-DECLARATIONS-RESOLVER"
  );

  const duplicateStruct = structuredClone(fixture.graph);
  duplicateStruct.resolved.reflection.structs.push(
    structuredClone(duplicateStruct.resolved.reflection.structs[0])
  );
  expectCode(
    () => validateResolvedDeclarationCandidate(duplicateStruct),
    "VGPU-C1-DECLARATIONS-RESOLVER"
  );

  const duplicateMember = structuredClone(fixture.graph);
  duplicateMember.resolved.reflection.structs[0].members.push(
    structuredClone(duplicateMember.resolved.reflection.structs[0].members[0])
  );
  expectCode(
    () => validateResolvedDeclarationCandidate(duplicateMember),
    "VGPU-C1-DECLARATIONS-RESOLVER"
  );
}

function assertRetainedResolverResourceSymbols(fixture) {
  const originalBindings = structuredClone(
    fixture.graph.resolved.reflection.bindings
  );
  const originalStructs = structuredClone(
    fixture.graph.resolved.reflection.structs
  );
  fixture.graph.resolved.reflection.bindings[0].name = "post_mint_binding";
  fixture.graph.resolved.reflection.bindings.reverse();
  fixture.graph.resolved.reflection.structs[0].name = "PostMintStruct";
  fixture.graph.resolved.reflection.structs[0].members[0].name =
    "post_mint_member";
  try {
    const repeated = assembleSemanticProgram({
      presentation: fixture.presentation,
      finalized: fixture.finalized,
      extraction: fixture.extraction,
      declarations: fixture.declarations,
    });
    assert.deepEqual(repeated, fixture.assembly);
  } finally {
    fixture.graph.resolved.reflection.bindings = originalBindings;
    fixture.graph.resolved.reflection.structs = originalStructs;
  }
}

function assertResolverResourceJoinFailures(fixture) {
  const result = structuredClone(fixture.expectedResult);
  result.bindings[0].name = "renamed_frame";
  const extraction = authenticateSuccessfulSemanticExtraction({
    finalized: fixture.finalized,
    request: fixture.semanticRequest,
    requestBytes: fixture.semanticRequestBytes,
    response: semanticSuccess(fixture.semanticRequestBytes, result),
  });
  expectCode(
    () =>
      assembleSemanticProgram({
        presentation: fixture.presentation,
        finalized: fixture.finalized,
        extraction,
        declarations: fixture.declarations,
      }),
    "VGPU-C1-ASSEMBLY-DECLARATIONS"
  );

  const structs = Object.values(fixture.expectedResult.types).filter(
    (type) => type.kind === "struct"
  );
  assert(structs.length > 0);
  for (const mutate of [
    (resourceGraph) => {
      Object.values(resourceGraph.types).find(
        (type) => type.kind === "struct"
      ).wgslName = "renamed_struct";
    },
    (resourceGraph) => {
      Object.values(resourceGraph.types).find(
        (type) => type.kind === "struct"
      ).members[0].name = "renamed_member";
    },
  ]) {
    const resourceGraph = structuredClone(fixture.expectedResult);
    mutate(resourceGraph);
    expectCode(
      () =>
        resolvedResourcePresentationForExtraction(
          fixture.declarations,
          fixture.finalized,
          resourceGraph
        ),
      "VGPU-C1-DECLARATIONS-RESOURCE"
    );
  }
}

function assertProfileFailures(fixture) {
  const inventoryRequestWithDualSource = inventoryRequest(fixture.graph, [
    "dual_source_blending",
  ]);
  const inventory = authenticateSuccessfulInventory({
    configSource: fixture.plan.source,
    request: inventoryRequestWithDualSource,
    requestBytes: encodeInventoryRequest(inventoryRequestWithDualSource),
    response: inventorySuccess(inventoryRequestWithDualSource, [
      { stage: "fragment", wgsl: "shade" },
    ]),
  });
  const plan = selectProgramEntries(
    {
      name: fixture.plan.name,
      source: fixture.plan.source,
      kind: fixture.plan.kind,
    },
    inventory
  );
  const finalized = finalizeProgramCapsule({ inventory, selection: plan });
  const request = semanticExtractionRequestForFinalizedCapsule(finalized);
  const requestBytes = encodeSemanticExtractionRequest(request);
  const result = structuredClone(fixture.expectedResult);
  result.entryPoints.find((entry) => entry.stage === "vertex").wgsl =
    finalized.selection.entryPoints.vertex.names.wgsl;
  const extraction = authenticateSuccessfulSemanticExtraction({
    finalized,
    request,
    requestBytes,
    response: semanticSuccess(requestBytes, result),
  });
  expectCode(
    () =>
      assembleSemanticProgram({
        presentation: fixture.presentation,
        finalized,
        extraction,
        declarations: fixture.declarations,
      }),
    "VGPU-C1-ASSEMBLY-PROFILE"
  );
}

function assertLinkFailure(fixture) {
  const result = structuredClone(fixture.expectedResult);
  result.entryPoints[1].semanticInterface.inputs[0].type.width = 3;
  const extraction = authenticateSuccessfulSemanticExtraction({
    finalized: fixture.finalized,
    request: fixture.semanticRequest,
    requestBytes: fixture.semanticRequestBytes,
    response: semanticSuccess(fixture.semanticRequestBytes, result),
  });
  expectCode(
    () =>
      assembleSemanticProgram({
        presentation: fixture.presentation,
        finalized: fixture.finalized,
        extraction,
        declarations: fixture.declarations,
      }),
    "VGPU-C1-ASSEMBLY-LINK"
  );
}

function assertFingerprintRules(fixture) {
  const baseline = fixture.assembly.semantic.programs[0].fingerprint.sha256;
  const renamed = assembleSemanticProgram({
    presentation: {
      module: { name: "OtherModule", swiftName: "OtherModule" },
      program: { swiftName: "OtherEffect" },
    },
    finalized: fixture.finalized,
    extraction: fixture.extraction,
    declarations: fixture.declarations,
  });
  assert.equal(renamed.semantic.programs[0].fingerprint.sha256, baseline);

  const result = structuredClone(fixture.expectedResult);
  result.entryPoints[0].semanticInterface.outputs.splice(1, 0, {
    type: { scalar: "f32", width: 4 },
    invariant: false,
    location: 2,
    interpolation: { type: "perspective", sampling: "center" },
  });
  const extraction = authenticateSuccessfulSemanticExtraction({
    finalized: fixture.finalized,
    request: fixture.semanticRequest,
    requestBytes: fixture.semanticRequestBytes,
    response: semanticSuccess(fixture.semanticRequestBytes, result),
  });
  const changed = assembleSemanticProgram({
    presentation: fixture.presentation,
    finalized: fixture.finalized,
    extraction,
    declarations: fixture.declarations,
  });
  assert.notEqual(changed.semantic.programs[0].fingerprint.sha256, baseline);
}

function assertResourceFingerprintRules(fixture) {
  const baseline = fixture.assembly.semantic.programs[0].fingerprint.sha256;

  const changedVisibility = assembleResourceMutation(fixture, (result) => {
    result.entryPoints.find((entry) => entry.stage === "vertex").bindings = [
      "g0b1",
    ];
  });
  assert.notEqual(
    changedVisibility.semantic.programs[0].fingerprint.sha256,
    baseline
  );

  const changedSampling = assembleResourceMutation(fixture, (result) => {
    result.entryPoints.find(
      (entry) => entry.stage === "fragment"
    ).samplingPairs = [];
  });
  assert.notEqual(
    changedSampling.semantic.programs[0].fingerprint.sha256,
    baseline
  );

  const changedLayout = assembleResourceMutation(fixture, (result) => {
    const binding = result.bindings.find(
      (candidate) => candidate.id === "g0b0"
    );
    const previousId = binding.layout;
    const layout = structuredClone(result.layouts[previousId]);
    layout.minimumSize = 16;
    layout.size = 16;
    const nextId = semanticLayoutId(layout);
    binding.layout = nextId;
    binding.minimumBindingSize = 16;
    delete result.layouts[previousId];
    result.layouts[nextId] = layout;
    result.layouts = Object.fromEntries(
      Object.entries(result.layouts).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
    );
  });
  assert.notEqual(
    changedLayout.semantic.programs[0].fingerprint.sha256,
    baseline
  );
}

function assertSwiftNameFailures(fixture) {
  for (const presentation of [
    {
      module: fixture.presentation.module,
      program: { swiftName: "class" },
    },
    {
      module: fixture.presentation.module,
      program: { swiftName: "_vgpuGenerated" },
    },
    {
      module: fixture.presentation.module,
      program: { swiftName: "_" },
    },
  ]) {
    expectCode(
      () =>
        assembleSemanticProgram({
          presentation,
          finalized: fixture.finalized,
          extraction: fixture.extraction,
          declarations: fixture.declarations,
        }),
      "VGPU-C1-ASSEMBLY-PRESENTATION"
    );
  }

  expectCode(
    () =>
      assertSwiftPresentationForProgramAssembly(
        {
          module: { swiftName: "NameFixture" },
          program: { name: "NameFixtureProgram", swiftName: "NameProgram" },
          bindings: [
            { id: "g0b0", swiftName: "color" },
            { id: "g0b1", swiftName: "Color" },
          ],
          types: {},
        },
        { failWith: throwCodedError }
      ),
    "VGPU-C1-ASSEMBLY-PRESENTATION"
  );

  for (const swiftName of ["any", "each"]) {
    expectCode(
      () =>
        assertSwiftPresentationForProgramAssembly(
          {
            module: { swiftName: "SwiftSixTypeFixture" },
            program: {
              name: "SwiftSixTypeProgram",
              swiftName: "SwiftSixTypeProgram",
              kind: "effect",
            },
            bindings: [],
            types: {
              fixture_type: { kind: "struct", swiftName, members: [] },
            },
          },
          { failWith: throwCodedError }
        ),
      "VGPU-C1-ASSEMBLY-PRESENTATION"
    );
  }

  for (const { binding, member } of [
    { binding: "await", member: "allowedMember" },
    { binding: "allowedBinding", member: "Type" },
  ]) {
    expectCode(
      () =>
        assertSwiftPresentationForProgramAssembly(
          {
            module: { swiftName: "SwiftSixValueFixture" },
            program: {
              name: "SwiftSixValueProgram",
              swiftName: "SwiftSixValueProgram",
              kind: "effect",
            },
            bindings: [{ id: "g0b0", swiftName: binding }],
            types: {
              fixture_type: {
                kind: "struct",
                swiftName: "SwiftSixValue",
                members: [{ swiftName: member }],
              },
            },
          },
          { failWith: throwCodedError }
        ),
      "VGPU-C1-ASSEMBLY-PRESENTATION"
    );
  }

  for (const { module, program, type } of [
    {
      module: "ImportedNamespaceFixture",
      program: "Swift",
      type: "ImportedNamespaceValue",
    },
    {
      module: "ImportedNamespaceFixture",
      program: "ImportedNamespaceProgram",
      type: "foundation",
    },
    {
      module: "VGPUABI",
      program: "ImportedNamespaceProgram",
      type: "ImportedNamespaceValue",
    },
  ]) {
    expectCode(
      () =>
        assertSwiftPresentationForProgramAssembly(
          {
            module: { swiftName: module },
            program: {
              name: "ImportedNamespaceProgram",
              swiftName: program,
              kind: "effect",
            },
            bindings: [],
            types: {
              fixture_type: { kind: "struct", swiftName: type, members: [] },
            },
          },
          { failWith: throwCodedError }
        ),
      "VGPU-C1-ASSEMBLY-PRESENTATION"
    );
  }

  assert.doesNotThrow(() =>
    assertSwiftPresentationForProgramAssembly(
      {
        module: { swiftName: "GeneratedScopeFixture" },
        program: {
          name: "GeneratedScopeProgram",
          swiftName: "actor",
          kind: "effect",
        },
        bindings: [
          { id: "g0b0", swiftName: "artifact" },
          { id: "g0b1", swiftName: "Swift" },
        ],
        types: {
          fixture_type: {
            kind: "struct",
            swiftName: "AllowedValue",
            members: [{ swiftName: "Bindings" }, { swiftName: "VGPUABI" }],
          },
        },
      },
      { failWith: throwCodedError }
    )
  );

  assert.doesNotThrow(() =>
    assertSwiftPresentationForProgramAssembly(
      {
        module: { swiftName: "DeferredScope" },
        program: {
          name: "DeferredScope",
          swiftName: "DeferredScope",
          kind: "draw",
        },
        bindings: [],
        types: {
          bindings_type: {
            kind: "struct",
            swiftName: "Bindings",
            members: [],
          },
          artifact_type: {
            kind: "struct",
            swiftName: "artifact",
            members: [],
          },
          vertex_type: {
            kind: "struct",
            swiftName: "Vertex",
            members: [],
          },
          duplicate_type: {
            kind: "struct",
            swiftName: "vertex",
            members: [],
          },
        },
      },
      { failWith: throwCodedError }
    )
  );

  expectCode(
    () =>
      assertSwiftPresentationForProgramAssembly(
        {
          module: { swiftName: "MemberScopeFixture" },
          program: {
            name: "MemberScopeProgram",
            swiftName: "MemberScopeProgram",
            kind: "effect",
          },
          bindings: [],
          types: {
            fixture_type: {
              kind: "struct",
              swiftName: "MemberScopeValue",
              members: [{ swiftName: "color" }, { swiftName: "Color" }],
            },
          },
        },
        { failWith: throwCodedError }
      ),
    "VGPU-C1-ASSEMBLY-PRESENTATION"
  );
}

function assembleResourceMutation(fixture, mutate) {
  const result = structuredClone(fixture.expectedResult);
  mutate(result);
  const extraction = authenticateSuccessfulSemanticExtraction({
    finalized: fixture.finalized,
    request: fixture.semanticRequest,
    requestBytes: fixture.semanticRequestBytes,
    response: semanticSuccess(fixture.semanticRequestBytes, result),
  });
  return assembleSemanticProgram({
    presentation: fixture.presentation,
    finalized: fixture.finalized,
    extraction,
    declarations: fixture.declarations,
  });
}

function assertProjectionFailures(fixture) {
  expectCode(
    () =>
      compilerRequestForAssembledEntry({
        assembly: structuredClone(fixture.assembly),
        allocation: fixture.allocation,
        stage: "vertex",
        metalEntryPoint: "vgpu_clone",
      }),
    "VGPU-C1-ASSEMBLY-BRAND"
  );
  expectCode(
    () =>
      compilerRequestForAssembledEntry({
        assembly: fixture.assembly,
        allocation: fixture.allocation,
        stage: "compute",
        metalEntryPoint: "vgpu_wrong_stage",
      }),
    "VGPU-C1-ASSEMBLY-PROJECTION"
  );
}

function assertSlotAllocationFailures(effect, resource) {
  const clonedAllocation = structuredClone(effect.allocation);
  assert.equal(isMetalSlotAllocation(clonedAllocation), false);
  expectCode(
    () =>
      compilerRequestForAssembledEntry({
        assembly: effect.assembly,
        allocation: clonedAllocation,
        stage: "vertex",
        metalEntryPoint: "vgpu_cloned_slots",
      }),
    "VGPU-C1-ASSEMBLY-SLOTS"
  );

  const equivalentAssembly = assembleSemanticProgram({
    presentation: effect.presentation,
    finalized: effect.finalized,
    extraction: effect.extraction,
    declarations: effect.declarations,
  });
  const equivalentAllocation = allocateMetalSlotsForAssembly({
    assembly: equivalentAssembly,
  });
  assert.deepEqual(equivalentAssembly, effect.assembly);
  assert.deepEqual(equivalentAllocation, effect.allocation);
  expectCode(
    () =>
      compilerRequestForAssembledEntry({
        assembly: effect.assembly,
        allocation: equivalentAllocation,
        stage: "vertex",
        metalEntryPoint: "vgpu_crossed_slots",
      }),
    "VGPU-C1-ASSEMBLY-SLOTS"
  );
  expectCode(
    () =>
      compilerRequestForAssembledEntry({
        assembly: effect.assembly,
        stage: "vertex",
        metalEntryPoint: "vgpu_missing_slots",
      }),
    "VGPU-C1-ASSEMBLY-SLOTS"
  );

  const externalTexture = assembleResourceMutation(resource, (result) => {
    const position = result.bindings.findIndex(
      (binding) => binding.id === "g0b2"
    );
    const { id, group, binding, name } = result.bindings[position];
    result.bindings[position] = {
      id,
      group,
      binding,
      name,
      kind: "external-texture",
    };
    result.entryPoints.find(
      (entry) => entry.stage === "fragment"
    ).samplingPairs = [];
  });
  expectCode(
    () => allocateMetalSlotsForAssembly({ assembly: externalTexture }),
    "VGPU-C1-ASSEMBLY-SLOTS"
  );
}

async function assertNativeExtractions(workerPath, fixtures) {
  const observed = [];
  for (const fixture of fixtures) {
    const attempts = await Promise.all([
      invokeSemantic(workerPath, fixture),
      invokeSemantic(workerPath, fixture),
    ]);
    assert.equal(attempts[0].stdout, attempts[1].stdout);
    assert.deepEqual(attempts[0].extraction, attempts[1].extraction);
    assert.deepEqual(
      attempts[0].extraction.result,
      fixture.expectedResult,
      `${fixture.label} native semantic result`
    );
    const assembly = assembleSemanticProgram({
      presentation: fixture.presentation,
      finalized: fixture.finalized,
      extraction: attempts[0].extraction,
      declarations: fixture.declarations,
    });
    assert.deepEqual(assembly, fixture.assembly);
    assert.deepEqual(
      allocateMetalSlotsForAssembly({ assembly }),
      fixture.allocation
    );
    observed.push({
      label: fixture.label,
      deterministicRuns: attempts.length,
      responseSha256: sha256(attempts[0].stdout),
    });
    assert.equal(
      sha256(attempts[0].stdout),
      expectedSnapshots[fixture.label].nativeResponseSha256
    );
  }
  return {
    invocations: semanticWorkerLaunches,
    deterministicFixtures: fixtures.length,
    observed,
  };
}

async function invokeSemantic(workerPath, fixture) {
  semanticWorkerLaunches += 1;
  const worker = startTintWorker({ executable: workerPath });
  try {
    await worker.write(Buffer.from(fixture.semanticRequestBytes, "utf8"));
    worker.end();
  } catch (error) {
    worker.terminate(error);
  }
  const attempt = await worker.result;
  let extraction;
  decodeTintWorkerResponse(attempt, (response) => {
    extraction = authenticateSuccessfulSemanticExtraction({
      finalized: fixture.finalized,
      request: fixture.semanticRequest,
      requestBytes: fixture.semanticRequestBytes,
      response,
    });
    return true;
  });
  assert(extraction);
  return { extraction, stdout: attempt.stdout };
}

async function assertNativeResourceTranslations(workerPath, fixture, settings) {
  const observed = [];
  const translated = [];
  for (const request of fixture.compilerRequests) {
    const attempts = await Promise.all([
      invokeTranslation(workerPath, request),
      invokeTranslation(workerPath, request),
    ]);
    assert.equal(attempts[0].stdout, attempts[1].stdout);
    const responses = attempts.map((attempt) =>
      decodeTintWorkerResponse(attempt, (response) => {
        if (!compilerResponseValidator(response)) {
          fail(
            `compiler response schema: ${JSON.stringify(
              compilerResponseValidator.errors
            )}`
          );
        }
        return true;
      })
    );
    for (const response of responses) {
      assertResponseSemantics(request, response);
      assert.equal(response.ok, true);
      assert.deepEqual(response.result.bindings, request.metal.bindings);
      assert.deepEqual(response.result.internalBindings, []);
      assert.deepEqual(response.result.storageBufferSizeRegions, []);
    }
    assert.deepEqual(responses[0], responses[1]);
    const result = {
      stage: request.entryPoint.stage,
      deterministicRuns: attempts.length,
      requestSha256: sha256(JSON.stringify(request)),
      responseSha256: sha256(attempts[0].stdout),
      mslSha256: sha256(responses[0].result.msl),
    };
    assert.deepEqual(
      {
        requestSha256: result.requestSha256,
        responseSha256: result.responseSha256,
        mslSha256: result.mslSha256,
      },
      expectedSnapshots.resource.translations[request.entryPoint.stage]
    );
    observed.push(result);
    translated.push({ request, response: responses[0] });
  }
  return {
    invocations: translationWorkerLaunches,
    deterministicEntries: fixture.compilerRequests.length,
    observed,
    offlineMetal: compileOfflineResourceTranslations(translated, settings),
  };
}

function invokeTranslation(workerPath, request) {
  translationWorkerLaunches += 1;
  return invokeRawTintPrototype({ executable: workerPath, request });
}

function compileOfflineResourceTranslations(translated, settings) {
  if (process.platform !== "darwin") {
    return skippedOfflineMetal(settings, "host-is-not-macos");
  }
  const missing = ["metal", "metallib"].filter((tool) => !xcrunToolWorks(tool));
  if (missing.length > 0) {
    return skippedOfflineMetal(
      settings,
      `missing-xcrun-tools:${missing.join(",")}`
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), "vgpu-resource-metal-"));
  try {
    const airFiles = translated.map(({ request, response }) => {
      const stage = request.entryPoint.stage;
      const metalSource = join(scratch, `${stage}.metal`);
      const air = join(scratch, `${stage}.air`);
      writeFileSync(metalSource, response.result.msl, "utf8");
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
      assertNonEmptyFile(air, `${stage} AIR`);
      return air;
    });
    const libraryPath = join(scratch, "resource.metallib");
    checkedCommand("offline Metal resource link", "xcrun", [
      "-sdk",
      "macosx",
      "metallib",
      ...airFiles,
      "-o",
      libraryPath,
    ]);
    assertNonEmptyFile(libraryPath, "resource metallib");
    return {
      status: "passed",
      shaders: translated.length,
      target: metalTarget,
      libraryBytes: lstatSync(libraryPath).size,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function skippedOfflineMetal(settings, reason) {
  if (settings.requireOfflineMetal) {
    fail(`offline Metal is required: ${reason}`);
  }
  return { status: "skipped", reason };
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
    const diagnostic = `${attempt.stdout}${attempt.stderr}`.trim();
    fail(
      `${owner} failed with ${
        attempt.signal ? `signal ${attempt.signal}` : `status ${attempt.status}`
      }${diagnostic ? `: ${diagnostic}` : ""}`
    );
  }
  if (attempt.stderr !== "") {
    fail(`${owner} wrote stderr: ${attempt.stderr.trim()}`);
  }
}

function assertNonEmptyFile(path, label) {
  if (
    !existsSync(path) ||
    !lstatSync(path).isFile() ||
    lstatSync(path).size === 0
  ) {
    fail(`offline Metal did not produce a non-empty ${label}`);
  }
}

function loadCompilerResponseValidator() {
  const schema = JSON.parse(
    readFileSync(
      resolve(
        spikeDirectory,
        "../c1-compiler-protocol/contracts/response-v1.schema.json"
      ),
      "utf8"
    )
  );
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

function inventoryRequest(graph, languageFeatures = []) {
  return {
    schemaVersion: 1,
    contractId: INVENTORY_CONTRACT,
    source: {
      virtualPath: graph.originMap.generatedSource.virtualPath,
      sha256: graph.originMap.generatedSource.sha256,
      text: graph.resolved.wgsl,
    },
    originMap: structuredClone(graph.originMap),
    originMapSha256: originMapSha256(graph.originMap),
    languageFeatures: [...languageFeatures],
  };
}

function inventorySuccess(request, entryPoints) {
  const bytes = encodeInventoryRequest(request);
  return {
    schemaVersion: 1,
    contractId: INVENTORY_CONTRACT,
    ok: true,
    requestIdentity: inventoryRequestIdentity(bytes),
    compiler: INVENTORY_COMPILER,
    diagnostics: [],
    result: { entryPoints: structuredClone(entryPoints) },
  };
}

function semanticSuccess(requestBytes, result) {
  return {
    schemaVersion: 1,
    contractId: SEMANTIC_EXTRACTION_CONTRACT,
    ok: true,
    requestIdentity: semanticExtractionRequestIdentity(requestBytes),
    compiler: SEMANTIC_EXTRACTION_COMPILER,
    diagnostics: [],
    result,
  };
}

function parseArguments(argv) {
  const parsed = {
    worker: undefined,
    requireWorker: false,
    requireOfflineMetal: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--help", "-h"].includes(argument)) {
      process.stdout.write(
        "Usage: node gates/semantic-assembly.mjs [--worker <Tint executable>] " +
          "[--require-worker] [--require-offline-metal]\n"
      );
      process.exit(0);
    }
    if (["--require-worker", "--require-offline-metal"].includes(argument)) {
      if (seen.has(argument)) fail(`${argument} may appear only once`);
      seen.add(argument);
      parsed[
        {
          "--require-worker": "requireWorker",
          "--require-offline-metal": "requireOfflineMetal",
        }[argument]
      ] = true;
      continue;
    }
    if (argument === "--worker") {
      if (seen.has(argument)) fail(`${argument} may appear only once`);
      seen.add(argument);
      const worker = argv[++index];
      if (!worker) fail("--worker requires a value");
      parsed.worker = resolve(worker);
      continue;
    }
    fail(`unknown argument ${argument}`);
  }
  if (
    parsed.worker &&
    (!existsSync(parsed.worker) || !lstatSync(parsed.worker).isFile())
  ) {
    fail(`worker is not a regular file: ${parsed.worker}`);
  }
  if (parsed.requireOfflineMetal) parsed.requireWorker = true;
  if (parsed.requireWorker && !parsed.worker) {
    fail("required native gates need --worker");
  }
  return parsed;
}

function expectCode(run, code) {
  let received;
  try {
    run();
  } catch (error) {
    received = error;
  }
  assert(received instanceof Error);
  assert.equal(received.code, code, received.stack);
}

function throwCodedError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(message) {
  throw new Error(`C1 semantic assembly: ${message}`);
}
