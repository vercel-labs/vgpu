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

import {
  decodeTintWorkerResponse,
  invokeRawTintPrototype,
  runCommand,
  startTintWorker,
} from "../../c1-compiler-protocol/lib/native-compiler.mjs";
import {
  authenticateSuccessfulCompilerTranslation,
  compilerRequestForTranslation,
  compilerResponseForTranslation,
  isAuthenticatedCompilerTranslation,
} from "../lib/authenticated-compiler-translation.mjs";
import { authenticateSuccessfulInventory } from "../lib/authenticated-inventory.mjs";
import {
  authenticateSuccessfulSemanticExtraction,
  semanticExtractionRequestForFinalizedCapsule,
} from "../lib/authenticated-semantic-extraction.mjs";
import { finalizeProgramCapsule } from "../lib/fullscreen-injection.mjs";
import { projectMetalDeviceRequirements } from "../lib/metal-device-requirements.mjs";
import {
  assembleMetalProgramProjection,
  isMetalProgramProjection,
  metalSourcesForProgramProjection,
} from "../lib/metal-program-projection.mjs";
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
  resolvedOverridePresentationForExtraction,
  resolvedResourcePresentationForExtraction,
  resolveVirtualShaderWithDeclarations,
  validateResolvedDeclarationCandidate,
} from "../lib/resolved-declarations.mjs";
import {
  isRuntimeResourceLayout,
  runtimeResourceLayoutForMetalProgramProjection,
} from "../lib/runtime-resource-layout.mjs";
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
import { verifyMetalProgramProjection } from "../lib/verify-metal-program-projection.mjs";
import {
  encodeSemanticExtractionRequest,
  SEMANTIC_EXTRACTION_COMPILER,
  SEMANTIC_EXTRACTION_CONTRACT,
  semanticExtractionRequestIdentity,
} from "../lib/semantic-extraction-protocol.mjs";

const spikeDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(spikeDirectory, "fixtures", "semantic-assembly");
const semanticExtractionFixtureDirectory = join(
  spikeDirectory,
  "fixtures",
  "semantic-extraction"
);
const resourceSwiftProbePath = join(
  spikeDirectory,
  "gates",
  "resource-metal.swift"
);
const overrideSwiftProbePath = join(
  spikeDirectory,
  "gates",
  "override-metal.swift"
);
const generatedPath = "Intermediate/semantic-assembly.resolved.wgsl";
const metalTarget = "air64-apple-macos14.0";
const overrideExpectedReadback = Object.freeze([
  159, 96, 32, 96, 223, 96, 32, 96, 159, 159, 32, 96, 223, 159, 32, 96,
]);
const expectedSnapshots = Object.freeze({
  effect: Object.freeze({
    programFingerprint:
      "fc80f8fb8c2b23e5c4527f70dab06512575c2356731cd2a36e818f7991de03b3",
    resolvedSourceSha256:
      "c65624bf6dff3255ae2da0ec055d8810810185e5cf51284a4bacf625ac192627",
    semanticRequestSha256:
      "510f396dae9be6a86387805178e28376ee5b458ca48e620e430271638cea7fd3",
    nativeResponseSha256:
      "52531cfe25ec126e724adb03e0e44759bfa8da66488a9b28b9b3c112256c3dcb",
  }),
  draw: Object.freeze({
    programFingerprint:
      "87dd95f210e6aabc9b2285f3c8a7a50aa7ea0aab554f13ed27c766dbbef29675",
    resolvedSourceSha256:
      "78ac180f55f95c1ed894fade30eb14ab0ad3d9a5c8075241addf0c55d39c735f",
    semanticRequestSha256:
      "db2d6d0cfc87ef29ac161bbea0510c22590435149e647c3b8a5d7bbbcab28f2e",
    nativeResponseSha256:
      "2b5a709642f2e0677a54ac9ad153f5d5f764b5b1f9dbc960e470929d311495e9",
  }),
  compute: Object.freeze({
    programFingerprint:
      "7b8d18cc88d21419ce2db625535fa84694d6b92c452d33ec1a17cb96f05e08d4",
    resolvedSourceSha256:
      "fa3de3a17d1ef58d68bd67f66af3aa9a5217043962bd98db5235aa34aa18cef3",
    semanticRequestSha256:
      "83f6298c4b2ce7f0bcfddac99c0455f0208d3d24303332a25712b7476169f664",
    nativeResponseSha256:
      "b5546fbc7111ac9565268c726027113b0d3ee6cea00b67531af636f6a44b4f6e",
  }),
  resource: Object.freeze({
    programFingerprint:
      "f31f760ab59d019b6be9264c6f000734ddec36c42e74589c1ac96ea999d2fa7a",
    resolvedSourceSha256:
      "e60666167ae415d142aaaac8789abb65f4ceb93b213649e551202193fe3b5ba3",
    semanticRequestSha256:
      "87b0038071d35f5cfe3d458d51ff7e786cf59d22fad99f04abebbdaf7583529a",
    nativeResponseSha256:
      "c9af6cc67387ab6d0336e5902eb8bc589801a0ec8d044ce638ad982a6718f433",
    runtimeLayoutSha256:
      "6bcc46e2f24801df346251b6d6bab34d3de95e3a044b54aae8159a5577826e1d",
    runtimeManifestSha256:
      "c4f09a9c78724bf1ccb4e236c41897c4652f0a99efb4c5894152c33224aa2752",
    runtimeProbeSha256:
      "d6386e348c6d58096b4541240dda625b694207e83857d5b6b75e9c5752f10c15",
    runtimeReadbackSha256:
      "63fc8fde01e08ea5d0018df376c5faed96f2f74bac8cb94af998a9d1bd2331d5",
    translations: Object.freeze({
      vertex: Object.freeze({
        requestSha256:
          "433af9f0fdb675d3cac2456dc4f86111744a4ca011983e87362137143e092976",
        responseSha256:
          "cfec82e2db84a13a8b37509779078e97e39e150a293bb38c8a43cd2bb1836c25",
        mslSha256:
          "09c3bd882d760973cec7c00e124fbce0804186ff174ec2955e4ce7154c223f56",
      }),
      fragment: Object.freeze({
        requestSha256:
          "4a7c265bd657d50fe86530985affad579ea6ddc8f24c0012e2d4e9eec5622231",
        responseSha256:
          "2c9cea9098c73ec00c14f695219e5b5f7342de28fe06bba239f68b1d15eb9ca0",
        mslSha256:
          "d5f73664b2feb9c9f693622cef7c76699b6f70d41e05f35156c8b47322f1c64b",
      }),
    }),
  }),
  runtimeSizedStorage: Object.freeze({
    programFingerprint:
      "637cf1e5bf1c24bc297098038516ab22f53375f5bb6643f55932edccda04eeb5",
    resolvedSourceSha256:
      "5bb23714199201ad811c66e0d5df941fe69fcc33e44db6f63aeba61a192e82e3",
    semanticRequestSha256:
      "dabc80a7fdf36e3ed0f8cb182f8b6d81567eeaac75989b9967ab9a4a1bd4e526",
    nativeResponseSha256:
      "b750ce574d2418d0f2ab6c1d1672c721633ab3f97c4fbcf38f88888e58d1325f",
    metalProjectionSha256:
      "0cbc8ea70617babb93b866ffcf95cb57d655194b657ad0250988352a60d86f47",
    runtimeLayoutSha256:
      "7cdac4742ab4bc881f6b3061edeb64a87a897eb159f6aece0033e1189d2e30da",
    translations: Object.freeze({
      compute: Object.freeze({
        requestSha256:
          "c87ae7e5e375d5cf25ca1aeb78cbb7a947f8a53b52e8a89c7d3514b17a96043b",
        responseSha256:
          "98b6796c1cd01b71e02855bc300c3fd69ee85cd2ad8b66918cd7bb7324b4c621",
        mslSha256:
          "49fc6ee1a7e29b66e968291e516ba5c228766340ed24aadf01ed77963df4d960",
      }),
    }),
  }),
  overrideDependent: Object.freeze({
    programFingerprint:
      "770c84f76e8dbe3bb95c676cb2c231671065eb25964db3dd954a333a8fce0733",
    resolvedSourceSha256:
      "020fc81dad56eee7213b000f91c7eda5924ac38f732568667060b6a718644738",
    semanticRequestSha256:
      "599b8a8b53e0930cf988ed4ab1fa575b1f4a25a07a779c9b93a779932ab02dbd",
    nativeResponseSha256:
      "8daad067a06abbec820ede5d621649aadf2f36f0b82296048c49f0ffd5ae9a6a",
    translations: Object.freeze({
      compute: Object.freeze({
        requestSha256:
          "cbb4ea4d1905cffff4b2ba426298112574a55827d27110f7eea4138526da9700",
        responseSha256:
          "a1c92c74d2c2723ae407fa0f388bcedc13d33dac047e7eb2a357ea1e9d5677c7",
        mslSha256:
          "885bcd67515cac3e55775004ad7693e5a532bdeee5e33ed6dccd2528a6f762e0",
      }),
    }),
  }),
  overrideBypass: Object.freeze({
    programFingerprint:
      "38a849e55c756e4e9819e3ab5dde2a8d3caf8ce7bd6c67237f9b8e49ffd0b93a",
    resolvedSourceSha256:
      "020fc81dad56eee7213b000f91c7eda5924ac38f732568667060b6a718644738",
    semanticRequestSha256:
      "771c575e190592c3e47b1732f360da32e831ac8962271e42e9a1d1c4f136d515",
    nativeResponseSha256:
      "1472b81e3943f5b3035265faf8b1444928558284b9cc65797ea39ffe1dc0338c",
    translations: Object.freeze({
      compute: Object.freeze({
        requestSha256:
          "759e8e490e0c5a24725e20db9666a779fb09f3b51960870b64e6779c85952803",
        responseSha256:
          "838fd22a045f5297ec0adf9534f6a0f318a4789e059b9397eb6bf3fc801f7f29",
        mslSha256:
          "9312a852587f3ea2e9f689a4fdaceaf07d520320033ec376f8193ffc98d30db4",
      }),
    }),
  }),
  overrideEquivalent: Object.freeze({
    programFingerprint:
      "770c84f76e8dbe3bb95c676cb2c231671065eb25964db3dd954a333a8fce0733",
    resolvedSourceSha256:
      "020fc81dad56eee7213b000f91c7eda5924ac38f732568667060b6a718644738",
    semanticRequestSha256:
      "399719a2478833a7a6593f20da1173e711925b1a0fe1e313ba6e25f322a44599",
    nativeResponseSha256:
      "d50076d564c9e43d9862bdf4056b4fa89915f570c71cfc427679a114a3cc2ca3",
    translations: Object.freeze({
      compute: Object.freeze({
        requestSha256:
          "cbb4ea4d1905cffff4b2ba426298112574a55827d27110f7eea4138526da9700",
        responseSha256:
          "a1c92c74d2c2723ae407fa0f388bcedc13d33dac047e7eb2a357ea1e9d5677c7",
        mslSha256:
          "885bcd67515cac3e55775004ad7693e5a532bdeee5e33ed6dccd2528a6f762e0",
      }),
    }),
  }),
  overrideRender: Object.freeze({
    programFingerprint:
      "731070e8b66ed49ae38459490e426f554203aa3dc370fc805de15e733a4ce787",
    resolvedSourceSha256:
      "d82b0e72608fa6b6bb57168f6f9d39c2b0cf1878cd1bd3225c79ac3e8355de2e",
    semanticRequestSha256:
      "c55a6f4dcd3664a19623a535fc4b52183ce04beed97f83d0cdc7e82343576085",
    nativeResponseSha256:
      "13e4184c67d5f7423e5368d6df97b38f8101eb3bf80dd98af086960e7c45aaa8",
    runtimeProbeSha256:
      "766b610391ed1323b3a0bccb3a57424e504cdc9fd7540ff5a99bafadb418c7e9",
    runtimeReadbackSha256:
      "c09bf995ecabe58508a0d9be2130be57de81710ddea084015f2e744e8f40eeee",
    translations: Object.freeze({
      vertex: Object.freeze({
        requestSha256:
          "337fbbc38208089c934d4da043bbd2e66b187ca1b5c8afb139515dee0634c826",
        responseSha256:
          "6babd78c91a93bfe5f8372e0057a2238c29b1e613232f0d9584fb9484e7b808a",
        mslSha256:
          "65a35637827af4ff71de45fae6bdf45a0a06bc28f4664737210534db870b425e",
      }),
      fragment: Object.freeze({
        requestSha256:
          "39f062bbb13040d71755e09a29987f4b68cd754dbda84205818327a4d6d8f1c8",
        responseSha256:
          "ce11f4af789b8fc1ba50af1d267bb8bb3c619c7cd99f2a8ad449a32fb15c2096",
        mslSha256:
          "023faffa96a079ef343e23ddaba3ff4b12535cfb977cd329d2729e381ccf4e29",
      }),
    }),
  }),
  overrideScalars: Object.freeze({
    programFingerprint:
      "a28bea8a966064a535586ca4f05fa12f9ad4d0407fcfc86ee115c9f2f2e98760",
    resolvedSourceSha256:
      "2863be0abcb219b3224330352d2e2a72308fd60900139505ec3c3dfb1a1864ce",
    semanticRequestSha256:
      "7197d5e904f4411fef74baf90269d69529e7e3a9d94043ea5596966533e5f300",
    nativeResponseSha256:
      "7869d02f004a11873099dc0448264658d42cf9b5ba277e02d23f3b77d9ad6b9c",
    translations: Object.freeze({
      compute: Object.freeze({
        requestSha256:
          "42e79501488e6789dc1efce6254f939ea6874a6d5c7fd07b11f09544ca38a948",
        responseSha256:
          "eec952ce28d39bb4d3ccb4dc83a342470caa83fb2be498f038f789a7e4732475",
        mslSha256:
          "967bd264e8acebff6e22697cc5e625c4f9b4691ef33ff69b3b7cb1021fed11cb",
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

const runtimeSizedStorage = await makeFixture({
  label: "runtimeSizedStorage",
  metalLabel: "runtime_sized_storage",
  file: "runtime-sized-storage.wgsl",
  input: "semantic-assembly-runtime-sized-storage-wgsl",
  configSource: "Shaders/runtime-sized-storage.wgsl",
  generatedVirtualPath:
    "Intermediate/semantic-runtime-sized-storage.resolved.wgsl",
  selection: {
    name: "AssemblyRuntimeSizedStorage",
    source: "Shaders/runtime-sized-storage.wgsl",
    kind: "compute",
  },
  expectedInventory: [{ stage: "compute", wgsl: "compute_main" }],
  result() {
    return JSON.parse(
      readFileSync(
        join(fixtureDirectory, "runtime-sized-storage-result.json"),
        "utf8"
      )
    );
  },
});

const overrideDependent = await makeFixture({
  label: "overrideDependent",
  metalLabel: "overrides",
  file: "override/compute.wgsl",
  input: "semantic-assembly-override-compute-wgsl",
  configSource: "Shaders/override/compute.wgsl",
  selection: {
    name: "AssemblyOverrides",
    source: "Shaders/override/compute.wgsl",
    kind: "compute",
  },
  expectedInventory: [{ stage: "compute", wgsl: "needs_required" }],
  overrideConfiguration: [
    { identifier: "17", value: 4 },
    { identifier: "UNUSED", value: 99 },
  ],
  result() {
    return semanticExtractionFixtureResult("override-configured-dependent");
  },
});

const overrideBypass = await makeFixture({
  label: "overrideBypass",
  metalLabel: "overrides",
  file: "override/compute.wgsl",
  input: "semantic-assembly-override-compute-wgsl",
  configSource: "Shaders/override/compute.wgsl",
  selection: {
    name: "AssemblyOverrides",
    source: "Shaders/override/compute.wgsl",
    kind: "compute",
  },
  expectedInventory: [{ stage: "compute", wgsl: "needs_required" }],
  overrideConfiguration: [
    { identifier: "17", value: 4 },
    { identifier: "DEP", value: 9 },
    { identifier: "UNUSED", value: 99 },
  ],
  result() {
    return semanticExtractionFixtureResult("override-configured-bypass");
  },
});

const overrideEquivalent = await makeFixture({
  label: "overrideEquivalent",
  metalLabel: "overrides",
  file: "override/compute.wgsl",
  input: "semantic-assembly-override-compute-wgsl",
  configSource: "Shaders/override/compute.wgsl",
  selection: {
    name: "AssemblyOverrides",
    source: "Shaders/override/compute.wgsl",
    kind: "compute",
  },
  expectedInventory: [{ stage: "compute", wgsl: "needs_required" }],
  overrideConfiguration: [
    { identifier: "17", value: 4 },
    { identifier: "DEP", value: 5 },
    { identifier: "UNUSED", value: 99 },
  ],
  result() {
    return semanticExtractionFixtureResult("override-configured-dependent");
  },
});

const overrideRender = await makeFixture({
  label: "overrideRender",
  file: "override/render.wgsl",
  input: "semantic-assembly-override-render-wgsl",
  configSource: "Shaders/override/render.wgsl",
  selection: {
    name: "AssemblyOverrideRender",
    source: "Shaders/override/render.wgsl",
    kind: "draw",
  },
  expectedInventory: [
    { stage: "vertex", wgsl: "vs_main" },
    { stage: "fragment", wgsl: "fs_main" },
  ],
  overrideConfiguration: [
    { identifier: "FRAGMENT_ONLY", value: 0.125 },
    { identifier: "SHARED", value: 0.375 },
    { identifier: "VERTEX_ONLY", value: 0.625 },
  ],
  result() {
    return JSON.parse(
      readFileSync(
        join(fixtureDirectory, "override-render-live-result.json"),
        "utf8"
      )
    );
  },
});

const overrideScalars = await makeFixture({
  label: "overrideScalars",
  file: "override/all-scalars.wgsl",
  input: "semantic-assembly-override-scalars-wgsl",
  configSource: "Shaders/override/all-scalars.wgsl",
  selection: {
    name: "AssemblyOverrideScalars",
    source: "Shaders/override/all-scalars.wgsl",
    kind: "compute",
  },
  expectedInventory: [{ stage: "compute", wgsl: "all_scalars" }],
  overrideConfiguration: [
    { identifier: "A_BOOL", value: false },
    { identifier: "B_I32", value: -7 },
    { identifier: "C_U32", value: 4 },
    { identifier: "D_F16", value: 0.5 },
    { identifier: "E_F32", value: 2.25 },
  ],
  languageFeatures: ["f16"],
  result() {
    return semanticExtractionFixtureResult("override-all-scalars");
  },
});

const resolverOverrideFixture = await makeResolverOverrideFixture();
const fixtures = [
  effect,
  draw,
  compute,
  resource,
  runtimeSizedStorage,
  overrideDependent,
  overrideBypass,
  overrideEquivalent,
  overrideRender,
  overrideScalars,
];
// Keep the runtime-sized fixture out of synthetic compiler-response assembly.
// Its arrayLength use requires a real Tint response to establish the effective
// immediate-data reservation and storage-buffer-size region.
const projectionFixtures = fixtures.filter(
  (fixture) => fixture !== runtimeSizedStorage
);
const overrideFixtures = [
  overrideDependent,
  overrideBypass,
  overrideEquivalent,
  overrideRender,
  overrideScalars,
];

for (const fixture of fixtures) {
  assertAcceptedFixture(fixture);
}
assert.deepEqual(overrideDependent.assembly, overrideEquivalent.assembly);
assert.deepEqual(overrideDependent.allocation, overrideEquivalent.allocation);
assert.deepEqual(
  overrideDependent.compilerRequests,
  overrideEquivalent.compilerRequests
);
assert.notDeepEqual(
  overrideDependent.compilerRequests,
  overrideBypass.compilerRequests
);
assert.notEqual(
  sha256(overrideDependent.semanticRequestBytes),
  sha256(overrideEquivalent.semanticRequestBytes)
);
assert.notEqual(
  overrideDependent.assembly.semantic.programs[0].fingerprint.sha256,
  overrideBypass.assembly.semantic.programs[0].fingerprint.sha256
);
assertNominalFailures(effect, compute);
assertDeclarationFailures(effect);
assertCrossModuleDeclarationFailure(draw);
assertResolverSymbolFailures(resource);
assertRetainedResolverResourceSymbols(resource);
assertResolverResourceJoinFailures(resource);
const resolverOverrideChecks = assertResolverOverrideSymbols(
  resolverOverrideFixture,
  compute
);
assertProfileFailures(effect);
assertLinkFailure(effect);
assertFingerprintRules(effect);
assertResourceFingerprintRules(resource);
assertSwiftNameFailures(resource);
assertResourceSlotAllocation(resource);
assertStageLocalSlotAllocation(resource);
assertSlotAllocationFailures(effect, resource);
assertProjectionFailures(effect);
const staticMetalPrograms =
  assertStaticCompilerResponseAssembly(projectionFixtures);
const runtimeResourceLayoutChecks = assertRuntimeResourceLayouts(
  staticMetalPrograms.projections
);
const responseAssemblyFailures = assertCompilerResponseAssemblyFailures({
  compute,
  resource,
  staticMetalPrograms,
});
const projectionVerifierCanaries = assertIndependentProjectionVerifier({
  fixture: overrideRender,
  projection: staticMetalPrograms.projections.overrideRender,
  translations: staticMetalPrograms.translations.overrideRender,
});
const deviceRequirementChecks =
  assertMetalDeviceRequirementProjection(resource);
const overrideRuntimeProbeChecks = assertOverrideRuntimeProbeSource();

const native = options.worker
  ? {
      status: "passed",
      semanticExtraction: await assertNativeExtractions(
        options.worker,
        fixtures
      ),
      resourceTranslation: await assertNativeResourceTranslations(
        options.worker,
        resource,
        options,
        staticMetalPrograms.projections.resource
      ),
      runtimeSizedStorageTranslation:
        await assertNativeRuntimeSizedStorageTranslation(
          options.worker,
          runtimeSizedStorage,
          options
        ),
      overrideTranslation: await assertNativeOverrideTranslations(
        options.worker,
        overrideFixtures,
        staticMetalPrograms.projections,
        options
      ),
    }
  : { status: "skipped", reason: "no Tint worker supplied" };
if (options.requireMetalRuntime) {
  for (const [label, status] of [
    ["resource", native.resourceTranslation.metalRuntime.status],
    ["override", native.overrideTranslation.metalRuntime.status],
  ]) {
    if (status !== "passed") {
      fail(`${label} Metal runtime was required but reported ${status}`);
    }
  }
}
if (
  options.worker &&
  [
    native.resourceTranslation.metalRuntime.status,
    native.overrideTranslation.metalRuntime.status,
  ].some((status) => status !== "passed")
) {
  native.status = "runtime-skipped";
}
if (options.requireWorker && !options.worker) {
  fail("a native semantic extraction worker was required");
}

process.stdout.write(
  `${JSON.stringify(
    {
      gate: "semantic-assembly",
      status: options.worker ? native.status : "static-passed",
      fixtures: fixtures.map((fixture) => ({
        label: fixture.label,
        programFingerprint:
          fixture.assembly.semantic.programs[0].fingerprint.sha256,
        resolvedSourceSha256: fixture.request.source.sha256,
        semanticRequestSha256: sha256(fixture.semanticRequestBytes),
        semanticTypes: Object.keys(fixture.assembly.semantic.types).length,
        projectedEntries: fixture.compilerRequests.length,
      })),
      static: {
        assemblies: fixtures.length,
        slotAllocations: fixtures.length,
        compilerRequests: fixtures.reduce(
          (total, fixture) => total + fixture.compilerRequests.length,
          0
        ),
        nominalFailures: 5,
        declarationFailures: 5,
        resolverSymbolFailures: 3,
        resolverResourceJoinFailures: 3,
        resolverOverrideChecks,
        retainedResolverSnapshotChecks: 2,
        overrideConfigurationChecks: 6,
        profileFailures: 1,
        linkFailures: 1,
        fingerprintChecks: 5,
        swiftNameFailures: 14,
        slotStageIsolationChecks: 1,
        slotAllocationFailures: 4,
        projectionFailures: 2,
        compilerTranslations: projectionFixtures.reduce(
          (total, fixture) => total + fixture.compilerRequests.length,
          0
        ),
        deferredCompilerTranslations:
          runtimeSizedStorage.compilerRequests.length,
        metalProgramProjections: projectionFixtures.length,
        projectionPermutationChecks: projectionFixtures.length,
        immediateWithoutRegionChecks: 1,
        responseAssemblyFailures,
        projectionVerifierCanaries,
        overrideRuntimeProbeChecks,
        deviceRequirementChecks,
        runtimeResourceLayoutChecks,
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
  metalLabel = label,
  file,
  input,
  configSource,
  generatedVirtualPath = generatedPath,
  sources,
  selection,
  expectedInventory,
  overrideConfiguration = [],
  languageFeatures = [],
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
  const request = inventoryRequest(graph, languageFeatures);
  const inventory = authenticateSuccessfulInventory({
    configSource,
    request,
    requestBytes: encodeInventoryRequest(request),
    response: inventorySuccess(request, expectedInventory),
  });
  const plan = selectProgramEntries(selection, inventory);
  const finalized = finalizeProgramCapsule({ inventory, selection: plan });
  const semanticRequest = semanticExtractionRequestForFinalizedCapsule(
    finalized,
    { overrideConfiguration }
  );
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
      metalEntryPoint: `vgpu_assembly_${metalLabel}_${stage}`,
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

async function makeResolverOverrideFixture() {
  const text = `@id(17) override REQUIRED: u32;
override DEP: u32 = REQUIRED + 1u;
override UNUSED: u32 = 11u;
override __proto__: u32 = 1u;

@compute @workgroup_size(DEP)
fn needs_required() {}
`;
  const configSource = "Shaders/resolver-overrides.wgsl";
  const { graph, declarations } = await resolveVirtualShaderWithDeclarations({
    entry: configSource,
    generatedVirtualPath: "Intermediate/resolver-overrides.resolved.wgsl",
    sources: [
      {
        id: "resolver-overrides-wgsl",
        virtualPath: configSource,
        text,
        sha256: sha256(text),
      },
    ],
  });
  const request = inventoryRequest(graph);
  const inventory = authenticateSuccessfulInventory({
    configSource,
    request,
    requestBytes: encodeInventoryRequest(request),
    response: inventorySuccess(request, [
      { stage: "compute", wgsl: "needs_required" },
    ]),
  });
  const plan = selectProgramEntries(
    {
      name: "ResolverOverrides",
      source: configSource,
      kind: "compute",
    },
    inventory
  );
  const finalized = finalizeProgramCapsule({ inventory, selection: plan });
  return { graph, declarations, finalized };
}

function semanticExtractionFixtureResult(name) {
  return JSON.parse(
    readFileSync(
      join(semanticExtractionFixtureDirectory, "responses", `${name}.json`),
      "utf8"
    )
  ).result;
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
  assert.deepEqual(
    fixture.assembly.semantic.layouts,
    fixture.expectedResult.layouts
  );
  assert.deepEqual(fixture.assembly.semantic.capabilities, {
    vocabulary: 1,
    languageFeatures: [...fixture.semanticRequest.languageFeatures],
    features: [],
  });
  const program = fixture.assembly.semantic.programs[0];
  assert.equal(program.name, fixture.plan.name);
  assert.equal(fixture.allocation.semanticProgram, program.name);
  assert.equal(fixture.allocation.bindingModel, "vgpu-metal-binding-slots-v1");
  if (fixture.expectedResult.bindings.length === 0) {
    assert.deepEqual(program.bindings, []);
  }
  assert.deepEqual(
    program.overrides,
    fixture.expectedResult.overrides.map(({ name, ...override }) => {
      const symbol = fixture.declarations.overrides.find(
        (candidate) => candidate.names.wgsl === name
      );
      assert(symbol, `missing resolver override ${name}`);
      return {
        names: structuredClone(symbol.names),
        swiftName: symbol.names.authored,
        ...structuredClone(override),
      };
    })
  );
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
    assert.deepEqual(
      request.overrides,
      extracted.overrides.map((name) => {
        const override = fixture.expectedResult.overrides.find(
          (candidate) => candidate.name === name
        );
        assert(override, `missing extracted override ${name}`);
        return { name, value: structuredClone(override.selected) };
      })
    );
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
  } else if (fixture.label === "resource") {
    assertResourceAssembly(fixture, program);
  } else if (fixture.label === "runtimeSizedStorage") {
    assertRuntimeSizedStorageAssembly(fixture, program);
  } else {
    assertOverrideAssembly(fixture, program);
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

function assertRuntimeSizedStorageAssembly(fixture, program) {
  assert.deepEqual(program.sources, [
    "semantic-assembly-runtime-sized-storage-wgsl",
  ]);
  assert.deepEqual(program.entryPoints.compute.bindings, ["g0b0"]);
  assert.deepEqual(program.entryPoints.compute.workgroupSize, {
    x: 1,
    y: 1,
    z: 1,
  });
  assert.deepEqual(program.entryPoints.compute.source, {
    input: "semantic-assembly-runtime-sized-storage-wgsl",
    start: { line: 13, column: 1 },
    end: { line: 15, column: 2 },
  });
  assert.deepEqual(
    program.bindings.map(
      ({ id, addressSpace, access, minimumBindingSize, visibility }) => ({
        id,
        addressSpace,
        access,
        minimumBindingSize,
        visibility,
      })
    ),
    [
      {
        id: "g0b0",
        addressSpace: "storage",
        access: "read",
        minimumBindingSize: 16,
        visibility: ["compute"],
      },
    ]
  );
  assert.deepEqual(
    Object.values(fixture.assembly.semantic.types)
      .filter((type) => type.kind === "struct")
      .map((type) => type.swiftName)
      .sort(),
    ["Particle", "Values"]
  );
  const rootLayout =
    fixture.assembly.semantic.layouts[program.bindings[0].layout];
  assert.equal(rootLayout.runtimeSized, true);
  assert.equal(rootLayout.minimumSize, 4);
  const tail = rootLayout.members[1];
  assert.deepEqual(
    {
      name: tail.name,
      offset: tail.offset,
      minimumSize: tail.minimumSize,
      runtimeSized: tail.runtimeSized,
    },
    {
      name: "particles",
      offset: 4,
      minimumSize: 0,
      runtimeSized: true,
    }
  );
  const tailLayout = fixture.assembly.semantic.layouts[tail.layout];
  assert.equal(tailLayout.arrayStride, 12);
  assert.equal(tailLayout.runtimeSized, true);
  assert.equal(
    fixture.assembly.semantic.layouts[tailLayout.elementLayout].size,
    12
  );
  assert.deepEqual(fixture.allocation.bindings, [
    {
      semanticBinding: "g0b0",
      slots: [directSlot("compute", "buffer", 0)],
    },
  ]);
}

function assertOverrideAssembly(fixture, program) {
  assert(program.overrides.length > 0);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(program.entryPoints).map(([stage, entry]) => [
        stage,
        entry.overrides,
      ])
    ),
    Object.fromEntries(
      fixture.expectedResult.entryPoints.map((entry) => [
        entry.stage,
        entry.overrides,
      ])
    )
  );
  assert.deepEqual(
    program.overrides.map((override) => override.swiftName),
    program.overrides.map((override) => override.names.authored)
  );

  if (
    ["overrideDependent", "overrideBypass", "overrideEquivalent"].includes(
      fixture.label
    )
  ) {
    assert.deepEqual(program.entryPoints.compute.overrides, [
      "DEP",
      "REQUIRED",
    ]);
    assert.equal(
      program.overrides.find((override) => override.names.wgsl === "REQUIRED")
        ?.wgslId,
      17
    );
    assert.deepEqual(
      program.entryPoints.compute.workgroupSize,
      fixture.label === "overrideBypass"
        ? { x: 9, y: 1, z: 1 }
        : { x: 5, y: 1, z: 1 }
    );
  } else if (fixture.label === "overrideRender") {
    assert.deepEqual(program.entryPoints.vertex.overrides, [
      "SHARED",
      "VERTEX_ONLY",
    ]);
    assert.deepEqual(program.entryPoints.fragment.overrides, [
      "FRAGMENT_ONLY",
      "SHARED",
    ]);
    for (const override of program.overrides) {
      assert(override.default);
      assert.notDeepEqual(override.selected, override.default);
    }
  } else {
    assert.equal(fixture.label, "overrideScalars");
    assert.deepEqual(
      program.overrides.map(({ type, selected }) => ({ type, selected })),
      [
        { type: "bool", selected: { type: "bool", value: false } },
        { type: "i32", selected: { type: "i32", value: -7 } },
        { type: "u32", selected: { type: "u32", value: 4 } },
        { type: "f16", selected: { type: "f16", bits: "3800" } },
        { type: "f32", selected: { type: "f32", bits: "40100000" } },
      ]
    );
    assert.deepEqual(program.capabilities.languageFeatures, ["f16"]);
  }
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
  assert.equal(fixture.declarations.schemaVersion, 3);
  assert.equal(
    fixture.declarations.contractId,
    "vgpu-c1-resolved-declarations/v3"
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
    assert.equal(
      request.metal.immediateDataLayoutModel,
      "vgpu-metal-immediate-data-layout-v1"
    );
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
      immediateDataByteOffset: request.entryPoint.stage === "fragment" ? 12 : 4,
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

function assertResolverOverrideSymbols(fixture, unrelatedFixture) {
  assert.deepEqual(fixture.declarations.overrides, [
    {
      names: { authored: "DEP", wgsl: "DEP" },
      initializer: "REQUIRED+1u",
    },
    {
      names: { authored: "REQUIRED", wgsl: "REQUIRED" },
      wgslId: 17,
    },
    {
      names: { authored: "UNUSED", wgsl: "UNUSED" },
      initializer: "11u",
    },
    {
      names: { authored: "__proto__", wgsl: "__proto__" },
      initializer: "1u",
    },
  ]);
  assert(Object.isFrozen(fixture.declarations.overrides));
  for (const override of fixture.declarations.overrides) {
    assert(Object.isFrozen(override));
    assert(Object.isFrozen(override.names));
  }

  const extracted = {
    overrides: [
      { name: "DEP", type: "u32", selected: { type: "u32", value: 5 } },
      {
        name: "REQUIRED",
        wgslId: 17,
        type: "u32",
        selected: { type: "u32", value: 4 },
      },
      {
        name: "__proto__",
        type: "u32",
        selected: { type: "u32", value: 1 },
      },
    ],
  };
  const expectedPresentation = Object.fromEntries([
    ["DEP", { authoredName: "DEP" }],
    ["REQUIRED", { authoredName: "REQUIRED" }],
    ["__proto__", { authoredName: "__proto__" }],
  ]);
  const presentation = resolvedOverridePresentationForExtraction(
    fixture.declarations,
    fixture.finalized,
    extracted
  );
  assert.deepEqual(presentation, expectedPresentation);
  assert(Object.hasOwn(presentation, "__proto__"));
  assert(Object.isFrozen(presentation));

  const originalReflection = structuredClone(
    fixture.graph.resolved.reflection.overrides
  );
  fixture.graph.resolved.reflection.overrides.reverse();
  fixture.graph.resolved.reflection.overrides[0].name = "post_mint_override";
  try {
    assert.deepEqual(
      resolvedOverridePresentationForExtraction(
        fixture.declarations,
        fixture.finalized,
        extracted
      ),
      expectedPresentation
    );
  } finally {
    fixture.graph.resolved.reflection.overrides = originalReflection;
  }

  const resolverMutations = [
    (graph) => {
      delete graph.resolved.reflection.overrides;
    },
    (graph) => {
      graph.resolved.reflection.overrides.push(
        structuredClone(graph.resolved.reflection.overrides[0])
      );
    },
    (graph) => {
      graph.resolved.reflection.overrides[1].mangledName =
        graph.resolved.reflection.overrides[0].mangledName;
    },
    (graph) => {
      graph.resolved.reflection.overrides[1].id = 17;
    },
    (graph) => {
      graph.resolved.reflection.overrides[0].id = 65_536;
    },
    (graph) => {
      graph.resolved.reflection.overrides[1].defaultValue = "";
    },
  ];
  for (const mutate of resolverMutations) {
    const graph = structuredClone(fixture.graph);
    mutate(graph);
    expectCode(
      () => validateResolvedDeclarationCandidate(graph),
      "VGPU-C1-DECLARATIONS-RESOLVER"
    );
  }

  const joinMutations = [
    (overrideGraph) => {
      overrideGraph.overrides[0].name = "MISSING";
    },
    (overrideGraph) => {
      overrideGraph.overrides[1].wgslId = 18;
    },
    (overrideGraph) => {
      delete overrideGraph.overrides[1].wgslId;
    },
    (overrideGraph) => {
      overrideGraph.overrides.reverse();
    },
  ];
  for (const mutate of joinMutations) {
    const overrideGraph = structuredClone(extracted);
    mutate(overrideGraph);
    expectCode(
      () =>
        resolvedOverridePresentationForExtraction(
          fixture.declarations,
          fixture.finalized,
          overrideGraph
        ),
      "VGPU-C1-DECLARATIONS-OVERRIDE"
    );
  }
  expectCode(
    () =>
      resolvedOverridePresentationForExtraction(
        fixture.declarations,
        unrelatedFixture.finalized,
        extracted
      ),
    "VGPU-C1-DECLARATIONS-CAPSULE"
  );

  return 15;
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

  for (const overrides of [
    [{ names: { wgsl: "RESERVED" }, swiftName: "await" }],
    [
      { names: { wgsl: "FIRST" }, swiftName: "value" },
      { names: { wgsl: "SECOND" }, swiftName: "Value" },
    ],
  ]) {
    expectCode(
      () =>
        assertSwiftPresentationForProgramAssembly(
          {
            module: { swiftName: "OverrideNameFixture" },
            program: {
              name: "OverrideNameProgram",
              swiftName: "OverrideNameProgram",
              kind: "compute",
            },
            bindings: [],
            overrides,
            types: {},
          },
          { failWith: throwCodedError }
        ),
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
          overrides: [],
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
            overrides: [],
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
            overrides: [],
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
            overrides: [],
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
        overrides: [],
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
        overrides: [],
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
          overrides: [],
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

function assertStaticCompilerResponseAssembly(fixtures) {
  const projections = {};
  const translationsByFixture = {};

  for (const fixture of fixtures) {
    const rawResponses = fixture.compilerRequests.map((request) =>
      compilerSuccessResponse(fixture, request)
    );
    const translations = fixture.compilerRequests.map((request, index) =>
      authenticateSuccessfulCompilerTranslation({
        request,
        response: rawResponses[index],
      })
    );

    for (const [index, translation] of translations.entries()) {
      const request = fixture.compilerRequests[index];
      const retained = compilerResponseForTranslation(translation);
      assert(isAuthenticatedCompilerTranslation(translation));
      assert.equal(compilerRequestForTranslation(translation), request);
      assert.deepEqual(translation, request.entryPoint);
      assert(Object.isFrozen(translation));
      assert(Object.isFrozen(retained));
      assert(Object.isFrozen(retained.result));
      assert.equal(
        isAuthenticatedCompilerTranslation(structuredClone(translation)),
        false
      );
    }

    if (fixture.label === "resource") {
      const retained = compilerResponseForTranslation(translations[0]);
      const retainedMsl = retained.result.msl;
      rawResponses[0].result.msl = "// caller-owned mutation after auth\n";
      assert.equal(retained.result.msl, retainedMsl);
    }

    const projection = assembleMetalProgramProjection({
      assembly: fixture.assembly,
      allocation: fixture.allocation,
      translations,
    });
    assert(isMetalProgramProjection(projection));
    assert(Object.isFrozen(projection));
    assert.deepEqual(projection, expectedMetalProgramForFixture(fixture));

    const permuted = assembleMetalProgramProjection({
      assembly: fixture.assembly,
      allocation: fixture.allocation,
      translations: [...translations].reverse(),
    });
    assert.deepEqual(permuted, projection);
    assert(isMetalProgramProjection(permuted));

    const sources = metalSourcesForProgramProjection(projection);
    assert(Object.isFrozen(sources));
    assert.deepEqual(
      sources,
      translations.map((translation) => {
        const request = compilerRequestForTranslation(translation);
        return {
          stage: request.entryPoint.stage,
          entryPoint: request.entryPoint.metal,
          msl: compilerResponseForTranslation(translation).result.msl,
        };
      })
    );
    for (const source of sources) assert(Object.isFrozen(source));
    assert.deepEqual(metalSourcesForProgramProjection(permuted), sources);
    expectCode(
      () => metalSourcesForProgramProjection(structuredClone(projection)),
      "VGPU-C1-METAL-PROJECTION-BRAND"
    );

    projections[fixture.label] = projection;
    translationsByFixture[fixture.label] = translations;
  }

  const resourceProjection = projections.resource;
  assert.deepEqual(resourceProjection.internalBindings, []);
  assert.deepEqual(resourceProjection.storageBufferSizeRegions, []);
  assert.deepEqual(resourceProjection.deviceRequirements, {
    features: [],
    limits: [],
    formats: [],
  });
  assert.equal(
    JSON.stringify(resourceProjection).includes('"index":30'),
    false
  );
  assertEffectiveImmediateWithoutRegion(
    fixtures.find((fixture) => fixture.label === "resource")
  );

  return {
    projections: Object.freeze(projections),
    translations: Object.freeze(translationsByFixture),
  };
}

function expectedMetalProgramForFixture(fixture) {
  const program = fixture.assembly.semantic.programs[0];
  return {
    semanticProgram: program.name,
    kind: program.kind,
    entryPoints: fixture.compilerRequests.map((request) => ({
      ...structuredClone(request.entryPoint),
      interface: metalInterfaceForCompilerRequest(request),
    })),
    bindings: structuredClone(fixture.allocation.bindings),
    internalBindings: [],
    storageBufferSizeRegions: [],
    ...(program.kind === "compute"
      ? {
          resolvedWorkgroupSize: structuredClone(
            program.entryPoints.compute.workgroupSize
          ),
        }
      : {}),
    deviceRequirements: { features: [], limits: [], formats: [] },
  };
}

function assertRuntimeResourceLayouts(projections) {
  const layouts = {};
  let checks = 0;
  for (const label of ["effect", "draw", "compute", "resource"]) {
    const projection = projections[label];
    const layout = runtimeResourceLayoutForMetalProgramProjection(projection);
    assert(isRuntimeResourceLayout(layout));
    assertDeepFrozen(layout);
    assert.deepEqual(
      runtimeResourceLayoutForMetalProgramProjection(projection),
      layout
    );
    assert.equal(isRuntimeResourceLayout(structuredClone(layout)), false);
    expectCode(
      () =>
        runtimeResourceLayoutForMetalProgramProjection(
          structuredClone(projection)
        ),
      "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-BRAND"
    );
    layouts[label] = layout;
    checks += 4;
  }

  for (const label of ["effect", "draw", "compute"]) {
    assert.deepEqual(layouts[label], {
      semanticProgram: projections[label].semanticProgram,
      kind: projections[label].kind,
      bindings: [],
      samplingPairs: [],
    });
    checks += 1;
  }

  assert.deepEqual(layouts.resource, {
    semanticProgram: "AssemblyResources",
    kind: "draw",
    bindings: [
      {
        semanticBinding: "g0b0",
        descriptor: {
          kind: "buffer",
          addressSpace: "uniform",
          access: "read",
          minimumBindingSize: 8,
          runtimeSized: false,
        },
        slots: [
          directSlot("vertex", "buffer", 0),
          directSlot("fragment", "buffer", 0),
        ],
      },
      {
        semanticBinding: "g0b1",
        descriptor: {
          kind: "buffer",
          addressSpace: "storage",
          access: "read",
          minimumBindingSize: 24,
          runtimeSized: false,
        },
        slots: [directSlot("vertex", "buffer", 1)],
      },
      {
        semanticBinding: "g0b2",
        descriptor: {
          kind: "texture",
          dimension: "2d",
          sampleType: "float",
          multisampled: false,
        },
        slots: [directSlot("fragment", "texture", 0)],
      },
      {
        semanticBinding: "g0b3",
        descriptor: { kind: "sampler", samplerKind: "filtering" },
        slots: [directSlot("fragment", "sampler", 0)],
      },
      {
        semanticBinding: "g0b10",
        descriptor: {
          kind: "buffer",
          addressSpace: "uniform",
          access: "read",
          minimumBindingSize: 16,
          runtimeSized: false,
        },
        slots: [directSlot("fragment", "buffer", 1)],
      },
    ],
    samplingPairs: [
      {
        stage: "fragment",
        texture: "g0b2",
        sampler: "g0b3",
        mode: "filtering",
      },
    ],
  });
  const serialized = JSON.stringify(layouts.resource);
  assert.equal(serialized.includes('"index":10'), false);
  assert.equal(serialized.includes('"index":30'), false);
  assert.equal(serialized.includes('"msl"'), false);
  assert.equal(serialized.includes('"swiftName"'), false);
  assert.equal(
    sha256(serialized),
    expectedSnapshots.resource.runtimeLayoutSha256
  );
  assert.equal(
    sha256(JSON.stringify(resourceRuntimeManifest(projections.resource))),
    expectedSnapshots.resource.runtimeManifestSha256
  );
  assert.equal(
    sha256(readFileSync(resourceSwiftProbePath, "utf8")),
    expectedSnapshots.resource.runtimeProbeSha256
  );
  checks += 8;
  return checks;
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function assertEffectiveImmediateWithoutRegion(fixture) {
  const translations = fixture.compilerRequests.map((request) => {
    const internalBindings =
      request.entryPoint.stage === "vertex"
        ? structuredClone(request.metal.internalReservations)
        : [];
    return authenticateSuccessfulCompilerTranslation({
      request,
      response: compilerSuccessResponse(fixture, request, {
        internalBindings,
      }),
    });
  });
  const projection = assembleMetalProgramProjection({
    assembly: fixture.assembly,
    allocation: fixture.allocation,
    translations,
  });
  assert.deepEqual(projection.internalBindings, [
    {
      role: "immediate-data",
      slots: [
        {
          stage: "vertex",
          mode: "direct",
          resourceClass: "buffer",
          component: "buffer",
          index: 30,
          count: 1,
        },
      ],
    },
  ]);
  assert.deepEqual(projection.storageBufferSizeRegions, []);
}

function assertCompilerResponseAssemblyFailures({
  compute,
  resource,
  staticMetalPrograms,
}) {
  let checks = 0;
  const expect = (run, code) => {
    expectCode(run, code);
    checks += 1;
  };
  const [vertexRequest, fragmentRequest] = resource.compilerRequests;
  const resourceTranslations = staticMetalPrograms.translations.resource;

  expect(
    () =>
      authenticateSuccessfulCompilerTranslation({
        request: structuredClone(vertexRequest),
        response: compilerSuccessResponse(resource, vertexRequest),
      }),
    "VGPU-C1-TRANSLATION-REQUEST"
  );
  expect(
    () =>
      authenticateSuccessfulCompilerTranslation({
        request: vertexRequest,
        response: { cannotClone() {} },
      }),
    "VGPU-C1-TRANSLATION-SNAPSHOT"
  );
  expect(() => {
    const response = compilerSuccessResponse(resource, vertexRequest);
    response.unexpected = true;
    authenticateSuccessfulCompilerTranslation({
      request: vertexRequest,
      response,
    });
  }, "VGPU-C1-TRANSLATION-SCHEMA");
  expect(
    () =>
      authenticateSuccessfulCompilerTranslation({
        request: vertexRequest,
        response: compilerFailureResponse(),
      }),
    "VGPU-C1-TRANSLATION-NOT-SUCCESS"
  );
  expect(() => {
    const response = compilerSuccessResponse(resource, vertexRequest);
    response.result.msl = "// entry declaration intentionally absent\n";
    authenticateSuccessfulCompilerTranslation({
      request: vertexRequest,
      response,
    });
  }, "VGPU-C1-TRANSLATION-SEMANTICS");
  expect(() => {
    const response = compilerSuccessResponse(resource, vertexRequest);
    response.result.entryPoint.metal = "vgpu_changed_entry";
    authenticateSuccessfulCompilerTranslation({
      request: vertexRequest,
      response,
    });
  }, "VGPU-C1-TRANSLATION-SEMANTICS");
  expect(() => {
    const response = compilerSuccessResponse(resource, vertexRequest);
    response.result.interface.attributes.push({
      semantic: { location: 0 },
      metal: { attribute: 0 },
    });
    authenticateSuccessfulCompilerTranslation({
      request: vertexRequest,
      response,
    });
  }, "VGPU-C1-TRANSLATION-SEMANTICS");
  expect(() => {
    const response = compilerSuccessResponse(resource, vertexRequest);
    response.result.bindings[0].slots[0].index += 1;
    authenticateSuccessfulCompilerTranslation({
      request: vertexRequest,
      response,
    });
  }, "VGPU-C1-TRANSLATION-SEMANTICS");
  expect(() => {
    const response = compilerSuccessResponse(resource, vertexRequest, {
      internalBindings: [
        {
          role: "immediate-data",
          slots: [
            {
              mode: "direct",
              resourceClass: "buffer",
              component: "buffer",
              index: 29,
              count: 1,
            },
          ],
        },
      ],
    });
    authenticateSuccessfulCompilerTranslation({
      request: vertexRequest,
      response,
    });
  }, "VGPU-C1-TRANSLATION-SCHEMA");
  expect(
    () =>
      assembleMetalProgramProjection({
        assembly: resource.assembly,
        allocation: resource.allocation,
        translations: [
          structuredClone(resourceTranslations[0]),
          resourceTranslations[1],
        ],
      }),
    "VGPU-C1-METAL-PROJECTION-TRANSLATION"
  );
  expect(
    () =>
      assembleMetalProgramProjection({
        assembly: structuredClone(resource.assembly),
        allocation: resource.allocation,
        translations: resourceTranslations,
      }),
    "VGPU-C1-METAL-PROJECTION-ASSEMBLY"
  );
  expect(
    () =>
      assembleMetalProgramProjection({
        assembly: resource.assembly,
        allocation: structuredClone(resource.allocation),
        translations: resourceTranslations,
      }),
    "VGPU-C1-METAL-PROJECTION-ALLOCATION"
  );
  expect(
    () =>
      assembleMetalProgramProjection({
        assembly: resource.assembly,
        allocation: resource.allocation,
        translations: [resourceTranslations[0]],
      }),
    "VGPU-C1-METAL-PROJECTION-STAGES"
  );
  expect(
    () =>
      assembleMetalProgramProjection({
        assembly: resource.assembly,
        allocation: resource.allocation,
        translations: [resourceTranslations[0], resourceTranslations[0]],
      }),
    "VGPU-C1-METAL-PROJECTION-STAGES"
  );

  const equivalentAssembly = assembleSemanticProgram({
    presentation: resource.presentation,
    finalized: resource.finalized,
    extraction: resource.extraction,
    declarations: resource.declarations,
  });
  const equivalentAllocation = allocateMetalSlotsForAssembly({
    assembly: equivalentAssembly,
  });
  assert.deepEqual(equivalentAssembly, resource.assembly);
  assert.deepEqual(equivalentAllocation, resource.allocation);
  const crossedRequest = compilerRequestForAssembledEntry({
    assembly: equivalentAssembly,
    allocation: equivalentAllocation,
    stage: "vertex",
    metalEntryPoint: vertexRequest.entryPoint.metal,
  });
  const crossedTranslation = authenticateSuccessfulCompilerTranslation({
    request: crossedRequest,
    response: compilerSuccessResponse(resource, crossedRequest),
  });
  expect(
    () =>
      assembleMetalProgramProjection({
        assembly: resource.assembly,
        allocation: resource.allocation,
        translations: [crossedTranslation, resourceTranslations[1]],
      }),
    "VGPU-C1-METAL-PROJECTION-OWNERSHIP"
  );

  const compilerMismatch = resource.compilerRequests.map((request) =>
    authenticateSuccessfulCompilerTranslation({
      request,
      response: compilerSuccessResponse(resource, request, {
        compiler:
          request.entryPoint.stage === "fragment"
            ? { ...structuredClone(INVENTORY_COMPILER), version: "0.1.1" }
            : INVENTORY_COMPILER,
      }),
    })
  );
  expect(
    () =>
      assembleMetalProgramProjection({
        assembly: resource.assembly,
        allocation: resource.allocation,
        translations: compilerMismatch,
      }),
    "VGPU-C1-METAL-PROJECTION-COMPILER"
  );

  const duplicateNameTranslations = ["vertex", "fragment"].map((stage) => {
    const request = compilerRequestForAssembledEntry({
      assembly: resource.assembly,
      allocation: resource.allocation,
      stage,
      metalEntryPoint: "vgpu_duplicate_program_entry",
    });
    return authenticateSuccessfulCompilerTranslation({
      request,
      response: compilerSuccessResponse(resource, request),
    });
  });
  expect(
    () =>
      assembleMetalProgramProjection({
        assembly: resource.assembly,
        allocation: resource.allocation,
        translations: duplicateNameTranslations,
      }),
    "VGPU-C1-METAL-PROJECTION-METAL-NAME"
  );

  const wrongWorkgroupTranslation = authenticateSuccessfulCompilerTranslation({
    request: compute.compilerRequests[0],
    response: compilerSuccessResponse(compute, compute.compilerRequests[0], {
      resolvedWorkgroupSize: { x: 8, y: 2, z: 1 },
    }),
  });
  expect(
    () =>
      assembleMetalProgramProjection({
        assembly: compute.assembly,
        allocation: compute.allocation,
        translations: [wrongWorkgroupTranslation],
      }),
    "VGPU-C1-METAL-PROJECTION-VERIFY"
  );

  const invalidRegionTranslations = resource.compilerRequests.map((request) =>
    authenticateSuccessfulCompilerTranslation({
      request,
      response: compilerSuccessResponse(resource, request, {
        internalBindings:
          request.entryPoint.stage === "vertex"
            ? request.metal.internalReservations
            : [],
        storageBufferSizeRegions:
          request.entryPoint.stage === "vertex"
            ? [{ stage: "vertex", immediateDataByteOffset: 4 }]
            : [],
      }),
    })
  );
  expect(
    () =>
      assembleMetalProgramProjection({
        assembly: resource.assembly,
        allocation: resource.allocation,
        translations: invalidRegionTranslations,
      }),
    "VGPU-C1-METAL-PROJECTION-VERIFY"
  );

  assert.equal(fragmentRequest.entryPoint.stage, "fragment");
  return checks;
}

function compilerSuccessResponse(fixture, request, options = {}) {
  const program = fixture.assembly.semantic.programs[0];
  const stage = request.entryPoint.stage;
  const result = {
    msl: options.msl ?? minimalMslEntry(request),
    entryPoint: structuredClone(request.entryPoint),
    interface: metalInterfaceForCompilerRequest(request),
    bindings: structuredClone(request.metal.bindings),
    internalBindings: structuredClone(options.internalBindings ?? []),
    storageBufferSizeRegions: structuredClone(
      options.storageBufferSizeRegions ?? []
    ),
    ...(stage === "compute"
      ? {
          resolvedWorkgroupSize: structuredClone(
            options.resolvedWorkgroupSize ??
              program.entryPoints.compute.workgroupSize
          ),
        }
      : {}),
  };
  return {
    schemaVersion: 1,
    contractId: "vgpu-native-tint-compiler/v1",
    ok: true,
    compiler: structuredClone(options.compiler ?? INVENTORY_COMPILER),
    diagnostics: [],
    result,
  };
}

function compilerFailureResponse() {
  return {
    schemaVersion: 1,
    contractId: "vgpu-native-tint-compiler/v1",
    ok: false,
    compiler: structuredClone(INVENTORY_COMPILER),
    diagnostics: [
      {
        code: "VGPU-C1-EXPECTED-FAILURE",
        severity: "error",
        phase: "protocol",
        message: "expected static failure",
      },
    ],
  };
}

function metalInterfaceForCompilerRequest(request) {
  if (request.semanticInterface.kind === "vertex") {
    return {
      kind: "vertex",
      attributes: request.semanticInterface.inputs
        .filter((value) => Object.hasOwn(value, "location"))
        .map((value) => ({
          semantic: { location: value.location },
          metal: { attribute: value.location },
        })),
    };
  }
  if (request.semanticInterface.kind === "fragment") {
    return {
      kind: "fragment",
      colorOutputs: request.semanticInterface.outputs
        .filter((value) => Object.hasOwn(value, "location"))
        .map((value) => ({
          semantic: {
            location: value.location,
            ...(Object.hasOwn(value, "blendSource")
              ? { blendSource: value.blendSource }
              : {}),
          },
          metal: {
            color: value.location,
            ...(Object.hasOwn(value, "blendSource")
              ? { index: value.blendSource }
              : {}),
          },
        })),
    };
  }
  return { kind: "compute" };
}

function minimalMslEntry(request) {
  const { metal, stage } = request.entryPoint;
  if (stage === "compute") return `kernel void ${metal}() {}`;
  return `${stage} float4 ${metal}() { return float4(0.0); }`;
}

function assertIndependentProjectionVerifier(overrideEvidence) {
  const baseline = runtimeSizedProjectionVerifierFixture();
  assert.equal(verifyMetalProgramProjection(baseline), true);
  let checks = 1;
  const reject = (mutate) => {
    const candidate = structuredClone(baseline);
    mutate(candidate);
    expectCode(
      () => verifyMetalProgramProjection(candidate),
      "VGPU-C1-METAL-PROJECTION-VERIFY"
    );
    checks += 1;
  };

  reject((candidate) => {
    candidate.translations[0].response.result.internalBindings[0].slots[0].index = 29;
    candidate.projection.internalBindings[0].slots[0].index = 29;
  });
  reject((candidate) => {
    candidate.allocation.bindings[0].slots[0].index = 30;
    candidate.translations[0].request.metal.bindings[0].slots[0].index = 30;
    candidate.translations[0].response.result.bindings[0].slots[0].index = 30;
    candidate.projection.bindings[0].slots[0].index = 30;
  });
  reject((candidate) => {
    const extra = structuredClone(candidate.translations[0]);
    extra.request.entryPoint = {
      stage: "vertex",
      wgsl: "extra_vertex",
      metal: "vgpu_extra_vertex",
    };
    extra.response.result.entryPoint = structuredClone(
      extra.request.entryPoint
    );
    candidate.translations.push(extra);
  });
  reject((candidate) => {
    candidate.projection.deviceRequirements.features = ["simd-group/v1"];
  });
  reject((candidate) => {
    candidate.semanticLayouts.l_runtime.runtimeSized = false;
  });
  reject((candidate) => {
    candidate.translations[0].request.metal.immediateDataLayoutModel =
      "vgpu-metal-immediate-data-layout-v2";
  });
  reject((candidate) => {
    candidate.translations[0].request.metal.storageBufferSizes.immediateDataByteOffset = 12;
  });

  const overrideBaseline = {
    semanticProgram: structuredClone(
      overrideEvidence.fixture.assembly.semantic.programs[0]
    ),
    semanticLayouts: structuredClone(
      overrideEvidence.fixture.assembly.semantic.layouts
    ),
    allocation: structuredClone(overrideEvidence.fixture.allocation),
    translations: overrideEvidence.fixture.compilerRequests.map(
      (request, index) => ({
        request: structuredClone(request),
        response: structuredClone(
          compilerResponseForTranslation(overrideEvidence.translations[index])
        ),
      })
    ),
    projection: structuredClone(overrideEvidence.projection),
  };
  assert.equal(verifyMetalProgramProjection(overrideBaseline), true);
  checks += 1;
  const rejectOverride = (mutate) => {
    const candidate = structuredClone(overrideBaseline);
    mutate(candidate);
    expectCode(
      () => verifyMetalProgramProjection(candidate),
      "VGPU-C1-METAL-PROJECTION-VERIFY"
    );
    checks += 1;
  };
  rejectOverride((candidate) => {
    candidate.semanticProgram.entryPoints.vertex.overrides = ["SHARED"];
  });
  rejectOverride((candidate) => {
    candidate.semanticProgram.entryPoints.vertex.overrides = [
      "FRAGMENT_ONLY",
      "SHARED",
      "VERTEX_ONLY",
    ];
    candidate.semanticProgram.entryPoints.fragment.overrides = ["SHARED"];
  });
  rejectOverride((candidate) => {
    candidate.translations[0].request.overrides = structuredClone(
      candidate.translations[1].request.overrides
    );
  });
  rejectOverride((candidate) => {
    candidate.translations[0].request.overrides[0].value.bits = "3e800000";
  });
  rejectOverride((candidate) => {
    candidate.semanticProgram.overrides.find(
      (override) => override.names.wgsl === "SHARED"
    ).selected.bits = "3e800000";
  });
  return checks;
}

function runtimeSizedProjectionVerifierFixture() {
  const compilerSlot = {
    mode: "direct",
    resourceClass: "buffer",
    component: "buffer",
    index: 0,
    count: 1,
  };
  const immediateSlot = {
    mode: "direct",
    resourceClass: "buffer",
    component: "buffer",
    index: 30,
    count: 1,
  };
  const entryPoint = {
    stage: "compute",
    wgsl: "runtime_sized_compute",
    metal: "vgpu_runtime_sized_compute",
  };
  const requestBindings = [
    { group: 0, binding: 0, slots: [structuredClone(compilerSlot)] },
  ];
  const request = {
    entryPoint: structuredClone(entryPoint),
    semanticInterface: { kind: "compute", inputs: [], outputs: [] },
    overrides: [],
    metal: {
      bindingModel: "vgpu-metal-binding-slots-v1",
      immediateDataLayoutModel: "vgpu-metal-immediate-data-layout-v1",
      bindings: structuredClone(requestBindings),
      internalReservations: [
        { role: "immediate-data", slots: [structuredClone(immediateSlot)] },
      ],
      storageBufferSizes: {
        model: "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
        immediateDataByteOffset: 4,
      },
    },
  };
  const response = {
    ok: true,
    compiler: structuredClone(INVENTORY_COMPILER),
    result: {
      msl: "kernel void vgpu_runtime_sized_compute() {}",
      entryPoint: structuredClone(entryPoint),
      interface: { kind: "compute" },
      bindings: structuredClone(requestBindings),
      internalBindings: [
        { role: "immediate-data", slots: [structuredClone(immediateSlot)] },
      ],
      storageBufferSizeRegions: [
        { stage: "compute", immediateDataByteOffset: 4 },
      ],
      resolvedWorkgroupSize: { x: 1, y: 1, z: 1 },
    },
  };
  return {
    semanticProgram: {
      name: "RuntimeSizedVerifierCanary",
      kind: "compute",
      entryPoints: {
        compute: {
          stage: "compute",
          names: { wgsl: entryPoint.wgsl },
          inputs: [],
          outputs: [],
          bindings: ["g0b0"],
          overrides: [],
          workgroupSize: { x: 1, y: 1, z: 1 },
        },
      },
      bindings: [
        {
          id: "g0b0",
          group: 0,
          binding: 0,
          kind: "buffer",
          addressSpace: "storage",
          layout: "l_runtime",
        },
      ],
      overrides: [],
      capabilities: { features: [] },
    },
    semanticLayouts: {
      l_runtime: { runtimeSized: true },
    },
    allocation: {
      bindingModel: "vgpu-metal-binding-slots-v1",
      semanticProgram: "RuntimeSizedVerifierCanary",
      bindings: [
        {
          semanticBinding: "g0b0",
          slots: [{ stage: "compute", ...structuredClone(compilerSlot) }],
        },
      ],
    },
    translations: [{ request, response }],
    projection: {
      semanticProgram: "RuntimeSizedVerifierCanary",
      kind: "compute",
      entryPoints: [
        { ...structuredClone(entryPoint), interface: { kind: "compute" } },
      ],
      bindings: [
        {
          semanticBinding: "g0b0",
          slots: [{ stage: "compute", ...structuredClone(compilerSlot) }],
        },
      ],
      internalBindings: [
        {
          role: "immediate-data",
          slots: [{ stage: "compute", ...structuredClone(immediateSlot) }],
        },
      ],
      storageBufferSizeRegions: [
        { stage: "compute", immediateDataByteOffset: 4 },
      ],
      resolvedWorkgroupSize: { x: 1, y: 1, z: 1 },
      deviceRequirements: { features: [], limits: [], formats: [] },
    },
  };
}

function assertMetalDeviceRequirementProjection(fixture) {
  const program = fixture.assembly.semantic.programs[0];
  const requirements = projectMetalDeviceRequirements(program);
  assert.deepEqual(requirements, { features: [], limits: [], formats: [] });
  assert(Object.isFrozen(requirements));
  assert(Object.isFrozen(requirements.features));
  let checks = 1;
  const reject = (mutate) => {
    const candidate = structuredClone(program);
    mutate(candidate);
    expectCode(
      () => projectMetalDeviceRequirements(candidate),
      "VGPU-C1-METAL-REQUIREMENTS"
    );
    checks += 1;
  };
  reject((candidate) => {
    candidate.capabilities.features = ["unsupported/v1"];
  });
  reject((candidate) => {
    candidate.bindings.find((binding) => binding.kind === "texture").kind =
      "storage-texture";
  });
  reject((candidate) => {
    candidate.bindings.find((binding) => binding.kind === "sampler").kind =
      "external-texture";
  });
  return checks;
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

async function assertNativeOverrideTranslations(
  workerPath,
  fixtures,
  expectedProjections,
  settings
) {
  const initialLaunches = translationWorkerLaunches;
  const observed = [];
  const metalPrograms = [];
  const evidenceByLabel = new Map();

  for (const fixture of fixtures) {
    const translations = [];
    const responses = [];
    for (const request of fixture.compilerRequests) {
      const attempts = await Promise.all([
        invokeTranslation(workerPath, request),
        invokeTranslation(workerPath, request),
      ]);
      assert.equal(attempts[0].stdout, attempts[1].stdout);
      const authenticated = attempts.map((attempt) => {
        let translation;
        decodeTintWorkerResponse(attempt, (response) => {
          translation = authenticateSuccessfulCompilerTranslation({
            request,
            response,
          });
          return true;
        });
        assert(translation);
        return translation;
      });
      const retained = authenticated.map(compilerResponseForTranslation);
      assert.deepEqual(retained[0], retained[1]);
      assert.doesNotMatch(retained[0].result.msl, /function_constant/iu);
      if (request.entryPoint.stage === "compute") {
        assert.deepEqual(
          retained[0].result.resolvedWorkgroupSize,
          fixture.assembly.semantic.programs[0].entryPoints.compute
            .workgroupSize
        );
      }
      const observation = {
        label: fixture.label,
        stage: request.entryPoint.stage,
        deterministicRuns: attempts.length,
        requestSha256: sha256(JSON.stringify(request)),
        responseSha256: sha256(attempts[0].stdout),
        mslSha256: sha256(retained[0].result.msl),
      };
      assert.deepEqual(
        {
          requestSha256: observation.requestSha256,
          responseSha256: observation.responseSha256,
          mslSha256: observation.mslSha256,
        },
        expectedSnapshots[fixture.label].translations[request.entryPoint.stage]
      );
      observed.push(observation);
      translations.push(authenticated[0]);
      responses.push(retained[0]);
    }

    const projection = assembleMetalProgramProjection({
      assembly: fixture.assembly,
      allocation: fixture.allocation,
      translations,
    });
    assert.deepEqual(projection, expectedProjections[fixture.label]);
    assert.equal(JSON.stringify(projection).includes('"overrides"'), false);
    const sources = metalSourcesForProgramProjection(projection);
    metalPrograms.push({ label: fixture.label, sources });
    evidenceByLabel.set(fixture.label, {
      requests: fixture.compilerRequests,
      responses,
      projection,
    });
  }

  assert.deepEqual(
    evidenceByLabel.get("overrideDependent"),
    evidenceByLabel.get("overrideEquivalent")
  );
  assert.notDeepEqual(
    evidenceByLabel.get("overrideDependent"),
    evidenceByLabel.get("overrideBypass")
  );

  const metal = compileOverrideMetalPrograms(metalPrograms, settings);

  return {
    invocations: translationWorkerLaunches - initialLaunches,
    deterministicEntries: observed.length,
    projectedPrograms: fixtures.length,
    semanticEquivalenceChecks: 2,
    observed,
    offlineMetal: metal.offlineMetal,
    metalRuntime: metal.metalRuntime,
  };
}

function compileOverrideMetalPrograms(programs, settings) {
  if (process.platform !== "darwin") {
    return skippedOverrideMetal(settings, "host-is-not-macos");
  }
  const missing = ["metal", "metallib"].filter((tool) => !xcrunToolWorks(tool));
  if (missing.length > 0) {
    return skippedOverrideMetal(
      settings,
      `missing-xcrun-tools:${missing.join(",")}`
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), "vgpu-override-metal-"));
  try {
    const libraries = [];
    let shaderCount = 0;
    let renderRuntimeInput;
    for (const program of programs) {
      const airFiles = program.sources.map(({ stage, msl }) => {
        const sourcePath = join(scratch, `${program.label}-${stage}.metal`);
        const airPath = join(scratch, `${program.label}-${stage}.air`);
        writeFileSync(sourcePath, msl, "utf8");
        checkedCommand(
          `offline Metal override compilation for ${program.label}/${stage}`,
          "xcrun",
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
        assertNonEmptyFile(airPath, `${program.label}/${stage} AIR`);
        shaderCount += 1;
        return airPath;
      });
      const libraryPath = join(scratch, `${program.label}.metallib`);
      checkedCommand(
        `offline Metal override link for ${program.label}`,
        "xcrun",
        ["-sdk", "macosx", "metallib", ...airFiles, "-o", libraryPath]
      );
      assertNonEmptyFile(libraryPath, `${program.label} metallib`);
      libraries.push({
        label: program.label,
        bytes: lstatSync(libraryPath).size,
      });
      if (program.label === "overrideRender") {
        assert.equal(renderRuntimeInput, undefined);
        renderRuntimeInput = { libraryPath, sources: program.sources };
      }
    }
    assert(renderRuntimeInput, "override render program was not compiled");
    const metalRuntime = settings.skipMetalRuntime
      ? { status: "skipped", reason: "requested-by-flag" }
      : runOverrideMetalRuntime({
          ...renderRuntimeInput,
          scratch,
          settings,
        });
    return {
      offlineMetal: {
        status: "passed",
        programs: programs.length,
        shaders: shaderCount,
        target: metalTarget,
        libraries,
      },
      metalRuntime,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function skippedOverrideMetal(settings, reason) {
  if (settings.requireOfflineMetal) {
    fail(`offline Metal override compilation is required: ${reason}`);
  }
  return {
    offlineMetal: { status: "skipped", reason },
    metalRuntime: { status: "skipped", reason: `offline-metal:${reason}` },
  };
}

function assertOverrideRuntimeProbeSource() {
  const source = readFileSync(overrideSwiftProbePath, "utf8");
  assert.equal(
    sha256(source),
    expectedSnapshots.overrideRender.runtimeProbeSha256
  );
  assert.doesNotMatch(source, /MTLFunctionConstantValues/u);
  assert.doesNotMatch(source, /constantValues\s*:/u);
  assert.equal(source.match(/makeFunction\(name:/gu)?.length, 2);
  assert.equal(
    createHash("sha256")
      .update(Buffer.from(overrideExpectedReadback))
      .digest("hex"),
    expectedSnapshots.overrideRender.runtimeReadbackSha256
  );
  return 5;
}

function runOverrideMetalRuntime({ libraryPath, sources, scratch, settings }) {
  if (!xcrunToolWorks("swiftc")) {
    if (settings.requireMetalRuntime) {
      fail("override Metal runtime requires xcrun swiftc");
    }
    return { status: "skipped", reason: "missing-xcrun-tool:swiftc" };
  }
  const architecture = { arm64: "arm64", x64: "x86_64" }[process.arch];
  if (!architecture) {
    if (settings.requireMetalRuntime) {
      fail(`unsupported override Metal runtime architecture ${process.arch}`);
    }
    return {
      status: "skipped",
      reason: `unsupported-architecture:${process.arch}`,
    };
  }

  const entryPoints = Object.fromEntries(
    sources.map(({ stage, entryPoint }) => [stage, entryPoint])
  );
  assert.deepEqual(Object.keys(entryPoints).sort(), ["fragment", "vertex"]);
  const executable = join(scratch, "override-metal-probe");
  checkedCommand("Swift override Metal probe compilation", "xcrun", [
    "swiftc",
    "-O",
    "-target",
    `${architecture}-apple-macosx14.0`,
    "-framework",
    "Foundation",
    "-framework",
    "Metal",
    overrideSwiftProbePath,
    "-o",
    executable,
  ]);

  const args = [libraryPath, entryPoints.vertex, entryPoints.fragment];
  const attempts = [
    runCommand(executable, args, { timeout: 120_000 }),
    runCommand(executable, args, { timeout: 120_000 }),
  ];
  if (
    attempts.every(
      (attempt) =>
        attempt.status !== 0 &&
        `${attempt.stdout}${attempt.stderr}`.includes(
          "No default Metal device is available"
        )
    )
  ) {
    if (settings.requireMetalRuntime) {
      fail("override Metal runtime found no default device");
    }
    return { status: "skipped", reason: "no-metal-device" };
  }
  for (const attempt of attempts) {
    if (
      attempt.error ||
      attempt.signal ||
      attempt.status !== 0 ||
      attempt.stderr !== ""
    ) {
      commandFailure("override Metal runtime probe", attempt);
    }
  }
  assert.equal(
    attempts[0].stdout,
    attempts[1].stdout,
    "override Metal runtime output is not deterministic"
  );
  const report = JSON.parse(attempts[0].stdout);
  assert.deepEqual(Object.keys(report).sort(), ["device", "readbacks"]);
  assert.deepEqual(report.readbacks, [
    [...overrideExpectedReadback],
    [...overrideExpectedReadback],
  ]);
  assert.equal(typeof report.device, "string");
  assert(report.device.length > 0);
  const readbackSha256 = createHash("sha256")
    .update(Buffer.from(report.readbacks[0]))
    .digest("hex");
  assert.equal(
    readbackSha256,
    expectedSnapshots.overrideRender.runtimeReadbackSha256
  );
  return {
    status: "passed",
    deterministicProcesses: attempts.length,
    rendersPerProcess: report.readbacks.length,
    device: report.device,
    pixelsPerReadback: report.readbacks[0].length / 4,
    probeSha256: expectedSnapshots.overrideRender.runtimeProbeSha256,
    readback: report.readbacks[0],
    readbackSha256,
  };
}

async function assertNativeResourceTranslations(
  workerPath,
  fixture,
  settings,
  expectedProjection
) {
  const initialLaunches = translationWorkerLaunches;
  const observed = [];
  const translations = [];
  for (const request of fixture.compilerRequests) {
    const attempts = await Promise.all([
      invokeTranslation(workerPath, request),
      invokeTranslation(workerPath, request),
    ]);
    assert.equal(attempts[0].stdout, attempts[1].stdout);
    const authenticated = attempts.map((attempt) => {
      let translation;
      decodeTintWorkerResponse(attempt, (response) => {
        translation = authenticateSuccessfulCompilerTranslation({
          request,
          response,
        });
        return true;
      });
      assert(translation);
      return translation;
    });
    const responses = authenticated.map(compilerResponseForTranslation);
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
    translations.push(authenticated[0]);
  }
  const projection = assembleMetalProgramProjection({
    assembly: fixture.assembly,
    allocation: fixture.allocation,
    translations,
  });
  assert.deepEqual(projection, expectedProjection);
  assert.deepEqual(
    assembleMetalProgramProjection({
      assembly: fixture.assembly,
      allocation: fixture.allocation,
      translations: [...translations].reverse(),
    }),
    projection
  );
  const sources = metalSourcesForProgramProjection(projection);
  const runtimeLayout =
    runtimeResourceLayoutForMetalProgramProjection(projection);
  assert(isRuntimeResourceLayout(runtimeLayout));
  assert.deepEqual(
    runtimeLayout,
    runtimeResourceLayoutForMetalProgramProjection(expectedProjection)
  );
  const metal = runResourceMetalProgram({ projection, settings });
  const runtimeLayoutSha256 = sha256(JSON.stringify(runtimeLayout));
  assert.equal(
    runtimeLayoutSha256,
    expectedSnapshots.resource.runtimeLayoutSha256
  );
  return {
    invocations: translationWorkerLaunches - initialLaunches,
    deterministicEntries: fixture.compilerRequests.length,
    projectedPrograms: 1,
    sources: sources.length,
    runtimeLayoutSha256,
    observed,
    offlineMetal: metal.offlineMetal,
    metalRuntime: metal.metalRuntime,
  };
}

async function assertNativeRuntimeSizedStorageTranslation(
  workerPath,
  fixture,
  settings
) {
  const initialLaunches = translationWorkerLaunches;
  assert.equal(fixture.compilerRequests.length, 1);
  const [request] = fixture.compilerRequests;
  assert.equal(request.entryPoint.stage, "compute");
  const attempts = await Promise.all([
    invokeTranslation(workerPath, request),
    invokeTranslation(workerPath, request),
  ]);
  assert.equal(attempts[0].stdout, attempts[1].stdout);
  const translations = attempts.map((attempt) => {
    let translation;
    decodeTintWorkerResponse(attempt, (response) => {
      translation = authenticateSuccessfulCompilerTranslation({
        request,
        response,
      });
      return true;
    });
    assert(translation);
    return translation;
  });
  const responses = translations.map(compilerResponseForTranslation);
  assert.deepEqual(responses[0], responses[1]);
  const result = responses[0].result;
  const observed = {
    stage: request.entryPoint.stage,
    deterministicRuns: attempts.length,
    requestSha256: sha256(JSON.stringify(request)),
    responseSha256: sha256(attempts[0].stdout),
    mslSha256: sha256(result.msl),
  };
  assert.deepEqual(
    {
      requestSha256: observed.requestSha256,
      responseSha256: observed.responseSha256,
      mslSha256: observed.mslSha256,
    },
    expectedSnapshots.runtimeSizedStorage.translations.compute
  );
  assert.deepEqual(result.internalBindings, [
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
  assert.deepEqual(result.storageBufferSizeRegions, [
    { stage: "compute", immediateDataByteOffset: 4 },
  ]);
  assert.match(result.msl, /values \[\[buffer\(0\)\]\]/u);
  assert.match(result.msl, /tint_immediate_data \[\[buffer\(30\)\]\]/u);
  assert.match(result.msl, /tint_storage_buffer_sizes\[0u\] - 4u\) \/ 12u/u);

  const projection = assembleMetalProgramProjection({
    assembly: fixture.assembly,
    allocation: fixture.allocation,
    translations: [translations[0]],
  });
  assert.deepEqual(projection, {
    semanticProgram: "AssemblyRuntimeSizedStorage",
    kind: "compute",
    entryPoints: [
      {
        stage: "compute",
        wgsl: "compute_main",
        metal: "vgpu_assembly_runtime_sized_storage_compute",
        interface: { kind: "compute" },
      },
    ],
    bindings: [
      {
        semanticBinding: "g0b0",
        slots: [directSlot("compute", "buffer", 0)],
      },
    ],
    internalBindings: [
      {
        role: "immediate-data",
        slots: [directSlot("compute", "buffer", 30)],
      },
    ],
    storageBufferSizeRegions: [
      { stage: "compute", immediateDataByteOffset: 4 },
    ],
    resolvedWorkgroupSize: { x: 1, y: 1, z: 1 },
    deviceRequirements: { features: [], limits: [], formats: [] },
  });
  assert.equal(
    sha256(JSON.stringify(projection)),
    expectedSnapshots.runtimeSizedStorage.metalProjectionSha256
  );
  const runtimeLayout =
    runtimeResourceLayoutForMetalProgramProjection(projection);
  assert.deepEqual(runtimeLayout, {
    semanticProgram: "AssemblyRuntimeSizedStorage",
    kind: "compute",
    bindings: [
      {
        semanticBinding: "g0b0",
        descriptor: {
          kind: "buffer",
          addressSpace: "storage",
          access: "read",
          minimumBindingSize: 16,
          runtimeSized: true,
        },
        slots: [directSlot("compute", "buffer", 0)],
      },
    ],
    samplingPairs: [],
  });
  assert.equal(
    sha256(JSON.stringify(runtimeLayout)),
    expectedSnapshots.runtimeSizedStorage.runtimeLayoutSha256
  );
  const offlineMetal = compileRuntimeSizedStorageMetal({
    projection,
    settings,
  });
  return {
    invocations: translationWorkerLaunches - initialLaunches,
    deterministicEntries: 1,
    projectedPrograms: 1,
    observed: [observed],
    projectionSha256:
      expectedSnapshots.runtimeSizedStorage.metalProjectionSha256,
    runtimeLayoutSha256:
      expectedSnapshots.runtimeSizedStorage.runtimeLayoutSha256,
    offlineMetal,
    metalRuntime: {
      status: "deferred",
      reason: "internal-raw-runtime-binder-not-yet-connected",
    },
  };
}

function compileRuntimeSizedStorageMetal({ projection, settings }) {
  const [source] = metalSourcesForProgramProjection(projection);
  assert.equal(source.stage, "compute");
  if (process.platform !== "darwin") {
    if (settings.requireOfflineMetal) {
      fail(
        "runtime-sized storage offline Metal is required: host-is-not-macos"
      );
    }
    return { status: "skipped", reason: "host-is-not-macos" };
  }
  const missing = ["metal", "metallib"].filter((tool) => !xcrunToolWorks(tool));
  if (missing.length > 0) {
    if (settings.requireOfflineMetal) {
      fail(
        `runtime-sized storage offline Metal is required: missing-xcrun-tools:${missing.join(
          ","
        )}`
      );
    }
    return {
      status: "skipped",
      reason: `missing-xcrun-tools:${missing.join(",")}`,
    };
  }

  const scratch = mkdtempSync(join(tmpdir(), "vgpu-runtime-storage-metal-"));
  try {
    const sourcePath = join(scratch, "runtime-storage.metal");
    const airPath = join(scratch, "runtime-storage.air");
    const libraryPath = join(scratch, "runtime-storage.metallib");
    writeFileSync(sourcePath, source.msl, "utf8");
    checkedCommand("offline Metal runtime-sized storage compilation", "xcrun", [
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
    ]);
    assertNonEmptyFile(airPath, "runtime-sized storage AIR");
    checkedCommand("offline Metal runtime-sized storage link", "xcrun", [
      "-sdk",
      "macosx",
      "metallib",
      airPath,
      "-o",
      libraryPath,
    ]);
    assertNonEmptyFile(libraryPath, "runtime-sized storage metallib");
    return {
      status: "passed",
      shaders: 1,
      target: metalTarget,
      libraryBytes: lstatSync(libraryPath).size,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function invokeTranslation(workerPath, request) {
  translationWorkerLaunches += 1;
  return invokeRawTintPrototype({ executable: workerPath, request });
}

function runResourceMetalProgram({ projection, settings }) {
  const sources = metalSourcesForProgramProjection(projection);
  const manifest = resourceRuntimeManifest(projection);
  const manifestBytes = JSON.stringify(manifest);
  assert.equal(
    sha256(manifestBytes),
    expectedSnapshots.resource.runtimeManifestSha256
  );
  assert.equal(
    sha256(readFileSync(resourceSwiftProbePath, "utf8")),
    expectedSnapshots.resource.runtimeProbeSha256
  );
  if (process.platform !== "darwin") {
    return skippedResourceMetal(settings, "host-is-not-macos");
  }
  const missing = ["metal", "metallib"].filter((tool) => !xcrunToolWorks(tool));
  if (missing.length > 0) {
    return skippedResourceMetal(
      settings,
      `missing-xcrun-tools:${missing.join(",")}`
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), "vgpu-resource-metal-"));
  try {
    const airFiles = sources.map(({ stage, msl }) => {
      const metalSource = join(scratch, `${stage}.metal`);
      const air = join(scratch, `${stage}.air`);
      writeFileSync(metalSource, msl, "utf8");
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
    const offlineMetal = {
      status: "passed",
      shaders: sources.length,
      target: metalTarget,
      libraryBytes: lstatSync(libraryPath).size,
    };
    const manifestPath = join(scratch, "resource-runtime-manifest.json");
    writeFileSync(manifestPath, manifestBytes, "utf8");
    const metalRuntime = settings.skipMetalRuntime
      ? { status: "skipped", reason: "requested-by-flag" }
      : runResourceMetalRuntime({
          libraryPath,
          manifestPath,
          manifestBytes,
          scratch,
          settings,
        });
    return {
      offlineMetal,
      metalRuntime,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function skippedResourceMetal(settings, reason) {
  if (settings.requireOfflineMetal) {
    fail(`offline Metal is required: ${reason}`);
  }
  return {
    offlineMetal: { status: "skipped", reason },
    metalRuntime: { status: "skipped", reason: `offline-metal:${reason}` },
  };
}

function resourceRuntimeManifest(projection) {
  assert(isMetalProgramProjection(projection));
  const runtimeLayout =
    runtimeResourceLayoutForMetalProgramProjection(projection);
  const sources = metalSourcesForProgramProjection(projection);
  assert(isRuntimeResourceLayout(runtimeLayout));
  const manifest = {
    schemaVersion: 1,
    semanticProgram: runtimeLayout.semanticProgram,
    kind: runtimeLayout.kind,
    entryPoints: sources.map(({ stage, entryPoint }) => ({
      stage,
      metal: entryPoint,
    })),
    bindings: runtimeLayout.bindings,
    samplingPairs: runtimeLayout.samplingPairs,
  };
  assert.deepEqual(
    manifest.entryPoints.map(({ stage }) => stage),
    ["vertex", "fragment"]
  );
  const serialized = JSON.stringify(manifest);
  for (const forbidden of [
    '"msl"',
    '"allocation"',
    '"request"',
    '"response"',
    '"internalBindings"',
    '"index":30',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  return manifest;
}

function runResourceMetalRuntime({
  libraryPath,
  manifestPath,
  manifestBytes,
  scratch,
  settings,
}) {
  if (!xcrunToolWorks("swiftc")) {
    if (settings.requireMetalRuntime) {
      fail("Metal runtime requires xcrun swiftc");
    }
    return { status: "skipped", reason: "missing-xcrun-tool:swiftc" };
  }
  const architecture = { arm64: "arm64", x64: "x86_64" }[process.arch];
  if (!architecture) {
    if (settings.requireMetalRuntime) {
      fail(`unsupported Metal runtime architecture ${process.arch}`);
    }
    return {
      status: "skipped",
      reason: `unsupported-architecture:${process.arch}`,
    };
  }
  const executable = join(scratch, "resource-metal-probe");
  checkedCommand("Swift resource Metal probe compilation", "xcrun", [
    "swiftc",
    "-O",
    "-target",
    `${architecture}-apple-macosx14.0`,
    "-framework",
    "Foundation",
    "-framework",
    "Metal",
    resourceSwiftProbePath,
    "-o",
    executable,
  ]);
  const manifestFailures = assertResourceRuntimeManifestFailures({
    executable,
    libraryPath,
    manifestBytes,
    scratch,
  });
  const args = [libraryPath, manifestPath];
  const attempts = [
    runCommand(executable, args, { timeout: 120_000 }),
    runCommand(executable, args, { timeout: 120_000 }),
  ];
  if (
    attempts.every(
      (attempt) =>
        attempt.status !== 0 &&
        `${attempt.stdout}${attempt.stderr}`.includes(
          "No default Metal device is available"
        )
    )
  ) {
    if (settings.requireMetalRuntime) {
      fail("Metal runtime found no default device");
    }
    return { status: "skipped", reason: "no-metal-device" };
  }
  for (const attempt of attempts) {
    if (
      attempt.error ||
      attempt.signal ||
      attempt.status !== 0 ||
      attempt.stderr !== ""
    ) {
      commandFailure("Metal resource runtime probe", attempt);
    }
  }
  assert.equal(
    attempts[0].stdout,
    attempts[1].stdout,
    "Metal resource runtime output is not deterministic"
  );
  const report = JSON.parse(attempts[0].stdout);
  assert.deepEqual(report.vertexReflection, [
    "buffer/0/frame/8/8",
    "buffer/1/vertices/24/8",
  ]);
  assert.deepEqual(report.fragmentReflection, [
    "buffer/0/frame/8/8",
    "buffer/1/material/16/16",
    "texture/0/albedo",
    "sampler/0/albedo_sampler",
  ]);
  assert.deepEqual(report.negativePreparationChecks, [
    "missing",
    "extra",
    "wrong-kind",
    "undersized",
    "out-of-bounds",
    "context",
    "buffer-usage",
    "texture-dimension",
    "texture-sample-type",
    "texture-multisample",
    "texture-usage",
    "sampler-kind",
    "storage-alignment",
    "offset-alignment",
    "runtime-sized",
  ]);
  assert.deepEqual(report.negativeEncodingChecks.slice(0, 2), [
    "program-a-to-b",
    "program-b-to-a",
  ]);
  if (report.negativeEncodingChecks.length === 2) {
    assert.deepEqual(report.conditionalDeviceChecks, []);
  } else {
    assert.deepEqual(report.negativeEncodingChecks, [
      "program-a-to-b",
      "program-b-to-a",
      "encoder-device",
    ]);
    assert.deepEqual(report.conditionalDeviceChecks, ["pipeline-device"]);
  }
  assert.deepEqual(report.commands, expectedResourceBindingCommands());
  assert.deepEqual(
    report.readback,
    [99, 115, 32, 128, 255, 0, 255, 255, 99, 115, 32, 128, 99, 115, 32, 128]
  );
  assert.equal(typeof report.device, "string");
  assert(report.device.length > 0);
  const manifestSha256 = sha256(manifestBytes);
  const probeSha256 = sha256(readFileSync(resourceSwiftProbePath, "utf8"));
  const readbackSha256 = createHash("sha256")
    .update(Buffer.from(report.readback))
    .digest("hex");
  assert.equal(
    manifestSha256,
    expectedSnapshots.resource.runtimeManifestSha256
  );
  assert.equal(probeSha256, expectedSnapshots.resource.runtimeProbeSha256);
  assert.equal(
    readbackSha256,
    expectedSnapshots.resource.runtimeReadbackSha256
  );
  return {
    status: "passed",
    deterministicRuns: attempts.length,
    device: report.device,
    preparedCommands: report.commands.length,
    preparationFailures: report.negativePreparationChecks.length,
    encodingFailures: report.negativeEncodingChecks.length,
    conditionalDeviceChecks: report.conditionalDeviceChecks.length,
    manifestFailures,
    manifestSha256,
    probeSha256,
    readback: report.readback,
    readbackSha256,
  };
}

function assertResourceRuntimeManifestFailures({
  executable,
  libraryPath,
  manifestBytes,
  scratch,
}) {
  const mutations = [
    {
      label: "extra-root-key",
      expected: "runtime probe manifest has unexpected or missing properties",
      mutate: (manifest) => {
        manifest.unexpected = true;
      },
    },
    {
      label: "extra-descriptor-key",
      expected: "bindings[0].descriptor has unexpected or missing properties",
      mutate: (manifest) => {
        manifest.bindings[0].descriptor.unexpected = true;
      },
    },
    {
      label: "candidate-slot",
      expected: "runtime resource layout differs from the fixed fixture",
      mutate: (manifest) => {
        manifest.bindings[0].slots[0].index = 30;
      },
    },
    {
      label: "invalid-entry-name",
      expected: "entryPoints[0] has an invalid Metal entry name",
      mutate: (manifest) => {
        manifest.entryPoints[0].metal = "invalid-entry-name";
      },
    },
  ];
  for (const { label, expected, mutate } of mutations) {
    const manifest = JSON.parse(manifestBytes);
    mutate(manifest);
    const path = join(scratch, `resource-runtime-manifest-${label}.json`);
    writeFileSync(path, JSON.stringify(manifest), "utf8");
    const attempt = runCommand(executable, [libraryPath, path], {
      timeout: 120_000,
    });
    assert.equal(attempt.error, undefined);
    assert(
      attempt.signal || attempt.status !== 0,
      `${label} runtime manifest escaped its negative gate`
    );
    assert(
      `${attempt.stdout}${attempt.stderr}`.includes(expected),
      `${label} runtime manifest omitted its expected diagnostic`
    );
  }
  return mutations.length;
}

function expectedResourceBindingCommands() {
  return [
    resourceBindingCommand("g0b0", "vertex", "buffer", 0, "frame-buffer"),
    resourceBindingCommand("g0b0", "fragment", "buffer", 0, "frame-buffer"),
    resourceBindingCommand("g0b1", "vertex", "buffer", 1, "vertices-buffer"),
    resourceBindingCommand("g0b2", "fragment", "texture", 0, "albedo-texture"),
    resourceBindingCommand("g0b3", "fragment", "sampler", 0, "albedo-sampler"),
    resourceBindingCommand("g0b10", "fragment", "buffer", 1, "material-buffer"),
  ];
}

function resourceBindingCommand(
  semanticBinding,
  stage,
  resourceClass,
  index,
  resource
) {
  return { index, resource, resourceClass, semanticBinding, stage };
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
}

function commandFailure(owner, attempt) {
  const diagnostic = `${attempt.stdout}${attempt.stderr}`.trim();
  fail(
    `${owner} failed with ${
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
    fail(`offline Metal did not produce a non-empty ${label}`);
  }
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
    requireMetalRuntime: false,
    skipMetalRuntime: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--help", "-h"].includes(argument)) {
      process.stdout.write(
        "Usage: node gates/semantic-assembly.mjs [--worker <Tint executable>] " +
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
  if (parsed.requireMetalRuntime && parsed.skipMetalRuntime) {
    fail("--require-metal-runtime conflicts with --skip-metal-runtime");
  }
  if (parsed.requireMetalRuntime) parsed.requireOfflineMetal = true;
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
