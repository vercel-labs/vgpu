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
const runtimeSupportedStorageBufferSizeModel =
  "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1";

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
    storageBufferSizeModel: runtimeSupportedStorageBufferSizeModel,
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
      "--storage-buffer-size-model": "storageBufferSizeModel",
    }[name];
    if (!key) fail(`unknown option ${name}`);
    options[key] = value;
  }

  if (!options.output) fail("--output is required");
  if (!/^[a-z][a-z0-9-]*$/.test(options.payloadKind)) {
    fail(`invalid payload kind ${options.payloadKind}`);
  }
  if (
    !/^vgpu-metal-[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/.test(
      options.storageBufferSizeModel
    )
  ) {
    fail(`invalid storage-buffer-size model ${options.storageBufferSizeModel}`);
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
    vertexBufferPolicy: projection.vertexBufferPolicy,
    storageBufferSizeModel: projection.storageBufferSizeModel,
    library: {
      path: projection.library.path,
      sha256: librarySHA256,
    },
    programs: projection.programs,
    deviceRequirements: projection.deviceRequirements,
  };
}

function validateVertexBufferPolicy(projection) {
  const ceiling = projection.vertexBufferPolicy?.externalBufferCeiling;
  if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
    fail("vertex-buffer policy has an invalid external ceiling");
  }
  for (const program of projection.programs) {
    for (const binding of program.bindings) {
      for (const slot of binding.slots) {
        if (slot.stage !== "vertex" || slot.resourceClass !== "buffer") {
          continue;
        }
        const end = slot.index + slot.count;
        if (!Number.isSafeInteger(end) || end > ceiling) {
          fail(
            `${program.semanticProgram}/${binding.semanticBinding} external vertex buffer interval ends at ${end}, above ceiling ${ceiling}`
          );
        }
      }
    }
    for (const internal of program.internalBindings) {
      for (const slot of internal.slots) {
        if (
          slot.stage === "vertex" &&
          slot.resourceClass === "buffer" &&
          slot.index < ceiling
        ) {
          fail(
            `${program.semanticProgram}/${internal.role} internal vertex buffer interval starts at ${slot.index}, below ceiling ${ceiling}`
          );
        }
      }
    }
  }
}

const canonicalStageOrder = ["vertex", "fragment", "compute"];

function shaderInterfaceValueKey(value, includeBlendSource) {
  if (Object.hasOwn(value, "location")) {
    const blendSource =
      includeBlendSource && Object.hasOwn(value, "blendSource")
        ? value.blendSource
        : "none";
    return `location:${value.location}:blend-source:${blendSource}`;
  }
  return `builtin:${value.builtin}`;
}

function validateSemanticInterfaceValues(values, owner, includeBlendSource) {
  const keys = new Set();
  for (const value of values) {
    const key = shaderInterfaceValueKey(value, includeBlendSource);
    if (keys.has(key)) fail(`${owner} repeats shader interface value ${key}`);
    keys.add(key);
  }
}

function validateSemanticStageLink(program) {
  const entries = Object.values(program.entryPoints);
  for (const entry of entries) {
    validateSemanticInterfaceValues(
      entry.inputs,
      `${program.name}/${entry.stage} inputs`,
      false
    );
    validateSemanticInterfaceValues(
      entry.outputs,
      `${program.name}/${entry.stage} outputs`,
      entry.stage === "fragment"
    );
  }

  const fragment = entries.find((entry) => entry.stage === "fragment");
  if (!fragment) return;
  const vertex = entries.find((entry) => entry.stage === "vertex");
  if (!vertex) fail(`${program.name} fragment entry has no vertex entry`);

  const vertexOutputs = new Map(
    vertex.outputs
      .filter((value) => Object.hasOwn(value, "location"))
      .map((value) => [value.location, value])
  );
  for (const input of fragment.inputs.filter((value) =>
    Object.hasOwn(value, "location")
  )) {
    const output = vertexOutputs.get(input.location);
    if (!output) {
      fail(
        `${program.name} fragment location ${input.location} has no vertex output`
      );
    }
    if (
      output.type !== input.type ||
      canonicalize(output.interpolation) !== canonicalize(input.interpolation)
    ) {
      fail(
        `${program.name} location ${input.location} has an incompatible stage link`
      );
    }
  }

  const colors = fragment.outputs.filter((value) =>
    Object.hasOwn(value, "location")
  );
  const dualSourceColors = colors.filter((value) =>
    Object.hasOwn(value, "blendSource")
  );
  if (dualSourceColors.length === 0) return;
  const sources = dualSourceColors.map((value) => value.blendSource).sort();
  if (
    colors.length !== 2 ||
    dualSourceColors.length !== 2 ||
    dualSourceColors.some((value) => value.location !== 0) ||
    sources[0] !== 0 ||
    sources[1] !== 1 ||
    dualSourceColors[0].type !== dualSourceColors[1].type
  ) {
    fail(`${program.name} has an invalid dual-source fragment interface`);
  }
}

function validateShaderInterfaceContract(semantic, projection) {
  if (
    projection.abi?.shaderInterfaceModel !== "vgpu-metal-shader-interface-v1"
  ) {
    fail("unsupported shader-interface model");
  }

  const semanticPrograms = new Map(
    semantic.programs.map((program) => [program.name, program])
  );
  for (const semanticProgram of semantic.programs) {
    validateSemanticStageLink(semanticProgram);
  }

  for (const program of projection.programs) {
    const semanticProgram = semanticPrograms.get(program.semanticProgram);
    if (!semanticProgram) {
      fail(
        `shader-interface contract references unknown program ${program.semanticProgram}`
      );
    }
    const semanticEntries = Object.values(semanticProgram.entryPoints);
    if (program.entryPoints.length !== semanticEntries.length) {
      fail(`${program.semanticProgram} has an incomplete projected entry set`);
    }

    let previousStageRank = -1;
    const projectedEntries = new Set();
    for (const entry of program.entryPoints) {
      const stageRank = canonicalStageOrder.indexOf(entry.stage);
      if (stageRank < 0 || stageRank <= previousStageRank) {
        fail(
          `${program.semanticProgram} entry points are not canonically stage ordered`
        );
      }
      previousStageRank = stageRank;
      const entryKey = `${entry.stage}:${entry.wgsl}`;
      if (projectedEntries.has(entryKey)) {
        fail(`${program.semanticProgram} repeats projected entry ${entryKey}`);
      }
      projectedEntries.add(entryKey);

      const semanticEntry = semanticEntries.find(
        (candidate) =>
          candidate.stage === entry.stage && candidate.names.wgsl === entry.wgsl
      );
      if (!semanticEntry) {
        fail(
          `${program.semanticProgram} projects unknown entry ${entry.stage}/${entry.wgsl}`
        );
      }
      if (entry.interface?.kind !== entry.stage) {
        fail(
          `${program.semanticProgram}/${entry.wgsl} interface kind disagrees with its stage`
        );
      }

      if (entry.stage === "vertex") {
        const expected = semanticEntry.inputs
          .filter((value) => Object.hasOwn(value, "location"))
          .sort((left, right) => left.location - right.location);
        const actual = entry.interface.attributes;
        if (actual.length !== expected.length) {
          fail(
            `${program.semanticProgram}/${entry.wgsl} vertex attribute map is not bijective`
          );
        }
        const metalAttributes = new Set();
        for (let index = 0; index < expected.length; index += 1) {
          const expectedLocation = expected[index].location;
          const projected = actual[index];
          if (projected.semantic.location !== expectedLocation) {
            fail(
              `${program.semanticProgram}/${entry.wgsl} vertex attributes are not canonical or exact`
            );
          }
          if (projected.metal.attribute !== expectedLocation) {
            fail(
              `${program.semanticProgram}/${entry.wgsl} remaps vertex location ${expectedLocation} in interface model v1`
            );
          }
          if (metalAttributes.has(projected.metal.attribute)) {
            fail(
              `${program.semanticProgram}/${entry.wgsl} repeats Metal attribute ${projected.metal.attribute}`
            );
          }
          metalAttributes.add(projected.metal.attribute);
        }
      } else if (entry.stage === "fragment") {
        const rank = (value) =>
          value.location * 3 +
          (Object.hasOwn(value, "blendSource") ? value.blendSource + 1 : 0);
        const expected = semanticEntry.outputs
          .filter((value) => Object.hasOwn(value, "location"))
          .sort((left, right) => rank(left) - rank(right));
        const actual = entry.interface.colorOutputs;
        if (actual.length !== expected.length) {
          fail(
            `${program.semanticProgram}/${entry.wgsl} fragment color map is not bijective`
          );
        }
        const metalColors = new Set();
        for (let index = 0; index < expected.length; index += 1) {
          const expectedValue = expected[index];
          const projected = actual[index];
          const expectedHasSource = Object.hasOwn(expectedValue, "blendSource");
          const projectedHasSource = Object.hasOwn(
            projected.semantic,
            "blendSource"
          );
          const metalHasIndex = Object.hasOwn(projected.metal, "index");
          if (
            projected.semantic.location !== expectedValue.location ||
            expectedHasSource !== projectedHasSource ||
            expectedHasSource !== metalHasIndex ||
            (expectedHasSource &&
              (projected.semantic.blendSource !== expectedValue.blendSource ||
                projected.metal.index !== expectedValue.blendSource))
          ) {
            fail(
              `${program.semanticProgram}/${entry.wgsl} fragment colors are not canonical or exact`
            );
          }
          if (projected.metal.color !== expectedValue.location) {
            fail(
              `${program.semanticProgram}/${entry.wgsl} remaps fragment location ${expectedValue.location} in interface model v1`
            );
          }
          const physicalKey = `${projected.metal.color}:${
            projected.metal.index ?? 0
          }`;
          if (metalColors.has(physicalKey)) {
            fail(
              `${program.semanticProgram}/${entry.wgsl} repeats Metal color ${physicalKey}`
            );
          }
          metalColors.add(physicalKey);
        }
      }
    }
  }
}

function validateStorageBufferSizeContract(semantic, projection) {
  const semanticPrograms = new Map(
    semantic.programs.map((program) => [program.name, program])
  );
  const ceiling = projection.vertexBufferPolicy.externalBufferCeiling;

  for (const program of projection.programs) {
    const semanticProgram = semanticPrograms.get(program.semanticProgram);
    if (!semanticProgram) {
      fail(
        `storage-size contract references unknown program ${program.semanticProgram}`
      );
    }
    if (!Array.isArray(program.storageBufferSizeRegions)) {
      fail(
        `${program.semanticProgram} has no canonical storage-buffer-size region array`
      );
    }

    let previousStageRank = -1;
    const observedStages = new Set();
    for (const region of program.storageBufferSizeRegions) {
      const stageRank = canonicalStageOrder.indexOf(region.stage);
      if (observedStages.has(region.stage)) {
        fail(
          `${program.semanticProgram} repeats storage-buffer-size stage ${region.stage}`
        );
      }
      if (stageRank < 0 || stageRank <= previousStageRank) {
        fail(
          `${program.semanticProgram} storage-buffer-size regions are not canonically stage ordered`
        );
      }
      observedStages.add(region.stage);
      previousStageRank = stageRank;

      if (
        !Number.isSafeInteger(region.immediateDataByteOffset) ||
        region.immediateDataByteOffset < 0 ||
        region.immediateDataByteOffset > 0xffffffff ||
        region.immediateDataByteOffset % 4 !== 0
      ) {
        fail(
          `${program.semanticProgram}/${region.stage} has an invalid immediate-data byte offset`
        );
      }

      const activeBindingIds = new Set(
        Object.values(semanticProgram.entryPoints)
          .filter((entry) => entry.stage === region.stage)
          .flatMap((entry) => entry.bindings)
      );
      const hasActiveRuntimeStorage = semanticProgram.bindings.some(
        (binding) => {
          if (
            !activeBindingIds.has(binding.id) ||
            binding.kind !== "buffer" ||
            binding.addressSpace !== "storage" ||
            !binding.visibility.includes(region.stage) ||
            semantic.layouts[binding.layout]?.runtimeSized !== true
          ) {
            return false;
          }
          return program.bindings.some(
            (projected) =>
              projected.semanticBinding === binding.id &&
              projected.slots.some(
                (slot) =>
                  slot.stage === region.stage &&
                  slot.mode === "direct" &&
                  slot.resourceClass === "buffer" &&
                  slot.component === "buffer" &&
                  slot.count === 1
              )
          );
        }
      );
      if (!hasActiveRuntimeStorage) {
        fail(
          `${program.semanticProgram}/${region.stage} region has no active runtime-sized storage binding`
        );
      }

      const matchingImmediateSlots = program.internalBindings
        .filter((binding) => binding.role === "immediate-data")
        .flatMap((binding) => binding.slots)
        .filter((slot) => slot.stage === region.stage);
      if (matchingImmediateSlots.length !== 1) {
        fail(
          `${program.semanticProgram}/${region.stage} region needs exactly one immediate-data slot`
        );
      }
      const [slot] = matchingImmediateSlots;
      if (
        slot.mode !== "direct" ||
        slot.resourceClass !== "buffer" ||
        slot.component !== "buffer" ||
        slot.count !== 1
      ) {
        fail(
          `${program.semanticProgram}/${region.stage} has an incompatible immediate-data slot`
        );
      }
      if (region.stage === "vertex" && slot.index < ceiling) {
        fail(
          `${program.semanticProgram}/${region.stage} immediate-data starts below the vertex-buffer ceiling`
        );
      }
      const overlapsExternalBuffer = program.bindings.some((binding) =>
        binding.slots.some(
          (external) =>
            external.stage === region.stage &&
            external.resourceClass === "buffer" &&
            slot.index < external.index + external.count &&
            external.index < slot.index + slot.count
        )
      );
      if (overlapsExternalBuffer) {
        fail(
          `${program.semanticProgram}/${region.stage} immediate-data overlaps an external buffer slot`
        );
      }
      const overlapsInternalBuffer = program.internalBindings.some((binding) =>
        binding.slots.some(
          (other) =>
            other !== slot &&
            other.stage === region.stage &&
            other.resourceClass === "buffer" &&
            slot.index < other.index + other.count &&
            other.index < slot.index + slot.count
        )
      );
      if (overlapsInternalBuffer) {
        fail(
          `${program.semanticProgram}/${region.stage} immediate-data overlaps another internal buffer slot`
        );
      }
    }
  }
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
    "shaderInterfaceModel",
    "vertexBufferPolicyModel",
    "storageBufferSizeModel",
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
    const selectionExpression = {
      "noop-compute": "AppShadersArtifact.noopComputeSelection",
      "runtime-array-compute":
        "AppShadersArtifact.runtimeArrayComputeSelection",
    }[mutation.selection ?? "noop-compute"];
    if (!selectionExpression || "program" in mutation || "stage" in mutation) {
      fail(`mutation ${mutation.name} has an unsupported pipeline selection`);
    }
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
          selection: ${selectionExpression},
          runtime: support,
          payloadSHA256: descriptor.librarySHA256
        ) { _ in
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
artifact.projection.storageBufferSizeModel = options.storageBufferSizeModel;
validateVertexBufferPolicy(artifact.projection);
validateStorageBufferSizeContract(artifact.semantic, artifact.projection);
validateShaderInterfaceContract(artifact.semantic, artifact.projection);
artifact.inputs = [
  ["noop-wgsl", "fixtures/noop.wgsl"],
  ["runtime-array-wgsl", "fixtures/runtime-array.wgsl"],
  ["shader-interface-wgsl", "fixtures/shader-interface.wgsl"],
].map(([id, path]) => {
  const bytes = readFileSync(join(fixtureDirectory, ...path.split("/")));
  return {
    id,
    path,
    role: "wgsl",
    size: bytes.byteLength,
    sha256: sha256Bytes(bytes),
  };
});

for (const program of artifact.semantic.programs) {
  program.fingerprint.sha256 = fingerprintProgram(
    program,
    artifact.semantic,
    artifact.inputs
  );
}
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

const runtimeArrayProjection = artifact.projection.programs.find(
  (candidate) => candidate.semanticProgram === "RuntimeArray"
);
const runtimeArrayRegions = runtimeArrayProjection?.storageBufferSizeRegions;
const runtimeArrayEntries = runtimeArrayProjection?.entryPoints.filter(
  (entry) => entry.stage === "compute"
);
const runtimeArrayImmediateSlots = runtimeArrayProjection?.internalBindings
  .filter((binding) => binding.role === "immediate-data")
  .flatMap((binding) => binding.slots);
if (
  runtimeArrayRegions?.length !== 1 ||
  runtimeArrayEntries?.length !== 1 ||
  runtimeArrayImmediateSlots?.length !== 1
) {
  fail(
    "RuntimeArray must have one storage-size region and one immediate-data slot"
  );
}
const [runtimeArrayRegion] = runtimeArrayRegions;
const [runtimeArrayImmediateSlot] = runtimeArrayImmediateSlots;

const sparseDrawProjection = artifact.projection.programs.find(
  (candidate) => candidate.semanticProgram === "SparseDraw"
);
const sparseVertexEntry = sparseDrawProjection?.entryPoints.find(
  (entry) => entry.stage === "vertex"
);
const sparseFragmentEntry = sparseDrawProjection?.entryPoints.find(
  (entry) => entry.stage === "fragment"
);
const sparseVertexAttributes = sparseVertexEntry?.interface.attributes;
const sparseFragmentColors = sparseFragmentEntry?.interface.colorOutputs;
if (
  !sparseDrawProjection ||
  sparseVertexAttributes?.length !== 2 ||
  sparseFragmentColors?.length !== 2
) {
  fail(
    "SparseDraw must preserve two sparse vertex attributes and color outputs"
  );
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
  ["__SHADER_INTERFACE_MODEL__", artifact.projection.abi.shaderInterfaceModel],
  [
    "__VERTEX_BUFFER_POLICY_MODEL__",
    artifact.projection.vertexBufferPolicy.model,
  ],
  [
    "__EXTERNAL_BUFFER_CEILING__",
    String(artifact.projection.vertexBufferPolicy.externalBufferCeiling),
  ],
  ["__STORAGE_BUFFER_SIZE_MODEL__", artifact.projection.storageBufferSizeModel],
  ["__SPARSE_DRAW_SEMANTIC_PROGRAM__", sparseDrawProjection.semanticProgram],
  ["__SPARSE_VERTEX_METAL_ENTRY_POINT__", sparseVertexEntry.metal],
  ["__SPARSE_FRAGMENT_METAL_ENTRY_POINT__", sparseFragmentEntry.metal],
  [
    "__SPARSE_VERTEX_LOCATION_0__",
    String(sparseVertexAttributes[0].semantic.location),
  ],
  [
    "__SPARSE_METAL_ATTRIBUTE_0__",
    String(sparseVertexAttributes[0].metal.attribute),
  ],
  [
    "__SPARSE_VERTEX_LOCATION_1__",
    String(sparseVertexAttributes[1].semantic.location),
  ],
  [
    "__SPARSE_METAL_ATTRIBUTE_1__",
    String(sparseVertexAttributes[1].metal.attribute),
  ],
  [
    "__SPARSE_FRAGMENT_LOCATION_0__",
    String(sparseFragmentColors[0].semantic.location),
  ],
  ["__SPARSE_METAL_COLOR_0__", String(sparseFragmentColors[0].metal.color)],
  [
    "__SPARSE_FRAGMENT_LOCATION_1__",
    String(sparseFragmentColors[1].semantic.location),
  ],
  ["__SPARSE_METAL_COLOR_1__", String(sparseFragmentColors[1].metal.color)],
  ["__NOOP_SEMANTIC_PROGRAM__", noopProjection.semanticProgram],
  [
    "__RUNTIME_ARRAY_SEMANTIC_PROGRAM__",
    runtimeArrayProjection.semanticProgram,
  ],
  ["__RUNTIME_ARRAY_REGION_STAGE__", runtimeArrayRegion.stage],
  ["__RUNTIME_ARRAY_METAL_ENTRY_POINT__", runtimeArrayEntries[0].metal],
  [
    "__RUNTIME_ARRAY_REGION_OFFSET__",
    String(runtimeArrayRegion.immediateDataByteOffset),
  ],
  ["__RUNTIME_ARRAY_INTERNAL_ROLE__", "immediate-data"],
  ["__RUNTIME_ARRAY_INTERNAL_STAGE__", runtimeArrayImmediateSlot.stage],
  ["__RUNTIME_ARRAY_INTERNAL_INDEX__", String(runtimeArrayImmediateSlot.index)],
  ["__RUNTIME_ARRAY_INTERNAL_COUNT__", String(runtimeArrayImmediateSlot.count)],
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
