#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const spikeDirectory = resolve(scriptDirectory, "..");
const sourceDirectory = resolve(spikeDirectory, "../c2-generated-compute");
const overlayDirectory = resolve(spikeDirectory, "runtime-overlay");

const outputFlag = process.argv.indexOf("--output");
if (
  outputFlag === -1 ||
  !process.argv[outputFlag + 1] ||
  process.argv.length !== 4
) {
  throw new Error("usage: prepare-runtime.mjs --output <directory>");
}
const outputDirectory = resolve(process.argv[outputFlag + 1]);
const allowedOutputRoot = resolve(spikeDirectory, ".build");
if (
  existsSync(allowedOutputRoot) &&
  lstatSync(allowedOutputRoot).isSymbolicLink()
) {
  throw new Error("dc1-compute-draw/.build must not be a symbolic link");
}
mkdirSync(allowedOutputRoot, { recursive: true });
const outputRelativePath = relative(allowedOutputRoot, outputDirectory);
if (
  outputRelativePath === "" ||
  outputRelativePath === ".." ||
  outputRelativePath.startsWith(
    `..${process.platform === "win32" ? "\\" : "/"}`
  ) ||
  isAbsolute(outputRelativePath)
) {
  throw new Error("output must be a descendant of dc1-compute-draw/.build");
}
const canonicalOutputRoot = realpathSync(allowedOutputRoot);
let existingAncestor = outputDirectory;
while (!existsSync(existingAncestor)) {
  const parent = dirname(existingAncestor);
  if (parent === existingAncestor) {
    throw new Error("could not resolve an existing output ancestor");
  }
  existingAncestor = parent;
}
const canonicalAncestor = realpathSync(existingAncestor);
const canonicalRelativePath = relative(canonicalOutputRoot, canonicalAncestor);
if (
  canonicalRelativePath === ".." ||
  canonicalRelativePath.startsWith(
    `..${process.platform === "win32" ? "\\" : "/"}`
  ) ||
  isAbsolute(canonicalRelativePath)
) {
  throw new Error("output resolves outside dc1-compute-draw/.build");
}
let checkedPath = outputDirectory;
while (checkedPath !== allowedOutputRoot) {
  if (existsSync(checkedPath) && lstatSync(checkedPath).isSymbolicLink()) {
    throw new Error("output path must not traverse a symbolic link");
  }
  checkedPath = dirname(checkedPath);
}

const replaceOnce = (path, before, after) => {
  const source = readFileSync(path, "utf8");
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`expected exactly one transform anchor in ${path}`);
  }
  writeFileSync(path, source.replace(before, after));
};

const replaceExactly = (path, before, after, expectedCount) => {
  const source = readFileSync(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(
      `expected ${expectedCount} transform anchors in ${path}; found ${count}`
    );
  }
  writeFileSync(path, source.split(before).join(after));
};

const replaceFirst = (path, before, after, expectedCount) => {
  const source = readFileSync(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(
      `expected ${expectedCount} transform anchors in ${path}; found ${count}`
    );
  }
  writeFileSync(path, source.replace(before, after));
};

rmSync(outputDirectory, { force: true, recursive: true });
mkdirSync(outputDirectory, { recursive: true });
cpSync(sourceDirectory, outputDirectory, {
  recursive: true,
  filter: (path) => ![".artifacts", ".build"].includes(path.split("/").at(-1)),
});
cpSync(
  resolve(overlayDirectory, "Sources"),
  resolve(outputDirectory, "Sources"),
  {
    recursive: true,
  }
);

const packagePath = resolve(outputDirectory, "Package.swift");
replaceOnce(
  packagePath,
  '    .library(name: "VGPUCompute", targets: ["VGPUCompute"]),\n',
  '    .library(name: "VGPUCompute", targets: ["VGPUCompute"]),\n' +
    '    .library(name: "VGPURender", targets: ["VGPURender"]),\n'
);
replaceOnce(
  packagePath,
  '    .library(\n      name: "VGPUMetalCompute",\n      targets: [\n',
  '    .library(\n      name: "VGPUMetalRender",\n      targets: [\n' +
    '        "VGPUABI",\n        "VGPUCore",\n        "VGPUResources",\n' +
    '        "VGPURender",\n        "VGPUMetal",\n        "_VGPUMetalCoreImpl",\n' +
    '        "_VGPUMetalResourcesImpl",\n        "_VGPUMetalProgramImpl",\n' +
    '        "_VGPUMetalRenderImpl",\n      ]\n    ),\n' +
    '    .library(name: "VGPUTesting", targets: ["VGPUTesting"]),\n' +
    '    .library(\n      name: "VGPUMetalCompute",\n      targets: [\n'
);
replaceFirst(
  packagePath,
  '        "_VGPUMetalResourcesImpl",\n        "_VGPUMetalComputeImpl",\n',
  '        "_VGPUMetalResourcesImpl",\n        "_VGPUMetalProgramImpl",\n' +
    '        "_VGPUMetalComputeImpl",\n',
  2
);
replaceOnce(
  packagePath,
  '    .executable(name: "RecordingProbe", targets: ["RecordingProbe"]),\n',
  '    .executable(name: "RecordingProbe", targets: ["RecordingProbe"]),\n' +
    '    .executable(name: "DC1RecordingProbe", targets: ["DC1RecordingProbe"]),\n'
);
replaceOnce(
  packagePath,
  '    .target(\n      name: "VGPUCompute",\n      dependencies: ["VGPUABI", "VGPUCore", "_VGPUBackendSPI"]\n    ),\n',
  '    .target(\n      name: "VGPUCompute",\n      dependencies: ["VGPUABI", "VGPUCore", "_VGPUBackendSPI"]\n    ),\n' +
    '    .target(\n      name: "VGPURender",\n      dependencies: ["VGPUABI", "VGPUCore", "_VGPUBackendSPI"]\n    ),\n'
);
replaceOnce(
  packagePath,
  '    .target(name: "GeneratedFixture", dependencies: ["VGPUABI"]),\n',
  '    .target(name: "GeneratedFixture", dependencies: ["VGPUABI"]),\n' +
    '    .target(name: "DC1GeneratedFixture", dependencies: ["VGPUABI"]),\n'
);
replaceOnce(
  packagePath,
  '    .target(\n      name: "_VGPUMetalComputeImpl",\n      dependencies: [\n',
  '    .target(\n      name: "_VGPUMetalProgramImpl",\n' +
    '      dependencies: ["VGPUABI", "_VGPUBackendSPI", "_VGPUMetalCoreImpl"],\n' +
    '      linkerSettings: [.linkedFramework("Metal")]\n    ),\n' +
    '    .target(\n      name: "_VGPUMetalRenderImpl",\n' +
    '      dependencies: [\n        "VGPUABI",\n        "_VGPUBackendSPI",\n' +
    '        "_VGPUMetalCoreImpl",\n        "_VGPUMetalResourcesImpl",\n' +
    '        "_VGPUMetalProgramImpl",\n      ],\n' +
    '      linkerSettings: [.linkedFramework("Metal")]\n    ),\n' +
    '    .target(\n      name: "_VGPUMetalComputeImpl",\n      dependencies: [\n'
);
replaceOnce(
  packagePath,
  '        "_VGPUMetalResourcesImpl",\n      ],\n      linkerSettings: [.linkedFramework("Metal")]\n    ),\n    .target(\n      name: "VGPUMetal",',
  '        "_VGPUMetalResourcesImpl",\n        "_VGPUMetalProgramImpl",\n      ],\n' +
    '      linkerSettings: [.linkedFramework("Metal")]\n    ),\n    .target(\n      name: "VGPUMetal",'
);
replaceOnce(
  packagePath,
  '        "_VGPUMetalResourcesImpl",\n        "_VGPUMetalComputeImpl",\n      ],\n      linkerSettings: [.linkedFramework("Metal")]\n    ),\n    .executableTarget(',
  '        "VGPUMetal",\n        "_VGPUMetalResourcesImpl",\n        "_VGPUMetalProgramImpl",\n' +
    '        "_VGPUMetalComputeImpl",\n        "_VGPUMetalRenderImpl",\n' +
    '        "VGPURender",\n      ],\n      linkerSettings: [.linkedFramework("Metal")]\n    ),\n    .executableTarget('
);
replaceOnce(
  packagePath,
  '    .executableTarget(\n      name: "MetalProbe",\n',
  "    .executableTarget(\n" +
    '      name: "DC1RecordingProbe",\n' +
    "      dependencies: [\n" +
    '        "VGPUABI",\n' +
    '        "VGPUCore",\n' +
    '        "VGPUResources",\n' +
    '        "VGPUCompute",\n' +
    '        "VGPURender",\n' +
    '        "DC1GeneratedFixture",\n' +
    '        "_VGPUBackendSPI",\n' +
    "      ]\n" +
    "    ),\n" +
    '    .executableTarget(\n      name: "MetalProbe",\n'
);

const abiPath = resolve(outputDirectory, "Sources/VGPUABI/ABI.swift");
replaceOnce(
  abiPath,
  "  public let access: VGPUStorageAccess\n  package let _box: any _VGPUStorageBox\n\n  package init(\n    count: Int,\n    sizeInBytes: Int,\n    access: VGPUStorageAccess,\n    box: any _VGPUStorageBox\n  ) {\n    self.count = count\n    self.sizeInBytes = sizeInBytes\n    self.access = access\n    self._box = box\n  }\n",
  "  public let access: VGPUStorageAccess\n  public let additionalUsage: VGPUBufferUsage\n  package let _box: any _VGPUStorageBox\n\n  package init(\n    count: Int,\n    sizeInBytes: Int,\n    access: VGPUStorageAccess,\n    additionalUsage: VGPUBufferUsage,\n    box: any _VGPUStorageBox\n  ) {\n    self.count = count\n    self.sizeInBytes = sizeInBytes\n    self.access = access\n    self.additionalUsage = additionalUsage\n    self._box = box\n  }\n"
);

const resourcesPath = resolve(
  outputDirectory,
  "Sources/VGPUResources/Resources.swift"
);
replaceOnce(
  resourcesPath,
  "        access: .readWrite,\n        initialValues: initialValues\n",
  "        access: .readWrite,\n        initial: initialValues\n"
);
replaceFirst(
  resourcesPath,
  "      let handle = try backend.allocateStorage(initialBytes: bytes, access: access)\n",
  "      let handle = try backend.allocateStorage(\n" +
    "        initialBytes: bytes,\n" +
    "        access: access,\n" +
    "        usage: [.binding]\n" +
    "      )\n",
  2
);
replaceOnce(
  resourcesPath,
  "  public func storage<Element: VGPUScalar>(\n    _ element: Element.Type,\n    count: Int,\n    access: VGPUStorageAccess = .readWrite,\n    initialValues: [Element] = []\n  ) throws -> VGPUStorage<Element> {\n",
  "  public func storage<Element: VGPUScalar>(\n    _ element: Element.Type,\n    count: Int,\n    access: VGPUStorageAccess = .readWrite,\n    additionalUsage: VGPUBufferUsage = [],\n    initial: [Element] = []\n  ) throws -> VGPUStorage<Element> {\n"
);
for (const [before, after] of [
  [
    "guard initialValues.count <= count else",
    "guard initial.count <= count else",
  ],
  ["actual: initialValues.count", "actual: initial.count"],
  [
    "for (index, value) in initialValues.enumerated()",
    "for (index, value) in initial.enumerated()",
  ],
]) {
  replaceOnce(resourcesPath, before, after);
}
replaceOnce(
  resourcesPath,
  "      return VGPUStorage(\n        count: count,\n        sizeInBytes: byteCount,\n        access: access,\n        box: box\n",
  "      return VGPUStorage(\n        count: count,\n        sizeInBytes: byteCount,\n        access: access,\n        additionalUsage: additionalUsage,\n        box: box\n"
);
replaceOnce(
  resourcesPath,
  "      let handle = try backend.allocateStorage(initialBytes: bytes, access: access)\n",
  "      let handle = try backend.allocateStorage(\n" +
    "        initialBytes: bytes,\n" +
    "        access: access,\n" +
    "        usage: [.binding, additionalUsage]\n" +
    "      )\n"
);

const backendPath = resolve(
  outputDirectory,
  "Sources/_VGPUBackendSPI/Backend.swift"
);
replaceOnce(
  backendPath,
  "    initialBytes: Data,\n    access: VGPUStorageAccess\n" +
    "  ) throws -> VGPUBackendStorageHandle\n",
  "    initialBytes: Data,\n    access: VGPUStorageAccess,\n" +
    "    usage: VGPUBufferUsage\n  ) throws -> VGPUBackendStorageHandle\n"
);

const recordingPath = resolve(
  outputDirectory,
  "Sources/RecordingProbe/main.swift"
);
replaceOnce(
  recordingPath,
  "    initialBytes: Data,\n    access: VGPUStorageAccess\n" +
    "  ) throws -> VGPUBackendStorageHandle {\n",
  "    initialBytes: Data,\n    access: VGPUStorageAccess,\n" +
    "    usage _: VGPUBufferUsage\n  ) throws -> VGPUBackendStorageHandle {\n"
);

const metalResourcesPath = resolve(
  outputDirectory,
  "Sources/_VGPUMetalResourcesImpl/MetalResources.swift"
);
replaceExactly(
  metalResourcesPath,
  "    initialBytes: Data,\n    access: VGPUStorageAccess\n" +
    "  ) throws -> VGPUBackendStorageHandle {\n",
  "    initialBytes: Data,\n    access: VGPUStorageAccess,\n" +
    "    usage: VGPUBufferUsage\n  ) throws -> VGPUBackendStorageHandle {\n",
  2
);
replaceOnce(
  metalResourcesPath,
  "    try resourceBackend.allocateStorage(initialBytes: initialBytes, access: access)\n",
  "    try resourceBackend.allocateStorage(\n" +
    "      initialBytes: initialBytes,\n" +
    "      access: access,\n" +
    "      usage: usage\n" +
    "    )\n"
);
replaceOnce(
  metalResourcesPath,
  "    let generation: UInt64\n  }\n",
  "    let generation: UInt64\n    let usage: VGPUBufferUsage\n  }\n"
);
replaceOnce(
  metalResourcesPath,
  "      generation: 1\n    )\n",
  "      generation: 1,\n      usage: usage\n    )\n"
);
replaceOnce(
  metalResourcesPath,
  "  package func contains(allocationIdentity: UInt64) -> Bool {\n",
  "  package func supportsUsage(\n" +
    "    _ usage: VGPUBufferUsage,\n    for snapshot: VGPUBackendStorageSnapshot\n  ) throws -> Bool {\n" +
    "    lock.lock()\n    defer { lock.unlock() }\n" +
    "    guard snapshot.contextIdentity == contextIdentity,\n" +
    "      let allocation = allocations[snapshot.handle],\n" +
    "      allocation.identity == snapshot.allocationIdentity,\n" +
    "      allocation.generation == snapshot.generation\n" +
    "    else { throw MetalResourceBackendError.missingAllocation }\n" +
    "    return allocation.usage.contains(usage)\n  }\n\n" +
    "  package func contains(allocationIdentity: UInt64) -> Bool {\n"
);
replaceOnce(
  metalResourcesPath,
  "  ) async throws -> Data {\n    let buffer = try checkedBuffer(handle: handle, range: range)\n",
  "  ) async throws -> Data {\n" +
    "    if isIndirectAllocation(handle) { DC1MetalAudit.shared.recordPacketRead() }\n" +
    "    let buffer = try checkedBuffer(handle: handle, range: range)\n"
);
replaceOnce(
  metalResourcesPath,
  "  private func checkedBuffer(\n",
  "  private func isIndirectAllocation(_ handle: VGPUBackendStorageHandle) -> Bool {\n" +
    "    lock.lock()\n    defer { lock.unlock() }\n" +
    "    return allocations[handle]?.usage.contains(.indirect) == true\n  }\n\n" +
    "  private func checkedBuffer(\n"
);

const metalComputePath = resolve(
  outputDirectory,
  "Sources/_VGPUMetalComputeImpl/MetalCompute.swift"
);
replaceOnce(
  metalComputePath,
  "    try computeBackend.prepareCompute(program)\n",
  '    if program.artifactID == "dc1-compute-draw" {\n' +
    "      return try dc1ComputeBackend.prepare(program)\n    }\n" +
    "    return try computeBackend.prepareCompute(program)\n"
);
replaceOnce(
  metalComputePath,
  "    try computeBackend.submitCompute(command)\n",
  '    if command.program.artifactID == "dc1-compute-draw" {\n' +
    "      return try dc1ComputeBackend.submit(command)\n    }\n" +
    "    return try computeBackend.submitCompute(command)\n"
);

const metalHarnessPath = resolve(
  outputDirectory,
  "Sources/VGPUTesting/MetalHarness.swift"
);
replaceOnce(
  metalHarnessPath,
  "    initialBytes: Data,\n    access: VGPUStorageAccess\n" +
    "  ) throws -> VGPUBackendStorageHandle {\n",
  "    initialBytes: Data,\n    access: VGPUStorageAccess,\n" +
    "    usage: VGPUBufferUsage\n  ) throws -> VGPUBackendStorageHandle {\n"
);
replaceOnce(
  metalHarnessPath,
  "    try resources.allocateStorage(initialBytes: initialBytes, access: access)\n",
  "    try resources.allocateStorage(\n" +
    "      initialBytes: initialBytes,\n" +
    "      access: access,\n" +
    "      usage: usage\n" +
    "    )\n"
);

console.log(outputDirectory);
