#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(scriptDirectory, "..");

function fail(message) {
  throw new Error(`C3 assemble: ${message}`);
}

function parseArguments(argv) {
  const options = {
    payload: join(
      fixtureDirectory,
      "fixtures",
      "invalid-metallib-sentinel.txt"
    ),
    payloadKind: "invalid-structural-sentinel",
    metalTarget: "air64-apple-macos14.0",
    metalLanguageVersion: "2.4",
    xcodeVersion: "0.0",
    xcodeBuild: "synthetic-c3a",
    metalVersion: "0.0",
    swiftVersion: "6.0",
    sdkVersion: "0.0",
    sdkBuild: "synthetic-c3a",
  };

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      fail(`expected --name value pairs, received ${name ?? "<nothing>"}`);
    }

    const key = {
      "--output": "output",
      "--payload": "payload",
      "--payload-kind": "payloadKind",
      "--metal-target": "metalTarget",
      "--metal-language-version": "metalLanguageVersion",
      "--xcode-version": "xcodeVersion",
      "--xcode-build": "xcodeBuild",
      "--metal-version": "metalVersion",
      "--swift-version": "swiftVersion",
      "--sdk-version": "sdkVersion",
      "--sdk-build": "sdkBuild",
    }[name];
    if (!key) fail(`unknown option ${name}`);
    options[key] = value;
  }

  if (!options.output) fail("--output is required");
  if (!/^[a-z][a-z0-9-]*$/.test(options.payloadKind)) {
    fail(`invalid payload kind ${options.payloadKind}`);
  }
  return options;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const fields = Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    return `{${fields
      .map((field) => `${JSON.stringify(field)}:${canonicalize(value[field])}`)
      .join(",")}}`;
  }
  fail(`cannot canonicalize ${typeof value}`);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalize(value), "utf8"));
}

function stripPresentationAndProvenance(value) {
  if (Array.isArray(value)) {
    return value.map(stripPresentationAndProvenance);
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "swiftName" && key !== "source")
      .map(([key, child]) => [key, stripPresentationAndProvenance(child)])
  );
}

function normalizeSemanticSets(value, key = "") {
  if (Array.isArray(value)) {
    const normalized = value.map((child) => normalizeSemanticSets(child));
    const isStringSet =
      ["languageFeatures", "features", "visibility"].includes(key) ||
      (key === "bindings" &&
        normalized.every((child) => typeof child === "string"));
    return isStringSet
      ? normalized.sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0
        )
      : normalized;
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      normalizeSemanticSets(child, childKey),
    ])
  );
}

function reachableTypeAndLayoutClosure(program, semantic) {
  const typeIds = new Set();
  const layoutIds = new Set();
  const typeQueue = [];
  const layoutQueue = [];
  const addType = (id) => {
    if (id !== undefined && !typeIds.has(id)) {
      typeIds.add(id);
      typeQueue.push(id);
    }
  };
  const addLayout = (id) => {
    if (id !== undefined && !layoutIds.has(id)) {
      layoutIds.add(id);
      layoutQueue.push(id);
    }
  };

  for (const binding of program.bindings) {
    addType(binding.type);
    addLayout(binding.layout);
  }
  for (const entry of Object.values(program.entryPoints)) {
    for (const value of [...entry.inputs, ...entry.outputs])
      addType(value.type);
  }

  while (typeQueue.length > 0 || layoutQueue.length > 0) {
    while (typeQueue.length > 0) {
      const id = typeQueue.shift();
      const type = semantic.types[id];
      if (!type) fail(`program ${program.name} references unknown type ${id}`);
      for (const [layoutId, layout] of Object.entries(semantic.layouts)) {
        if (layout.type === id) addLayout(layoutId);
      }
      addType(type.element);
      for (const member of type.members ?? []) addType(member.type);
    }
    while (layoutQueue.length > 0) {
      const id = layoutQueue.shift();
      const layout = semantic.layouts[id];
      if (!layout)
        fail(`program ${program.name} references unknown layout ${id}`);
      addType(layout.type);
      for (const member of layout.members) {
        addType(member.type);
        addLayout(member.layout);
      }
    }
  }

  const types = Object.fromEntries(
    [...typeIds]
      .sort()
      .map((id) => [id, stripPresentationAndProvenance(semantic.types[id])])
  );
  const layouts = Object.fromEntries(
    [...layoutIds]
      .sort()
      .map((id) => [id, stripPresentationAndProvenance(semantic.layouts[id])])
  );
  return { types, layouts };
}

function programFingerprintInput(program, semantic, inputs) {
  const programWithoutFingerprint = clone(program);
  delete programWithoutFingerprint.fingerprint;
  delete programWithoutFingerprint.sources;
  const sourcesById = new Map(inputs.map((input) => [input.id, input]));
  const sources = program.sources
    .map((id) => {
      const input = sourcesById.get(id);
      if (!input || input.role !== "wgsl") {
        fail(`program ${program.name} references unknown WGSL input ${id}`);
      }
      return { id, sha256: input.sha256 };
    })
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );
  const closure = reachableTypeAndLayoutClosure(program, semantic);
  return {
    domain: "vgpu-native-program/v1",
    layoutModel: semantic.layoutModel,
    sources,
    languageFeatures: [...semantic.capabilities.languageFeatures].sort(),
    program: normalizeSemanticSets(
      stripPresentationAndProvenance(programWithoutFingerprint)
    ),
    types: closure.types,
    layouts: closure.layouts,
  };
}

function fingerprintProgram(program, semantic, inputs) {
  return sha256Canonical(programFingerprintInput(program, semantic, inputs));
}

function runtimeProjectionInput(projection, librarySHA256) {
  return {
    semantic: projection.semantic,
    target: projection.target,
    abi: projection.abi,
    library: {
      path: projection.library.path,
      sha256: librarySHA256,
    },
    programs: projection.programs,
    deviceRequirements: projection.deviceRequirements,
  };
}

function walkFiles(root) {
  const results = [];
  const visit = (directory) => {
    const names = readdirSync(directory).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    for (const name of names) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        fail(`refusing to package symlink ${path}`);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) results.push(path);
      else fail(`unsupported filesystem entry ${path}`);
    }
  };
  visit(root);
  return results;
}

function swiftString(value) {
  return JSON.stringify(value);
}

function mutationStatement(mutation) {
  const supportRanges = new Set([
    "semanticSchemaVersions",
    "metalProjectionABIs",
    "generatedSwiftABIs",
    "bindingLayoutABIs",
    "vgpuABIVersions",
    "bindingSlotsABIs",
  ]);
  const descriptorIntegers = new Set([
    "semanticSchemaVersion",
    "metalProjectionABI",
    "generatedSwiftABI",
    "bindingLayoutABI",
    "requiredVGPUABIVersion",
    "bindingSlotsABI",
  ]);
  const descriptorStrings = new Set([
    "layoutModel",
    "bindingModel",
    "semanticFingerprint",
    "projectionSemanticFingerprint",
    "runtimeFingerprint",
    "generatedRuntimeFingerprint",
    "librarySHA256",
    "generatedLibrarySHA256",
  ]);

  if (mutation.kind === "supportRange" && supportRanges.has(mutation.field)) {
    if (
      !Number.isSafeInteger(mutation.lower) ||
      !Number.isSafeInteger(mutation.upper)
    ) {
      fail(`mutation ${mutation.name} has a non-integer range`);
    }
    return `support.${mutation.field} = ${mutation.lower}...${mutation.upper}`;
  }
  if (
    mutation.kind === "descriptorInteger" &&
    descriptorIntegers.has(mutation.field)
  ) {
    if (!Number.isSafeInteger(mutation.value)) {
      fail(`mutation ${mutation.name} has a non-integer value`);
    }
    return `descriptor.${mutation.field} = ${mutation.value}`;
  }
  if (
    mutation.kind === "descriptorString" &&
    descriptorStrings.has(mutation.field)
  ) {
    if (typeof mutation.value !== "string") {
      fail(`mutation ${mutation.name} has a non-string value`);
    }
    return `descriptor.${mutation.field} = ${swiftString(mutation.value)}`;
  }
  fail(
    `mutation ${mutation.name} has unsupported kind/field ${mutation.kind}/${mutation.field}`
  );
}

function generateMutationTests(mutations) {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    fail("mutation matrix must be a non-empty array");
  }
  const names = new Set();
  const blocks = mutations.map((mutation) => {
    if (typeof mutation.name !== "string" || names.has(mutation.name)) {
      fail(`mutation names must be unique strings: ${mutation.name}`);
    }
    names.add(mutation.name);
    if (!Number.isSafeInteger(mutation.expectedPipelineCalls)) {
      fail(`mutation ${mutation.name} needs expectedPipelineCalls`);
    }
    if (typeof mutation.expectedApplicationCode !== "string") {
      fail(`mutation ${mutation.name} must reject application compatibility`);
    }

    const statement = mutationStatement(mutation);
    const descriptorBinding = mutation.kind === "supportRange" ? "let" : "var";
    const supportBinding = mutation.kind === "supportRange" ? "var" : "let";
    return `    do {
      ${descriptorBinding} descriptor = AppShadersArtifact.descriptor
      ${supportBinding} support = AppShadersRuntimeSupport.fixtureSupported
      ${statement}
      var pipelineCalls = 0
      var applicationCode: String?
      do {
        try AppShadersArtifact.validateApplicationCompatibility(
          descriptor: descriptor,
          runtime: support,
          payloadSHA256: descriptor.librarySHA256
        ) {
          pipelineCalls += 1
        }
      } catch let error as AppShadersCompatibilityError {
        applicationCode = error.code
      } catch {
        XCTFail("${mutation.name}: unexpected application error: \\(error)")
      }
      XCTAssertEqual(applicationCode, ${swiftString(
        mutation.expectedApplicationCode
      )}, "${mutation.name}")
      XCTAssertEqual(pipelineCalls, ${mutation.expectedPipelineCalls}, "${
      mutation.name
    }")
    }`;
  });

  return `// Generated from fixtures/mutations.json. Do not edit.
import XCTest
@testable import AppShaders

extension ArtifactCompatibilityTests {
  func testGeneratedMutationMatrixStopsBeforePipelineCreation() throws {
${blocks.join("\n\n")}
  }
}
`;
}

const options = parseArguments(process.argv.slice(2));
const outputRoot = resolve(options.output);
if (existsSync(outputRoot)) {
  const outputMetadata = lstatSync(outputRoot);
  if (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory()) {
    fail(`output must be a real directory: ${outputRoot}`);
  }
  if (readdirSync(outputRoot).length !== 0) {
    fail(`output directory must be empty: ${outputRoot}`);
  }
}
mkdirSync(outputRoot, { recursive: true });

const runtimeOutput = join(outputRoot, "RuntimeStub");
const shadersOutput = join(outputRoot, "AppShaders");
const consumerOutput = join(outputRoot, "CleanConsumer");

function copyFixtureFile(
  sourceRelativePath,
  destinationRoot,
  destinationRelativePath
) {
  const source = join(fixtureDirectory, ...sourceRelativePath.split("/"));
  const metadata = lstatSync(source);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`allowlisted template is not a regular file: ${sourceRelativePath}`);
  }
  const destination = join(
    destinationRoot,
    ...destinationRelativePath.split("/")
  );
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

for (const [source, destinationRoot, destination] of [
  ["RuntimeStub/Package.swift", runtimeOutput, "Package.swift"],
  [
    "RuntimeStub/Sources/VGPUABI/Compatibility.swift",
    runtimeOutput,
    "Sources/VGPUABI/Compatibility.swift",
  ],
  ["templates/AppShaders/Package.swift", shadersOutput, "Package.swift"],
  [
    "templates/AppShaders/Sources/AppShaders/AppShaders.generated.swift",
    shadersOutput,
    "Sources/AppShaders/AppShaders.generated.swift",
  ],
  [
    "templates/AppShaders/Sources/AppShadersC3MetalProbe/main.swift",
    shadersOutput,
    "Sources/AppShadersC3MetalProbe/main.swift",
  ],
  [
    "templates/AppShaders/Tests/AppShadersTests/ArtifactCompatibilityTests.swift",
    shadersOutput,
    "Tests/AppShadersTests/ArtifactCompatibilityTests.swift",
  ],
  ["templates/CleanConsumer/Package.swift", consumerOutput, "Package.swift"],
  [
    "templates/CleanConsumer/Sources/CleanConsumer/main.swift",
    consumerOutput,
    "Sources/CleanConsumer/main.swift",
  ],
]) {
  copyFixtureFile(source, destinationRoot, destination);
}

const payloadSource = resolve(options.payload);
if (!existsSync(payloadSource)) {
  fail(`payload is not a regular file: ${payloadSource}`);
}
const payloadMetadata = lstatSync(payloadSource);
if (payloadMetadata.isSymbolicLink() || !payloadMetadata.isFile()) {
  fail(`payload must be a non-symlink regular file: ${payloadSource}`);
}
const payloadPath = join(
  shadersOutput,
  "Sources",
  "AppShaders",
  "Resources",
  "AppShaders.metallib"
);
mkdirSync(dirname(payloadPath), { recursive: true });
copyFileSync(payloadSource, payloadPath);
const payloadBytes = readFileSync(payloadPath);
const librarySHA256 = sha256Bytes(payloadBytes);

const artifact = JSON.parse(
  readFileSync(join(fixtureDirectory, "fixtures", "artifact.base.json"), "utf8")
);
const sourcePath = join(fixtureDirectory, "fixtures", "noop.wgsl");
const sourceBytes = readFileSync(sourcePath);
artifact.inputs = [
  {
    id: "noop-wgsl",
    path: "fixtures/noop.wgsl",
    role: "wgsl",
    size: sourceBytes.byteLength,
    sha256: sha256Bytes(sourceBytes),
  },
];

const program = artifact.semantic.programs[0];
program.fingerprint.sha256 = fingerprintProgram(
  program,
  artifact.semantic,
  artifact.inputs
);
const semanticSHA256 = sha256Canonical(artifact.semantic);
artifact.projection.semantic.sha256 = semanticSHA256;
artifact.projection.target.metalCompilerTargetTriple = options.metalTarget;
artifact.projection.target.metalLanguageVersion = options.metalLanguageVersion;
Object.assign(artifact.projection.toolchain.apple, {
  xcodeVersion: options.xcodeVersion,
  xcodeBuild: options.xcodeBuild,
  metalVersion: options.metalVersion,
  swiftVersion: options.swiftVersion,
  sdkVersion: options.sdkVersion,
  sdkBuild: options.sdkBuild,
});
artifact.extensions["dev.vgpu.c3"].payloadKind = options.payloadKind;

const runtimeSHA256 = sha256Canonical(
  runtimeProjectionInput(artifact.projection, librarySHA256)
);
artifact.projection.runtimeFingerprint.sha256 = runtimeSHA256;

const noopProjection = artifact.projection.programs.find(
  (candidate) => candidate.semanticProgram === "Noop"
);
const noopBinding = noopProjection?.bindings.find(
  (candidate) => candidate.semanticBinding === "g0b0"
);
const noopSlots = noopBinding?.slots.filter(
  (slot) => slot.resourceClass === "buffer" && slot.stage === "compute"
);
if (noopSlots?.length !== 1 || noopSlots[0].count !== 1) {
  fail("Noop must project g0b0 to exactly one compute buffer slot");
}
const noopBufferIndex = noopSlots[0].index;
const noopEntries = noopProjection.entryPoints.filter(
  (entry) => entry.stage === "compute"
);
if (noopEntries.length !== 1) {
  fail("Noop must project exactly one compute entry point");
}
const noopWorkgroup = noopProjection.resolvedWorkgroupSize;
const semanticNoop = artifact.semantic.programs.find(
  (candidate) => candidate.name === "Noop"
);
const semanticNoopBinding = semanticNoop?.bindings.find(
  (candidate) => candidate.id === noopBinding.semanticBinding
);
const semanticNoopType = artifact.semantic.types[semanticNoopBinding?.type];
if (
  !semanticNoopBinding ||
  semanticNoopBinding.kind !== "buffer" ||
  semanticNoopType?.kind !== "array" ||
  !Number.isSafeInteger(semanticNoopType.count)
) {
  fail("Noop projected buffer must reference one fixed semantic array binding");
}

const generatedSourcePath = join(
  shadersOutput,
  "Sources",
  "AppShaders",
  "AppShaders.generated.swift"
);
let generatedSource = readFileSync(generatedSourcePath, "utf8");
for (const [placeholder, replacement] of [
  ["__PAYLOAD_KIND__", options.payloadKind],
  ["__SEMANTIC_SHA256__", semanticSHA256],
  ["__RUNTIME_SHA256__", runtimeSHA256],
  ["__LIBRARY_SHA256__", librarySHA256],
  ["__NOOP_METAL_ENTRY_POINT__", noopEntries[0].metal],
  ["__NOOP_BUFFER_INDEX__", String(noopBufferIndex)],
  ["__NOOP_WORKGROUP_WIDTH__", String(noopWorkgroup.x)],
  ["__NOOP_WORKGROUP_HEIGHT__", String(noopWorkgroup.y)],
  ["__NOOP_WORKGROUP_DEPTH__", String(noopWorkgroup.z)],
  [
    "__NOOP_BUFFER_BYTE_COUNT__",
    String(semanticNoopBinding.minimumBindingSize),
  ],
  ["__NOOP_ELEMENT_COUNT__", String(semanticNoopType.count)],
]) {
  generatedSource = generatedSource.replaceAll(placeholder, replacement);
}
if (generatedSource.includes("__")) {
  fail("generated Swift contains an unresolved placeholder");
}
writeFileSync(generatedSourcePath, generatedSource);

const mutations = JSON.parse(
  readFileSync(join(fixtureDirectory, "fixtures", "mutations.json"), "utf8")
);
writeFileSync(
  join(
    shadersOutput,
    "Tests",
    "AppShadersTests",
    "MutationMatrix.generated.swift"
  ),
  generateMutationTests(mutations)
);

const excludedPayloadFiles = new Set([
  "artifact.json",
  ".vgpu-native-output.json",
]);
artifact.files = walkFiles(shadersOutput)
  .map((path) => relative(shadersOutput, path).split(sep).join("/"))
  .filter((path) => !excludedPayloadFiles.has(path))
  .map((path) => {
    const bytes = readFileSync(join(shadersOutput, ...path.split("/")));
    return { path, size: bytes.byteLength, sha256: sha256Bytes(bytes) };
  })
  .sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );

const logicalInputsSHA256 = sha256Canonical(artifact.inputs);
const buildSHA256 = sha256Canonical({
  compiler: artifact.compiler,
  logicalInputs: logicalInputsSHA256,
  semantic: semanticSHA256,
  runtimeProjection: runtimeSHA256,
  toolchain: artifact.projection.toolchain,
  files: artifact.files,
});
artifact.fingerprints = {
  logicalInputs: {
    domain: "vgpu-native-logical-inputs/v1",
    sha256: logicalInputsSHA256,
  },
  semantic: {
    domain: "vgpu-native-semantic/v1",
    sha256: semanticSHA256,
  },
  build: {
    domain: "vgpu-native-build/v1",
    sha256: buildSHA256,
  },
};

const artifactBytes = Buffer.from(
  `${JSON.stringify(artifact, null, 2)}\n`,
  "utf8"
);
writeFileSync(join(shadersOutput, "artifact.json"), artifactBytes);
const marker = {
  schemaVersion: 1,
  contractId: "vgpu-native-output-owner/v1",
  configuration: "c3-artifact-swiftpm",
  manifestSha256: sha256Bytes(artifactBytes),
};
writeFileSync(
  join(shadersOutput, ".vgpu-native-output.json"),
  `${JSON.stringify(marker, null, 2)}\n`
);

console.log(
  JSON.stringify({
    payloadKind: options.payloadKind,
    payloadSha256: librarySHA256,
    semanticSha256: semanticSHA256,
    runtimeProjectionSha256: runtimeSHA256,
    buildSha256: buildSHA256,
  })
);
