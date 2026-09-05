#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HANDOFF_CONTRACT = "vgpu-native-c1-connected-artifact-handoff/v1";
const ARTIFACT_CONTRACT = "vgpu-native-connected-artifact-spike/v1";
const ARTIFACT_ID = "assembly-runtime-sized-storage";
const PROGRAM_SWIFT_NAME = "AssemblyRuntimeSizedStorage";
const ENTRY_POINT_ID = "compute_main";
const SHA256 = /^[a-f0-9]{64}$/u;

main();

function main() {
  const options = parseArguments(process.argv.slice(2));
  assertRegularFile(options.library, "Metal library");
  assertRegularFile(options.handoff, "C1 handoff");
  if (existsSync(options.output)) {
    fail(`output already exists: ${options.output}`);
  }

  const libraryBytes = readFileSync(options.library);
  if (libraryBytes.length === 0) fail("Metal library is empty");
  const handoffBytes = readFileSync(options.handoff, "utf8");
  const handoff = parseJSON(handoffBytes, "C1 handoff");
  validateHandoff(handoff, libraryBytes);

  const semanticSHA256 = sha256(canonicalBytes(handoff.semantic));
  const projectionSHA256 = sha256(canonicalBytes(handoff.projection));
  const artifact = {
    schemaVersion: 1,
    contractId: ARTIFACT_CONTRACT,
    artifactID: ARTIFACT_ID,
    abi: {
      semanticSchemaVersion: 1,
      metalProjectionABI: 1,
      generatedSwiftABI: 1,
      bindingLayoutABI: 1,
      requiredVGPUABIVersion: 1,
    },
    semantic: { sha256: semanticSHA256 },
    projection: { sha256: projectionSHA256 },
    library: { sha256: handoff.evidence.metallibSha256 },
    runtimeManifest: handoff.runtimeManifest,
    evidence: handoff.evidence,
  };
  const descriptorBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const descriptorSHA256 = sha256(descriptorBytes);

  mkdirSync(options.output);
  const templates = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../templates"
  );
  const appShaders = join(options.output, "AppShaders");
  const cleanConsumer = join(options.output, "CleanConsumer");
  cpSync(join(templates, "AppShaders"), appShaders, { recursive: true });
  cpSync(join(templates, "CleanConsumer"), cleanConsumer, { recursive: true });

  const generatedSwiftPath = join(
    appShaders,
    "Sources/AppShaders/AppShaders.generated.swift"
  );
  const generatedSwift = substituteTemplate(
    readFileSync(generatedSwiftPath, "utf8"),
    new Map([
      ["__PROGRAM_SWIFT_NAME__", PROGRAM_SWIFT_NAME],
      ["__DESCRIPTOR_SHA256__", descriptorSHA256],
      ["__LIBRARY_SHA256__", handoff.evidence.metallibSha256],
    ])
  );
  writeFileSync(generatedSwiftPath, generatedSwift, "utf8");

  const resources = join(appShaders, "Sources/AppShaders/Resources");
  mkdirSync(resources);
  writeFileSync(join(resources, "AppShaders.artifact.json"), descriptorBytes);
  writeFileSync(join(resources, "AppShaders.metallib"), libraryBytes);

  const report = {
    schemaVersion: 1,
    artifactID: ARTIFACT_ID,
    descriptorSHA256,
    librarySHA256: handoff.evidence.metallibSha256,
    semanticSHA256,
    projectionSHA256,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function parseArguments(arguments_) {
  const expected = ["--library", "--handoff", "--output"];
  if (arguments_.length !== expected.length * 2) usage();
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !expected.includes(name) ||
      typeof value !== "string" ||
      value.length === 0
    ) {
      usage();
    }
    const key = name.slice(2);
    if (Object.hasOwn(values, key)) usage();
    values[key] = resolve(value);
  }
  if (!expected.every((name) => Object.hasOwn(values, name.slice(2)))) usage();
  return values;
}

function usage() {
  fail(
    "usage: assemble.mjs --library <library.metallib> --handoff <handoff.json> --output <directory>"
  );
}

function validateHandoff(handoff, libraryBytes) {
  expectPlainObject(handoff, "handoff");
  expectKeys(
    handoff,
    [
      "schemaVersion",
      "contractId",
      "semantic",
      "projection",
      "runtimeManifest",
      "evidence",
    ],
    "handoff"
  );
  expect(handoff.schemaVersion === 1, "handoff schemaVersion must be 1");
  expect(
    handoff.contractId === HANDOFF_CONTRACT,
    "handoff contractId is unsupported"
  );
  assertNoAbsolutePaths(handoff);

  expectPlainObject(handoff.evidence, "handoff evidence");
  expectKeys(
    handoff.evidence,
    ["requestSha256", "responseSha256", "mslSha256", "metallibSha256"],
    "handoff evidence"
  );
  for (const [name, digest] of Object.entries(handoff.evidence)) {
    expectSHA256(digest, `handoff evidence.${name}`);
  }
  expect(
    sha256(libraryBytes) === handoff.evidence.metallibSha256,
    "Metal library bytes do not match evidence.metallibSha256"
  );

  validateSemantic(handoff.semantic);
  validateProjection(handoff.projection);
  validateRuntimeManifest(handoff.runtimeManifest, handoff.projection);
}

function validateSemantic(semantic) {
  expectPlainObject(semantic, "semantic model");
  expect(semantic.schemaVersion === 1, "semantic schemaVersion must be 1");
  expect(
    semantic.contractId === "vgpu-native-semantic/v1",
    "semantic contractId is unsupported"
  );
  expect(
    semantic.module?.name === "AssemblyFixtures",
    "semantic module name drifted"
  );
  expect(
    semantic.module?.swiftName === "AssemblyFixtures",
    "semantic module Swift name drifted"
  );
  expect(
    semantic.abi?.bindingLayout === 1,
    "semantic binding-layout ABI drifted"
  );
  expect(
    semantic.abi?.generatedSwift === 1,
    "semantic generated-Swift ABI drifted"
  );
  expect(
    semantic.abi?.vgpuABI?.product === "VGPUABI",
    "semantic VGPUABI product drifted"
  );
  expect(
    semantic.abi?.vgpuABI?.requiredVersion === 1,
    "semantic VGPUABI version drifted"
  );
  expect(
    semantic.layoutModel === "wgsl-host-shareable-v1",
    "semantic layout model drifted"
  );
  expect(
    Array.isArray(semantic.programs) && semantic.programs.length === 1,
    "semantic handoff must contain one program"
  );

  const program = semantic.programs[0];
  expect(program.name === PROGRAM_SWIFT_NAME, "semantic program name drifted");
  expect(
    program.swiftName === PROGRAM_SWIFT_NAME,
    "semantic program Swift name drifted"
  );
  expect(program.kind === "compute", "semantic program must be compute");
  expectSHA256(program.fingerprint?.sha256, "semantic program fingerprint");
  const entry = program.entryPoints?.compute;
  expect(
    entry?.origin === "authored",
    "semantic compute entry must be authored"
  );
  expect(
    entry?.names?.wgsl === ENTRY_POINT_ID,
    "semantic compute entry point drifted"
  );
  expect(
    entry?.names?.authored === ENTRY_POINT_ID,
    "semantic authored entry point drifted"
  );
  expect(
    deepEqual(entry?.bindings, ["g0b0", "g0b1"]),
    "semantic entry bindings drifted"
  );
  expect(
    deepEqual(entry?.workgroupSize, { x: 1, y: 1, z: 1 }),
    "semantic workgroup size drifted"
  );

  expect(
    Array.isArray(program.bindings) && program.bindings.length === 2,
    "semantic program bindings drifted"
  );
  const values = program.bindings[0];
  const output = program.bindings[1];
  validateSemanticBinding(values, {
    id: "g0b0",
    swiftName: "values",
    access: "read",
    minimumBindingSize: 16,
  });
  validateSemanticBinding(output, {
    id: "g0b1",
    swiftName: "output",
    access: "read_write",
    minimumBindingSize: 8,
  });

  const types = semantic.types;
  const layouts = semantic.layouts;
  expectPlainObject(types, "semantic types");
  expectPlainObject(layouts, "semantic layouts");
  const structTypes = Object.values(types).filter(
    (type) => type?.kind === "struct"
  );
  expect(
    deepEqual(structTypes.map((type) => type.swiftName).sort(), [
      "Particle",
      "Values",
    ]),
    "semantic generated struct surface drifted"
  );
  const particle = structTypes.find((type) => type.swiftName === "Particle");
  const valuesType = structTypes.find((type) => type.swiftName === "Values");
  expect(
    deepEqual(
      particle?.members?.map((member) => [member.name, member.swiftName]),
      [
        ["mass", "mass"],
        ["id", "id"],
      ]
    ),
    "Particle members drifted"
  );
  expect(
    deepEqual(
      valuesType?.members?.map((member) => [member.name, member.swiftName]),
      [
        ["prefix", "prefix"],
        ["particles", "particles"],
      ]
    ),
    "Values members drifted"
  );

  const rootLayout = layouts[values.layout];
  expect(
    rootLayout?.runtimeSized === true,
    "Values layout must be runtime-sized"
  );
  expect(rootLayout?.minimumSize === 4, "Values prefix size drifted");
  const prefix = rootLayout?.members?.[0];
  const tail = rootLayout?.members?.[1];
  expect(
    prefix?.name === "prefix" && prefix.offset === 0 && prefix.size === 4,
    "Values prefix layout drifted"
  );
  expect(
    tail?.name === "particles" &&
      tail.offset === 4 &&
      tail.runtimeSized === true,
    "Values runtime tail layout drifted"
  );
  const tailLayout = layouts[tail?.layout];
  expect(
    tailLayout?.runtimeSized === true,
    "Values tail array must be runtime-sized"
  );
  expect(tailLayout?.arrayStride === 12, "Values tail stride drifted");
  const particleLayout = layouts[tailLayout?.elementLayout];
  expect(particleLayout?.size === 12, "Particle layout size drifted");
  expect(
    deepEqual(
      particleLayout?.members?.map((member) => [member.name, member.offset]),
      [
        ["mass", 0],
        ["id", 8],
      ]
    ),
    "Particle member offsets drifted"
  );
  const outputLayout = layouts[output.layout];
  expect(
    outputLayout?.runtimeSized === false && outputLayout?.size === 8,
    "output layout drifted"
  );
}

function validateSemanticBinding(binding, expected) {
  expect(
    binding?.id === expected.id,
    `semantic binding ${expected.id} identity drifted`
  );
  expect(
    binding?.swiftName === expected.swiftName,
    `semantic binding ${expected.id} Swift name drifted`
  );
  expect(
    binding?.kind === "buffer",
    `semantic binding ${expected.id} kind drifted`
  );
  expect(
    binding?.addressSpace === "storage",
    `semantic binding ${expected.id} address space drifted`
  );
  expect(
    binding?.access === expected.access,
    `semantic binding ${expected.id} access drifted`
  );
  expect(
    binding?.minimumBindingSize === expected.minimumBindingSize,
    `semantic binding ${expected.id} minimum size drifted`
  );
  expect(
    deepEqual(binding?.visibility, ["compute"]),
    `semantic binding ${expected.id} visibility drifted`
  );
}

function validateProjection(projection) {
  expectPlainObject(projection, "Metal projection");
  expect(
    projection.semanticProgram === PROGRAM_SWIFT_NAME,
    "projection program drifted"
  );
  expect(projection.kind === "compute", "projection kind drifted");
  expect(
    Array.isArray(projection.entryPoints) &&
      projection.entryPoints.length === 1,
    "projection entry points drifted"
  );
  expect(
    deepEqual(projection.entryPoints[0], {
      stage: "compute",
      wgsl: ENTRY_POINT_ID,
      metal: "vgpu_assembly_runtime_sized_storage_compute",
      interface: { kind: "compute" },
    }),
    "projection compute entry drifted"
  );
  expect(
    Array.isArray(projection.bindings) && projection.bindings.length === 2,
    "projection bindings drifted"
  );
  validateProjectedSlot(projection.bindings[0], "g0b0", 0);
  validateProjectedSlot(projection.bindings[1], "g0b1", 1);
  expect(
    Array.isArray(projection.internalBindings) &&
      projection.internalBindings.length === 1,
    "projection internal bindings drifted"
  );
  expect(
    projection.internalBindings[0]?.role === "immediate-data",
    "projection immediate-data role drifted"
  );
  validateDirectSlot(
    projection.internalBindings[0]?.slots?.[0],
    30,
    "projection immediate-data"
  );
  expect(
    deepEqual(projection.storageBufferSizeRegions, [
      { stage: "compute", immediateDataByteOffset: 4 },
    ]),
    "projection storage-size region drifted"
  );
  expect(
    deepEqual(projection.resolvedWorkgroupSize, { x: 1, y: 1, z: 1 }),
    "projection workgroup size drifted"
  );
  expect(
    deepEqual(projection.deviceRequirements, {
      features: [],
      limits: [],
      formats: [],
    }),
    "projection device requirements drifted"
  );
}

function validateRuntimeManifest(manifest, projection) {
  expectPlainObject(manifest, "runtime manifest");
  expect(
    manifest.schemaVersion === 1,
    "runtime manifest schemaVersion must be 1"
  );
  expect(
    manifest.immediateDataLayoutModel === "vgpu-metal-immediate-data-layout-v1",
    "runtime manifest immediate-data model drifted"
  );
  expect(
    manifest.storageBufferSizeModel ===
      "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
    "runtime manifest storage-size model drifted"
  );
  expect(
    manifest.semanticProgram === PROGRAM_SWIFT_NAME,
    "runtime manifest program drifted"
  );
  expect(manifest.kind === "compute", "runtime manifest kind drifted");
  expect(
    deepEqual(
      manifest.entryPoints,
      projection.entryPoints.map(({ stage, metal }) => ({ stage, metal }))
    ),
    "runtime manifest entry points do not match projection"
  );
  expect(
    Array.isArray(manifest.bindings) && manifest.bindings.length === 2,
    "runtime manifest bindings drifted"
  );
  validateManifestBinding(manifest.bindings[0], projection.bindings[0], {
    semanticBinding: "g0b0",
    access: "read",
    minimumBindingSize: 16,
    runtimeSized: true,
  });
  validateManifestBinding(manifest.bindings[1], projection.bindings[1], {
    semanticBinding: "g0b1",
    access: "read_write",
    minimumBindingSize: 8,
    runtimeSized: false,
  });
  expect(
    deepEqual(manifest.samplingPairs, []),
    "runtime manifest sampling pairs drifted"
  );
  expect(
    deepEqual(manifest.internalBindings, projection.internalBindings),
    "runtime manifest internal bindings do not match projection"
  );
  expect(
    deepEqual(
      manifest.storageBufferSizeRegions,
      projection.storageBufferSizeRegions
    ),
    "runtime manifest size regions do not match projection"
  );
  expect(
    deepEqual(manifest.resolvedWorkgroupSize, projection.resolvedWorkgroupSize),
    "runtime manifest workgroup size does not match projection"
  );
}

function validateManifestBinding(binding, projected, expected) {
  expect(
    binding?.semanticBinding === expected.semanticBinding,
    `runtime binding ${expected.semanticBinding} identity drifted`
  );
  expect(
    deepEqual(binding?.slots, projected?.slots),
    `runtime binding ${expected.semanticBinding} slots do not match projection`
  );
  expect(
    deepEqual(binding?.descriptor, {
      kind: "buffer",
      addressSpace: "storage",
      access: expected.access,
      minimumBindingSize: expected.minimumBindingSize,
      runtimeSized: expected.runtimeSized,
    }),
    `runtime binding ${expected.semanticBinding} descriptor drifted`
  );
}

function validateProjectedSlot(binding, semanticBinding, index) {
  expect(
    binding?.semanticBinding === semanticBinding,
    `projection binding ${semanticBinding} identity drifted`
  );
  expect(
    Array.isArray(binding?.slots) && binding.slots.length === 1,
    `projection binding ${semanticBinding} slots drifted`
  );
  validateDirectSlot(
    binding.slots[0],
    index,
    `projection binding ${semanticBinding}`
  );
}

function validateDirectSlot(slot, index, label) {
  expect(
    deepEqual(slot, {
      stage: "compute",
      mode: "direct",
      resourceClass: "buffer",
      component: "buffer",
      index,
      count: 1,
    }),
    `${label} slot drifted`
  );
}

function substituteTemplate(template, replacements) {
  let result = template;
  for (const [token, value] of replacements) {
    expect(
      result.split(token).length === 2,
      `template token ${token} must occur exactly once`
    );
    result = result.replace(token, value);
  }
  expect(
    !result.includes("__"),
    "generated Swift contains an unsubstituted template token"
  );
  return result;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)));
}

function canonicalValue(value) {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const normalizedKeys = keys.map((key) => key.normalize("NFC"));
    expect(
      keys.every((key, index) => key === normalizedKeys[index]),
      "canonical input contains a non-NFC object key"
    );
    expect(
      new Set(normalizedKeys).size === normalizedKeys.length,
      "canonical input contains colliding normalized object keys"
    );
    return Object.fromEntries(
      normalizedKeys
        .sort()
        .map((key) => [key.normalize("NFC"), canonicalValue(value[key])])
    );
  }
  return value;
}

function assertNoAbsolutePaths(value) {
  if (typeof value === "string") {
    expect(
      !isAbsolute(value) &&
        !/^file:\/\//u.test(value) &&
        !/^[a-zA-Z]:[\\/]/u.test(value) &&
        !/^\\\\/u.test(value),
      "handoff contains an absolute path"
    );
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoAbsolutePaths(item);
    return;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) assertNoAbsolutePaths(item);
  }
}

function parseJSON(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label} does not exist: ${path}`);
  }
  expect(stat.isFile(), `${label} must be a regular, non-symlink file`);
}

function expectKeys(value, expected, label) {
  expect(
    deepEqual(Object.keys(value), expected),
    `${label} has unexpected or reordered properties`
  );
}

function expectPlainObject(value, label) {
  expect(isPlainObject(value), `${label} must be an object`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectSHA256(value, label) {
  expect(
    typeof value === "string" && SHA256.test(value),
    `${label} must be a lowercase SHA-256 digest`
  );
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  process.stderr.write(`c3-connected-artifact assembler: ${message}\n`);
  process.exit(1);
}
