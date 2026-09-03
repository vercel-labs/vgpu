#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(scriptDirectory, "..");
const defaultRepository = resolve(fixtureDirectory, "..", "..", "..");

function fail(message) {
  throw new Error(`C3 verify: ${message}`);
}

function parseArguments(argv) {
  const options = {
    repository: defaultRepository,
    inputsRoot: fixtureDirectory,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      fail(`expected --name value pairs, received ${name ?? "<nothing>"}`);
    }
    const key = {
      "--package": "packageRoot",
      "--repository": "repository",
      "--inputs-root": "inputsRoot",
    }[name];
    if (!key) fail(`unknown option ${name}`);
    options[key] = value;
  }
  if (!options.packageRoot) fail("--package is required");
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => [key, resolve(value)])
  );
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

function assertEqual(actual, expected, label) {
  if (actual !== expected)
    fail(`${label}: expected ${expected}, received ${actual}`);
}

function assertIncludes(contents, expected, label) {
  if (!contents.includes(expected)) fail(`${label}: missing ${expected}`);
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

function assertProgramFingerprintSensitivity(program, semantic, inputs) {
  const baseline = fingerprintProgram(program, semantic, inputs);
  const assertChanged = (actual, label) => {
    if (actual === baseline)
      fail(`${program.name} fingerprint ignored ${label}`);
  };

  const changedInputs = clone(inputs);
  const referencedInput = changedInputs.find(
    (input) => input.id === program.sources[0]
  );
  if (!referencedInput) {
    fail(`${program.name} fingerprint sensitivity has no referenced input`);
  }
  referencedInput.sha256 = "f".repeat(64);
  assertChanged(
    fingerprintProgram(program, semantic, changedInputs),
    "referenced WGSL hash"
  );

  const changedLayoutModel = clone(semantic);
  changedLayoutModel.layoutModel = `${semantic.layoutModel}-changed`;
  assertChanged(
    fingerprintProgram(program, changedLayoutModel, inputs),
    "layout model"
  );

  const changedLanguageFeatures = clone(semantic);
  changedLanguageFeatures.capabilities.languageFeatures = [
    ...semantic.capabilities.languageFeatures,
    "c3_fingerprint_probe",
  ];
  assertChanged(
    fingerprintProgram(program, changedLanguageFeatures, inputs),
    "language features"
  );

  const changedReachableLayout = clone(semantic);
  const reachableLayouts = Object.keys(
    reachableTypeAndLayoutClosure(program, semantic).layouts
  );
  if (reachableLayouts.length === 0) {
    fail(`${program.name} fingerprint sensitivity needs a reachable layout`);
  }
  const directlyReachableLayoutId = program.bindings
    .map((binding) => binding.layout)
    .find((id) => id !== undefined && reachableLayouts.includes(id));
  if (!directlyReachableLayoutId) {
    fail(
      `${program.name} fingerprint sensitivity needs a directly reachable layout`
    );
  }
  changedReachableLayout.layouts[directlyReachableLayoutId].minimumSize += 1;
  assertChanged(
    fingerprintProgram(program, changedReachableLayout, inputs),
    "reachable intrinsic layout"
  );

  const elementalTypeId = Object.keys(
    reachableTypeAndLayoutClosure(program, semantic).types
  )
    .map((id) => semantic.types[id].element)
    .find((id) => id !== undefined);
  const elementalLayoutId = Object.keys(semantic.layouts).find(
    (id) => semantic.layouts[id].type === elementalTypeId
  );
  if (
    !elementalTypeId ||
    !elementalLayoutId ||
    !reachableLayouts.includes(elementalLayoutId)
  ) {
    fail(
      `${program.name} fingerprint sensitivity needs a transitively reachable elemental layout`
    );
  }
  const changedElementalLayout = clone(semantic);
  changedElementalLayout.layouts[elementalLayoutId].minimumSize += 1;
  assertChanged(
    fingerprintProgram(program, changedElementalLayout, inputs),
    "transitively reachable elemental layout"
  );

  const changedUnreachable = clone(semantic);
  changedUnreachable.types.c3_unreachable = { kind: "scalar", scalar: "u32" };
  changedUnreachable.layouts.c3_unreachable = {
    type: "c3_unreachable",
    alignment: 4,
    minimumSize: 4,
    size: 4,
    runtimeSized: false,
    members: [],
  };
  assertEqual(
    fingerprintProgram(program, changedUnreachable, inputs),
    baseline,
    `${program.name} unreachable type/layout fingerprint exclusion`
  );
}

function runtimeProjectionInput(projection, librarySHA256) {
  return {
    semantic: projection.semantic,
    target: projection.target,
    abi: projection.abi,
    vertexBufferPolicy: projection.vertexBufferPolicy,
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

function requireVertexPolicyMutationFailure(
  projection,
  mutate,
  expectedMessage,
  label
) {
  const candidate = clone(projection);
  mutate(candidate);
  let rejected = false;
  try {
    validateVertexBufferPolicy(candidate);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expectedMessage)) {
      fail(`${label}: unexpected error ${String(error)}`);
    }
    rejected = true;
  }
  if (!rejected) fail(`${label}: mutation was accepted`);
}

function walk(root) {
  const files = [];
  const visit = (directory) => {
    const names = readdirSync(directory).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    for (const name of names) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        fail(`generated tree contains a symlink: ${path}`);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) files.push(path);
      else fail(`generated tree contains a special filesystem entry: ${path}`);
    }
  };
  visit(root);
  return files;
}

function walkDirectories(root) {
  const directories = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        fail(`generated tree contains a symlink: ${path}`);
      if (metadata.isDirectory()) {
        directories.push(path);
        visit(path);
      }
    }
  };
  visit(root);
  return directories;
}

function resolveJSONPointer(document, fragment) {
  if (fragment === "" || fragment === undefined) return document;
  if (!fragment.startsWith("/"))
    fail(`unsupported JSON Schema fragment #${fragment}`);
  return fragment
    .slice(1)
    .split("/")
    .map((part) =>
      decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~")
    )
    .reduce((value, part) => {
      if (value === undefined || value === null || !(part in value)) {
        fail(`unresolved JSON Schema pointer #${fragment}`);
      }
      return value[part];
    }, document);
}

function checkSchemaReferences(schemas) {
  const byId = new Map(schemas.map((schema) => [schema.$id, schema]));
  if (byId.size !== schemas.length)
    fail("JSON Schema $id values are not unique");
  let references = 0;

  const visit = (value, currentSchema) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, currentSchema);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (typeof value.$ref === "string") {
      references += 1;
      const [externalId, fragment] = value.$ref.split("#", 2);
      const target = externalId === "" ? currentSchema : byId.get(externalId);
      if (!target)
        fail(`unresolved external JSON Schema reference ${value.$ref}`);
      resolveJSONPointer(target, fragment);
    }
    for (const child of Object.values(value)) visit(child, currentSchema);
  };

  for (const schema of schemas) visit(schema, schema);
  return references;
}

const options = parseArguments(process.argv.slice(2));
const packageRoot = realpathSync(options.packageRoot);
const artifactPath = join(packageRoot, "artifact.json");
const artifactBytes = readFileSync(artifactPath);
const artifact = JSON.parse(artifactBytes);

const schemaDirectory = join(
  options.repository,
  "docs",
  "plans",
  "native",
  "contracts"
);
const schemaFilenames = [
  "semantic-v1.schema.json",
  "metal-projection-v1.schema.json",
  "artifact-v1.schema.json",
  "metal-runner-request-v1.schema.json",
  "metal-runner-response-v1.schema.json",
];
const schemas = schemaFilenames.map((filename) =>
  JSON.parse(readFileSync(join(schemaDirectory, filename), "utf8"))
);
const referenceCount = checkSchemaReferences(schemas);
const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of schemas) ajv.addSchema(schema);
for (const schema of schemas) {
  if (!ajv.getSchema(schema.$id)) fail(`Ajv did not compile ${schema.$id}`);
}
const validateArtifact = ajv.getSchema(artifact.$schema);
if (!validateArtifact) fail(`no validator for ${artifact.$schema}`);
if (!validateArtifact(artifact)) {
  fail(
    `artifact schema failure:\n${ajv.errorsText(validateArtifact.errors, {
      separator: "\n",
    })}`
  );
}
if ("testing" in artifact.projection) {
  fail("C3 projection must not claim a compare runner");
}

const forbiddenExtensions = new Set([
  ".wgsl",
  ".metal",
  ".msl",
  ".air",
  ".js",
  ".mjs",
  ".cjs",
]);
const excluded = new Set(["artifact.json", ".vgpu-native-output.json"]);
const observedPaths = [];
const allPackagePaths = [];
const caseFoldedPaths = new Set();
for (const path of walk(packageRoot)) {
  const normalized = relative(packageRoot, path)
    .split(sep)
    .join("/")
    .normalize("NFC");
  if (normalized.includes("__"))
    fail(`unresolved placeholder in path ${normalized}`);
  const folded = normalized.toLocaleLowerCase("en-US");
  if (caseFoldedPaths.has(folded))
    fail(`case-insensitive path collision at ${normalized}`);
  caseFoldedPaths.add(folded);
  if (forbiddenExtensions.has(extname(normalized).toLowerCase())) {
    fail(`forbidden generated source/intermediate ${normalized}`);
  }
  if (
    /(^|\/)(?:\.build|\.swiftpm)(\/|$)/.test(normalized) ||
    normalized === "Package.resolved"
  ) {
    fail(`generated tree contains build or resolution residue ${normalized}`);
  }
  allPackagePaths.push(normalized);
  if (!excluded.has(normalized)) observedPaths.push(normalized);
}
allPackagePaths.sort((left, right) =>
  left < right ? -1 : left > right ? 1 : 0
);
const allowedPackagePaths = [
  ".vgpu-native-output.json",
  "Package.swift",
  "Sources/AppShaders/AppShaders.generated.swift",
  "Sources/AppShaders/Resources/AppShaders.metallib",
  "Sources/AppShadersC3MetalProbe/main.swift",
  "Tests/AppShadersTests/ArtifactCompatibilityTests.swift",
  "Tests/AppShadersTests/MutationMatrix.generated.swift",
  "artifact.json",
].sort();
const observedDirectories = walkDirectories(packageRoot)
  .map((path) =>
    relative(packageRoot, path).split(sep).join("/").normalize("NFC")
  )
  .sort();
const allowedDirectories = [
  "Sources",
  "Sources/AppShaders",
  "Sources/AppShaders/Resources",
  "Sources/AppShadersC3MetalProbe",
  "Tests",
  "Tests/AppShadersTests",
].sort();
assertEqual(
  JSON.stringify(observedDirectories),
  JSON.stringify(allowedDirectories),
  "generated package directory allowlist"
);
assertEqual(
  JSON.stringify(allPackagePaths),
  JSON.stringify(allowedPackagePaths),
  "generated package allowlist"
);
observedPaths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

const manifestPaths = artifact.files.map((file) => file.path);
assertEqual(
  JSON.stringify(manifestPaths),
  JSON.stringify(observedPaths),
  "artifact file set"
);
for (const file of artifact.files) {
  const bytes = readFileSync(join(packageRoot, ...file.path.split("/")));
  assertEqual(bytes.byteLength, file.size, `${file.path} size`);
  assertEqual(sha256Bytes(bytes), file.sha256, `${file.path} SHA-256`);
}

for (const input of artifact.inputs) {
  const path = join(options.inputsRoot, ...input.path.split("/"));
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile())
    fail(`invalid input path ${input.path}`);
  const bytes = readFileSync(path);
  assertEqual(bytes.byteLength, input.size, `${input.path} input size`);
  assertEqual(sha256Bytes(bytes), input.sha256, `${input.path} input SHA-256`);
}

const inputIds = new Map();
for (const input of artifact.inputs) {
  if (inputIds.has(input.id)) fail(`duplicate input id ${input.id}`);
  inputIds.set(input.id, input);
}
const typeIds = new Set(Object.keys(artifact.semantic.types));
const layoutIds = new Set(Object.keys(artifact.semantic.layouts));
const requireType = (type, owner) => {
  if (!typeIds.has(type)) fail(`${owner} references unknown type ${type}`);
};
const requireLayout = (layout, owner) => {
  if (!layoutIds.has(layout))
    fail(`${owner} references unknown layout ${layout}`);
};

for (const [typeId, type] of Object.entries(artifact.semantic.types)) {
  if ("element" in type) requireType(type.element, `type ${typeId}`);
  for (const member of type.members ?? []) {
    requireType(member.type, `type ${typeId} member ${member.name}`);
  }
}
for (const [layoutId, layout] of Object.entries(artifact.semantic.layouts)) {
  requireType(layout.type, `layout ${layoutId}`);
  for (const member of layout.members) {
    requireType(member.type, `layout ${layoutId} member ${member.name}`);
    requireLayout(member.layout, `layout ${layoutId} member ${member.name}`);
  }
}

for (const program of artifact.semantic.programs) {
  assertEqual(
    program.fingerprint.sha256,
    fingerprintProgram(program, artifact.semantic, artifact.inputs),
    `${program.name} fingerprint`
  );
  for (const source of program.sources) {
    const input = inputIds.get(source);
    if (!input || input.role !== "wgsl")
      fail(`${program.name} source ${source} is not a WGSL input`);
  }
  const bindingIds = new Set();
  for (const binding of program.bindings) {
    if (bindingIds.has(binding.id))
      fail(`${program.name} repeats binding ${binding.id}`);
    bindingIds.add(binding.id);
    assertEqual(
      binding.id,
      `g${binding.group}b${binding.binding}`,
      `${program.name} binding identity`
    );
    if (binding.kind === "buffer") {
      requireType(binding.type, `${program.name} binding ${binding.id}`);
      requireLayout(binding.layout, `${program.name} binding ${binding.id}`);
      const layout = artifact.semantic.layouts[binding.layout];
      if (binding.minimumBindingSize !== layout.minimumSize) {
        fail(
          `${program.name} binding ${binding.id} minimum size disagrees with its layout`
        );
      }
    }
  }
  const bindingsById = new Map(
    program.bindings.map((binding) => [binding.id, binding])
  );
  const overrideIds = new Set();
  for (const override of program.overrides) {
    if (overrideIds.has(override.id))
      fail(`${program.name} repeats override ${override.id}`);
    overrideIds.add(override.id);
  }
  for (const entry of Object.values(program.entryPoints)) {
    if (entry.source && !program.sources.includes(entry.source.input)) {
      fail(
        `${program.name} entry ${entry.names.wgsl} references an undeclared source`
      );
    }
    for (const value of [...entry.inputs, ...entry.outputs]) {
      requireType(
        value.type,
        `${program.name} entry ${entry.names.wgsl} interface ${value.name}`
      );
    }
    for (const binding of entry.bindings) {
      if (!bindingIds.has(binding)) {
        fail(
          `${program.name} entry ${entry.names.wgsl} references unknown binding ${binding}`
        );
      }
    }
    for (const pair of entry.samplingPairs) {
      const texture = bindingsById.get(pair.texture);
      const sampler = bindingsById.get(pair.sampler);
      if (!texture || !["texture", "external-texture"].includes(texture.kind)) {
        fail(
          `${program.name} entry ${entry.names.wgsl} has invalid sampling texture ${pair.texture}`
        );
      }
      if (!sampler || sampler.kind !== "sampler") {
        fail(
          `${program.name} entry ${entry.names.wgsl} has invalid sampling sampler ${pair.sampler}`
        );
      }
    }
    if (entry.workgroupSize) {
      for (const component of Object.values(entry.workgroupSize)) {
        if (
          component.kind === "override" &&
          !overrideIds.has(component.override)
        ) {
          fail(
            `${program.name} workgroup references unknown override ${component.override}`
          );
        }
      }
    }
  }
  const programFeatures = new Set(program.capabilities.features);
  const rootFeatures = new Set(artifact.semantic.capabilities.features);
  for (const feature of programFeatures) {
    if (!rootFeatures.has(feature))
      fail(
        `${program.name} feature ${feature} is absent from module capabilities`
      );
  }
  const programLanguageFeatures = new Set(
    program.capabilities.languageFeatures
  );
  const rootLanguageFeatures = new Set(
    artifact.semantic.capabilities.languageFeatures
  );
  for (const feature of programLanguageFeatures) {
    if (!rootLanguageFeatures.has(feature)) {
      fail(
        `${program.name} language feature ${feature} is absent from module capabilities`
      );
    }
  }
  assertProgramFingerprintSensitivity(
    program,
    artifact.semantic,
    artifact.inputs
  );
}

const semanticSHA256 = sha256Canonical(artifact.semantic);
assertEqual(
  artifact.fingerprints.semantic.sha256,
  semanticSHA256,
  "semantic fingerprint"
);
assertEqual(
  artifact.projection.semantic.sha256,
  semanticSHA256,
  "projection semantic fingerprint"
);
assertEqual(
  artifact.fingerprints.logicalInputs.sha256,
  sha256Canonical(artifact.inputs),
  "logical inputs fingerprint"
);

const libraryPath = artifact.projection.library.path;
const libraries = artifact.files.filter((file) =>
  file.path.endsWith(".metallib")
);
assertEqual(libraries.length, 1, "projected Metal library count");
assertEqual(libraries[0].path, libraryPath, "projected Metal library path");
const runtimeSHA256 = sha256Canonical(
  runtimeProjectionInput(artifact.projection, libraries[0].sha256)
);
validateVertexBufferPolicy(artifact.projection);
requireVertexPolicyMutationFailure(
  artifact.projection,
  (projection) => {
    const slot = projection.programs[0].bindings[0].slots[0];
    slot.stage = "vertex";
    slot.index = projection.vertexBufferPolicy.externalBufferCeiling;
  },
  "external vertex buffer interval ends",
  "external vertex interval crossing ceiling"
);
requireVertexPolicyMutationFailure(
  artifact.projection,
  (projection) => {
    projection.programs[0].internalBindings.push({
      role: "fixture-internal",
      slots: [
        {
          stage: "vertex",
          mode: "direct",
          resourceClass: "buffer",
          component: "buffer",
          index: projection.vertexBufferPolicy.externalBufferCeiling - 1,
          count: 1,
        },
      ],
    });
  },
  "internal vertex buffer interval starts",
  "internal vertex interval below ceiling"
);
assertEqual(
  artifact.projection.runtimeFingerprint.sha256,
  runtimeSHA256,
  "runtime projection fingerprint"
);
const changedVertexBufferPolicy = clone(artifact.projection);
changedVertexBufferPolicy.vertexBufferPolicy.externalBufferCeiling -= 1;
if (
  sha256Canonical(
    runtimeProjectionInput(changedVertexBufferPolicy, libraries[0].sha256)
  ) === runtimeSHA256
) {
  fail("runtime projection fingerprint excludes vertex-buffer policy");
}

const semanticPrograms = new Map(
  artifact.semantic.programs.map((program) => [program.name, program])
);
for (const program of artifact.projection.programs) {
  const semanticProgram = semanticPrograms.get(program.semanticProgram);
  if (!semanticProgram) {
    fail(
      `projection references unknown semantic program ${program.semanticProgram}`
    );
  }
  if (program.kind !== semanticProgram.kind) {
    fail(
      `projection kind for ${program.semanticProgram} disagrees with semantic contract`
    );
  }
  const semanticBindings = new Set(
    semanticProgram.bindings.map((binding) => binding.id)
  );
  const projectedBindings = new Set();
  for (const binding of program.bindings) {
    if (!semanticBindings.has(binding.semanticBinding)) {
      fail(
        `projection ${program.semanticProgram} references unknown binding ${binding.semanticBinding}`
      );
    }
    if (projectedBindings.has(binding.semanticBinding)) {
      fail(
        `projection ${program.semanticProgram} repeats binding ${binding.semanticBinding}`
      );
    }
    projectedBindings.add(binding.semanticBinding);
  }
  assertEqual(
    JSON.stringify([...projectedBindings].sort()),
    JSON.stringify([...semanticBindings].sort()),
    `${program.semanticProgram} projected binding set`
  );
  const semanticEntries = Object.values(semanticProgram.entryPoints).map(
    (entry) => ({
      stage: entry.stage,
      wgsl: entry.names.wgsl,
    })
  );
  for (const entry of program.entryPoints) {
    if (
      !semanticEntries.some(
        (candidate) =>
          candidate.stage === entry.stage && candidate.wgsl === entry.wgsl
      )
    ) {
      fail(
        `projection ${program.semanticProgram} references unknown entry ${entry.stage}/${entry.wgsl}`
      );
    }
  }
  assertEqual(
    JSON.stringify(
      program.entryPoints.map((entry) => `${entry.stage}:${entry.wgsl}`).sort()
    ),
    JSON.stringify(
      semanticEntries.map((entry) => `${entry.stage}:${entry.wgsl}`).sort()
    ),
    `${program.semanticProgram} projected entry set`
  );
  if (semanticProgram.kind === "compute") {
    const semanticSize = semanticProgram.entryPoints.compute.workgroupSize;
    const resolvedSemanticSize = Object.fromEntries(
      Object.entries(semanticSize).map(([axis, component]) => [
        axis,
        component.value,
      ])
    );
    assertEqual(
      JSON.stringify(program.resolvedWorkgroupSize),
      JSON.stringify(resolvedSemanticSize),
      `${program.semanticProgram} resolved workgroup size`
    );
  }

  const rootDeviceFeatures = new Set(
    artifact.projection.deviceRequirements.features
  );
  for (const feature of program.deviceRequirements.features) {
    if (!rootDeviceFeatures.has(feature)) {
      fail(
        `${program.semanticProgram} Metal feature ${feature} is absent from projection requirements`
      );
    }
  }
}

const buildSHA256 = sha256Canonical({
  compiler: artifact.compiler,
  logicalInputs: artifact.fingerprints.logicalInputs.sha256,
  semantic: semanticSHA256,
  runtimeProjection: runtimeSHA256,
  toolchain: artifact.projection.toolchain,
  files: artifact.files,
});
assertEqual(
  artifact.fingerprints.build.sha256,
  buildSHA256,
  "build fingerprint"
);

const marker = JSON.parse(
  readFileSync(join(packageRoot, ".vgpu-native-output.json"), "utf8")
);
assertEqual(
  marker.manifestSha256,
  sha256Bytes(artifactBytes),
  "raw manifest SHA-256"
);
assertEqual(
  marker.configuration,
  "c3-artifact-swiftpm",
  "ownership configuration"
);

const generatedSwift = readFileSync(
  join(packageRoot, "Sources", "AppShaders", "AppShaders.generated.swift"),
  "utf8"
);
const packageSwift = readFileSync(join(packageRoot, "Package.swift"), "utf8");
const probeSwift = readFileSync(
  join(packageRoot, "Sources", "AppShadersC3MetalProbe", "main.swift"),
  "utf8"
);
const moduleIdentity = artifact.semantic.module;
assertEqual(
  moduleIdentity.swiftName,
  "AppShaders",
  "fixture Swift module identity"
);
assertIncludes(
  packageSwift,
  `name: "${moduleIdentity.swiftName}"`,
  "Package.swift module"
);
assertIncludes(
  packageSwift,
  `.library(name: "${moduleIdentity.swiftName}", targets: ["${moduleIdentity.swiftName}"])`,
  "Package.swift library product"
);
assertIncludes(
  packageSwift,
  '.executable(name: "AppShadersC3MetalProbe", targets: ["AppShadersC3MetalProbe"])',
  "Package.swift C3 probe product"
);
assertIncludes(
  packageSwift,
  'name: "AppShadersC3MetalProbe"',
  "Package.swift C3 probe target"
);
assertIncludes(
  packageSwift,
  '.executableTarget(\n      name: "AppShadersC3MetalProbe"',
  "Package.swift C3 executable target declaration"
);
assertIncludes(
  packageSwift,
  '.process("Resources")',
  "Package.swift resource rule"
);
assertIncludes(
  packageSwift,
  `.product(name: "${artifact.semantic.abi.vgpuABI.product}", package: "RuntimeStub")`,
  "Package.swift VGPUABI dependency"
);

const [minimumMajor, minimumMinor, ...minimumRemainder] =
  artifact.projection.target.minimumOSVersion.split(".").map(Number);
if (
  !Number.isSafeInteger(minimumMajor) ||
  minimumMinor !== 0 ||
  minimumRemainder.some((part) => part !== 0)
) {
  fail(
    "fixture Package.swift cross-check requires a whole-number macOS version"
  );
}
assertIncludes(
  packageSwift,
  `.macOS(.v${minimumMajor})`,
  "Package.swift minimum macOS"
);

const expectedLibraryPath = `Sources/${moduleIdentity.swiftName}/Resources/${moduleIdentity.swiftName}.metallib`;
assertEqual(libraryPath, expectedLibraryPath, "module-derived library path");
for (const [label, expected] of [
  ["module name", `public static let moduleName = "${moduleIdentity.name}"`],
  [
    "Swift module name",
    `public static let swiftModuleName = "${moduleIdentity.swiftName}"`,
  ],
  [
    "minimum OS",
    `public static let minimumOSVersion = "${artifact.projection.target.minimumOSVersion}"`,
  ],
  [
    "semantic schema ABI",
    `semanticSchemaVersion: ${artifact.semantic.schemaVersion}`,
  ],
  [
    "Metal projection ABI",
    `metalProjectionABI: ${artifact.projection.abi.projection}`,
  ],
  [
    "generated Swift ABI",
    `generatedSwiftABI: ${artifact.semantic.abi.generatedSwift}`,
  ],
  [
    "binding layout ABI",
    `bindingLayoutABI: ${artifact.semantic.abi.bindingLayout}`,
  ],
  [
    "VGPUABI version",
    `requiredVGPUABIVersion: ${artifact.semantic.abi.vgpuABI.requiredVersion}`,
  ],
  [
    "binding slots ABI",
    `bindingSlotsABI: ${artifact.projection.abi.bindingSlots}`,
  ],
  ["layout model", `layoutModel: "${artifact.semantic.layoutModel}"`],
  ["binding model", `bindingModel: "${artifact.projection.abi.bindingModel}"`],
  [
    "vertex-buffer policy model",
    `vertexBufferPolicyModel: "${artifact.projection.vertexBufferPolicy.model}"`,
  ],
  [
    "external buffer ceiling",
    `externalBufferCeiling: ${artifact.projection.vertexBufferPolicy.externalBufferCeiling}`,
  ],
  ["semantic fingerprint", `semanticFingerprint: "${semanticSHA256}"`],
  [
    "projection semantic fingerprint",
    `projectionSemanticFingerprint: "${artifact.projection.semantic.sha256}"`,
  ],
  ["runtime fingerprint", `runtimeFingerprint: "${runtimeSHA256}"`],
  [
    "generated runtime fingerprint",
    `generatedRuntimeFingerprint: "${artifact.projection.runtimeFingerprint.sha256}"`,
  ],
  ["library SHA-256", `librarySHA256: "${libraries[0].sha256}"`],
  [
    "generated library SHA-256",
    `generatedLibrarySHA256: "${libraries[0].sha256}"`,
  ],
  [
    "payload filename",
    `public static let payloadFilename = "${moduleIdentity.swiftName}.metallib"`,
  ],
]) {
  assertIncludes(generatedSwift, expected, `generated Swift ${label}`);
}

const noopProjection = artifact.projection.programs.find(
  (program) => program.semanticProgram === "Noop"
);
if (!noopProjection) fail("projection has no Noop program for the C3 probe");
const noopSemantic = semanticPrograms.get(noopProjection.semanticProgram);
const noopComputeEntries = noopProjection.entryPoints.filter(
  (entry) => entry.stage === "compute"
);
if (noopComputeEntries.length !== 1) {
  fail("C3 probe requires exactly one projected compute entry");
}
const noopProjectedBindings = noopProjection.bindings.filter((binding) =>
  binding.slots.some(
    (slot) => slot.stage === "compute" && slot.resourceClass === "buffer"
  )
);
if (noopProjectedBindings.length !== 1) {
  fail("C3 probe requires exactly one projected compute buffer binding");
}
const noopBufferSlots = noopProjectedBindings[0].slots.filter(
  (slot) => slot.stage === "compute" && slot.resourceClass === "buffer"
);
if (noopBufferSlots.length !== 1 || noopBufferSlots[0].count !== 1) {
  fail("C3 probe requires exactly one direct compute buffer slot");
}
assertEqual(noopBufferSlots[0].index, 0, "C3 no-op buffer ABI index");
const noopSemanticBinding = noopSemantic.bindings.find(
  (binding) => binding.id === noopProjectedBindings[0].semanticBinding
);
const noopSemanticType = artifact.semantic.types[noopSemanticBinding?.type];
if (
  !noopSemanticBinding ||
  noopSemanticBinding.kind !== "buffer" ||
  noopSemanticType?.kind !== "array" ||
  !Number.isSafeInteger(noopSemanticType.count)
) {
  fail("C3 probe buffer must map to one fixed semantic array binding");
}
const noopEntry = noopComputeEntries[0];
const noopWorkgroup = noopProjection.resolvedWorkgroupSize;
for (const [label, expected] of [
  ["Metal entry", `metalEntryPoint: "${noopEntry.metal}"`],
  ["buffer slot", `bufferIndex: ${noopBufferSlots[0].index}`],
  ["workgroup width", `workgroupWidth: ${noopWorkgroup.x}`],
  ["workgroup height", `workgroupHeight: ${noopWorkgroup.y}`],
  ["workgroup depth", `workgroupDepth: ${noopWorkgroup.z}`],
  [
    "minimum buffer size",
    `minimumBufferByteCount: ${noopSemanticBinding.minimumBindingSize}`,
  ],
  ["element count", `elementCount: ${noopSemanticType.count}`],
]) {
  assertIncludes(generatedSwift, expected, `generated Swift C3 probe ${label}`);
}
for (const [label, expected] of [
  ["entry", "library.makeFunction(name: projection.metalEntryPoint)"],
  ["buffer size", "length: projection.minimumBufferByteCount"],
  ["buffer slot", "index: projection.bufferIndex"],
  ["workgroup width", "width: projection.workgroupWidth"],
  ["workgroup height", "height: projection.workgroupHeight"],
  ["workgroup depth", "depth: projection.workgroupDepth"],
  ["element count", "capacity: projection.elementCount"],
]) {
  assertIncludes(probeSwift, expected, `C3 probe derived ${label}`);
}
if (generatedSwift.includes("__"))
  fail("generated Swift has an unresolved placeholder");

if (
  artifact.extensions["dev.vgpu.c3"].payloadKind ===
  "invalid-structural-sentinel"
) {
  const payload = readFileSync(
    join(packageRoot, ...libraryPath.split("/")),
    "utf8"
  );
  if (!payload.startsWith("VGPU-C3-STRUCTURAL-SENTINEL-NOT-A-METALLIB")) {
    fail("C3a payload does not carry the invalid sentinel marker");
  }
}

console.log(
  `C3 artifact verified: 5 schemas, ${referenceCount} refs, ${artifact.files.length} payload files, 6 program-fingerprint sensitivity checks per program, ${artifact.extensions["dev.vgpu.c3"].payloadKind}.`
);
