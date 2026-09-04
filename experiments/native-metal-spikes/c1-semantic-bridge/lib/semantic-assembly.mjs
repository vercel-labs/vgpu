import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

import {
  assertRequestSemantics,
  COMPILER_CONTRACT,
} from "../../c1-compiler-protocol/lib/protocol.mjs";
import {
  authenticatedSemanticExtractionRequestBytes,
  isAuthenticatedSemanticExtraction,
  isSemanticExtractionForFinalizedCapsule,
} from "./authenticated-semantic-extraction.mjs";
import { isFinalizedProgramCapsule } from "./fullscreen-injection.mjs";
import { deterministicStringify } from "./protocol.mjs";
import {
  assertResolvedDeclarationsForFinalizedCapsule,
  isResolvedDeclarationIndex,
  resolvedDeclarationForSelectedEntry,
} from "./resolved-declarations.mjs";

export const SEMANTIC_CONTRACT = "vgpu-native-semantic/v1";
export const SEMANTIC_TYPE_ID_DOMAIN = "vgpu-native-semantic-type/v1";
export const PROGRAM_FINGERPRINT_DOMAIN = "vgpu-native-program/v1";

const assemblies = new WeakMap();
const validators = loadValidators();
const stageOrder = ["vertex", "fragment", "compute"];
const programStages = Object.freeze({
  effect: Object.freeze(["vertex", "fragment"]),
  draw: Object.freeze(["vertex", "fragment"]),
  compute: Object.freeze(["compute"]),
});
const swiftIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export class SemanticAssemblyError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "SemanticAssemblyError";
    this.code = code;
  }
}

/**
 * Assembles one complete semantic-v1 module containing one interface-only
 * program. Later slices widen the accepted extraction profile; they do not
 * change the nominal association or translator-projection boundary.
 */
export function assembleInterfaceOnlySemanticProgram({
  presentation,
  finalized,
  extraction,
  declarations,
}) {
  assertPresentation(presentation, finalized);
  assertAssemblyAssociations(finalized, extraction, declarations);
  const extractionRequest = retainedExtractionRequest(extraction);
  assertInterfaceOnlyProfile(extractionRequest, extraction.result);

  const typeInterner = createInterfaceTypeInterner();
  const entries = {};
  const rawEntriesByStage = new Map();
  for (const stage of programStages[finalized.selection.kind]) {
    const raw = extraction.result.entryPoints.find(
      (entry) => entry.stage === stage
    );
    if (!raw) {
      assemblyFail(
        "VGPU-C1-ASSEMBLY-ENTRY",
        `semantic extraction omitted selected ${quoted(stage)} entry`
      );
    }
    rawEntriesByStage.set(stage, raw);
    entries[stage] = assembleEntry({
      stage,
      raw,
      finalized,
      declarations,
      typeInterner,
    });
  }
  if (rawEntriesByStage.size !== extraction.result.entryPoints.length) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-ENTRY",
      "semantic extraction contains an unselected entry"
    );
  }
  if (finalized.selection.kind !== "compute") {
    assertRenderLink(entries.vertex, entries.fragment);
  }

  const capabilities = {
    vocabulary: 1,
    languageFeatures: [...extractionRequest.languageFeatures],
    features: [],
  };
  const program = {
    name: finalized.selection.name,
    swiftName: presentation.program.swiftName,
    kind: finalized.selection.kind,
    sources: finalized.capsule.originMap.sources
      .map((source) => source.input)
      .sort(compare),
    fingerprint: { domain: PROGRAM_FINGERPRINT_DOMAIN, sha256: "0".repeat(64) },
    entryPoints: entries,
    bindings: [],
    overrides: [],
    capabilities: structuredClone(capabilities),
  };
  const semantic = {
    schemaVersion: 1,
    contractId: SEMANTIC_CONTRACT,
    module: structuredClone(presentation.module),
    abi: {
      bindingLayout: 1,
      generatedSwift: 1,
      vgpuABI: { product: "VGPUABI", requiredVersion: 1 },
    },
    layoutModel: "wgsl-host-shareable-v1",
    types: typeInterner.types(),
    layouts: {},
    programs: [program],
    capabilities,
  };
  program.fingerprint.sha256 = fingerprintProgram(
    program,
    semantic,
    finalized.capsule.originMap.sources
  );
  assertSchema(validators.semantic, semantic, "assembled semantic-v1");
  assertInterfaceTypeClosure(semantic);

  const assembly = freezeJson({ semantic });
  assemblies.set(assembly, {
    declarations,
    extraction,
    finalized,
    rawEntriesByStage,
  });
  return assembly;
}

export function isInterfaceOnlySemanticAssembly(value) {
  return typeof value === "object" && value !== null && assemblies.has(value);
}

export function semanticModuleForAssembly(value) {
  requireAssembly(value);
  return value.semantic;
}

/**
 * Projects one existing compiler request from a nominal assembly. Backend
 * policy remains explicit, but no caller can supply semantic interface or
 * override facts independently from the authenticated extraction.
 */
export function compilerRequestForAssembledEntry({
  assembly,
  stage,
  metalEntryPoint,
  metal,
}) {
  const record = requireAssembly(assembly);
  const program = assembly.semantic.programs[0];
  const semanticEntry = program.entryPoints[stage];
  const rawEntry = record.rawEntriesByStage.get(stage);
  if (!semanticEntry || !rawEntry || semanticEntry.stage !== stage) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-PROJECTION",
      `assembled program has no ${quoted(stage)} entry`
    );
  }
  if (!isPlainObject(metal) || !Array.isArray(metal.bindings)) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-PROJECTION",
      "compiler projection requires one explicit Metal policy"
    );
  }
  if (metal.bindings.length !== 0) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-PROFILE",
      "interface-only assembly cannot project external Metal bindings"
    );
  }
  const rehydrated = semanticInterfaceFromAssembly(
    semanticEntry,
    assembly.semantic.types
  );
  if (!isDeepStrictEqual(rehydrated, rawEntry.semanticInterface)) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-PROJECTION",
      "assembled interface differs from its retained authenticated extraction"
    );
  }

  const request = {
    schemaVersion: 1,
    contractId: COMPILER_CONTRACT,
    source: structuredClone(record.finalized.capsule.source),
    originMap: structuredClone(record.finalized.capsule.originMap),
    entryPoint: {
      stage,
      wgsl: semanticEntry.names.wgsl,
      metal: metalEntryPoint,
    },
    semanticInterface: structuredClone(rawEntry.semanticInterface),
    overrides: [],
    languageFeatures: [...record.finalized.capsule.languageFeatures],
    metal: structuredClone(metal),
  };
  assertSchema(validators.compilerRequest, request, "compiler request");
  try {
    assertRequestSemantics(request);
  } catch (cause) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-PROJECTION",
      `compiler request preflight failed: ${cause?.message ?? cause}`
    );
  }
  return freezeJson(request);
}

function assertAssemblyAssociations(finalized, extraction, declarations) {
  if (!isFinalizedProgramCapsule(finalized)) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-CAPSULE",
      "assembly requires a nominal finalized program capsule"
    );
  }
  if (
    !isAuthenticatedSemanticExtraction(extraction) ||
    !isSemanticExtractionForFinalizedCapsule(extraction, finalized)
  ) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-EXTRACTION",
      "assembly requires the exact authenticated extraction for its capsule"
    );
  }
  if (!isResolvedDeclarationIndex(declarations)) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-DECLARATIONS",
      "assembly requires a nominal resolver declaration index"
    );
  }
  try {
    assertResolvedDeclarationsForFinalizedCapsule(declarations, finalized);
  } catch (cause) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-DECLARATIONS",
      cause?.message ?? String(cause)
    );
  }
}

function retainedExtractionRequest(extraction) {
  let request;
  try {
    request = JSON.parse(
      authenticatedSemanticExtractionRequestBytes(extraction)
    );
  } catch (cause) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-EXTRACTION",
      `retained semantic request is unavailable: ${cause?.message ?? cause}`
    );
  }
  return request;
}

function assertInterfaceOnlyProfile(request, result) {
  if (request.languageFeatures.includes("dual_source_blending")) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-PROFILE",
      "the first-alpha assembly profile rejects dual_source_blending"
    );
  }
  const emptyObjects = [result.types, result.layouts];
  if (
    request.overrideConfiguration.length !== 0 ||
    result.bindings.length !== 0 ||
    result.overrides.length !== 0 ||
    emptyObjects.some(
      (value) => !isPlainObject(value) || Object.keys(value).length !== 0
    ) ||
    result.entryPoints.some(
      (entry) =>
        entry.bindings.length !== 0 ||
        entry.samplingPairs.length !== 0 ||
        entry.overrides.length !== 0
    )
  ) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-PROFILE",
      "this assembly slice accepts only interface-only semantic extractions"
    );
  }
}

function assembleEntry({ stage, raw, finalized, declarations, typeInterner }) {
  const selected = finalized.selection.entryPoints[stage];
  if (
    raw.stage !== stage ||
    raw.wgsl !== selected?.names?.wgsl ||
    raw.semanticInterface.kind !== stage
  ) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-ENTRY",
      `extracted ${quoted(stage)} identity differs from the finalized selection`
    );
  }
  const entry = {
    stage,
    origin: selected.origin,
    names: { wgsl: selected.names.wgsl },
    inputs: raw.semanticInterface.inputs.map((value) =>
      assembleInterfaceValue(value, typeInterner)
    ),
    outputs: raw.semanticInterface.outputs.map((value) =>
      assembleInterfaceValue(value, typeInterner)
    ),
    bindings: [],
    samplingPairs: [],
    ...(stage === "compute"
      ? { workgroupSize: structuredClone(raw.workgroupSize) }
      : {}),
  };
  if (selected.origin === "authored") {
    let declaration;
    try {
      declaration = resolvedDeclarationForSelectedEntry(
        declarations,
        finalized,
        stage
      );
    } catch (cause) {
      assemblyFail(
        "VGPU-C1-ASSEMBLY-DECLARATIONS",
        cause?.message ?? String(cause)
      );
    }
    entry.names.authored = declaration.names.authored;
    entry.source = structuredClone(declaration.source);
  } else if (selected.origin !== "injected" || stage !== "vertex") {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-ENTRY",
      `only an effect vertex may have injected origin`
    );
  }
  return entry;
}

function assembleInterfaceValue(value, typeInterner) {
  const assembled = structuredClone(value);
  assembled.type = typeInterner.intern(value.type);
  return assembled;
}

function assertRenderLink(vertex, fragment) {
  const outputs = new Map(
    vertex.outputs
      .filter((value) => value.location !== undefined)
      .map((value) => [value.location, value])
  );
  for (const input of fragment.inputs) {
    if (input.location === undefined) continue;
    const output = outputs.get(input.location);
    if (
      !output ||
      output.type !== input.type ||
      output.invariant !== input.invariant ||
      !isDeepStrictEqual(output.interpolation, input.interpolation)
    ) {
      assemblyFail(
        "VGPU-C1-ASSEMBLY-LINK",
        `fragment location ${input.location} does not match the vertex output`
      );
    }
  }
}

function createInterfaceTypeInterner() {
  const definitions = new Map();
  const internDefinition = (definition) => {
    const id = semanticTypeId(definition);
    const previous = definitions.get(id);
    if (previous && !isDeepStrictEqual(previous, definition)) {
      assemblyFail(
        "VGPU-C1-ASSEMBLY-TYPE",
        `semantic type ID ${id} has a content collision`
      );
    }
    definitions.set(id, freezeJson(structuredClone(definition)));
    return id;
  };
  return {
    intern(inline) {
      if (
        !isPlainObject(inline) ||
        !["bool", "f16", "f32", "i32", "u32"].includes(inline.scalar) ||
        ![1, 2, 3, 4].includes(inline.width)
      ) {
        assemblyFail(
          "VGPU-C1-ASSEMBLY-TYPE",
          "interface leaf has an unsupported inline type"
        );
      }
      const scalar = internDefinition({
        kind: "scalar",
        scalar: inline.scalar,
      });
      return inline.width === 1
        ? scalar
        : internDefinition({
            kind: "vector",
            width: inline.width,
            element: scalar,
          });
    },
    types() {
      return Object.fromEntries(
        [...definitions].sort(([left], [right]) => compare(left, right))
      );
    },
  };
}

export function semanticTypeId(definition) {
  return `t_${hashDomainValue(SEMANTIC_TYPE_ID_DOMAIN, definition, false)}`;
}

function semanticInterfaceFromAssembly(entry, types) {
  return {
    kind: entry.stage,
    inputs: entry.inputs.map((value) => inlineInterfaceValue(value, types)),
    outputs: entry.outputs.map((value) => inlineInterfaceValue(value, types)),
  };
}

function inlineInterfaceValue(value, types) {
  const inline = inlineType(types, value.type, new Set());
  const projected = structuredClone(value);
  projected.type = inline;
  return projected;
}

function inlineType(types, id, visiting) {
  if (visiting.has(id)) {
    assemblyFail("VGPU-C1-ASSEMBLY-TYPE", `semantic type cycle at ${id}`);
  }
  const definition = types[id];
  if (!definition || semanticTypeId(definition) !== id) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-TYPE",
      `semantic interface references invalid type ${quoted(id)}`
    );
  }
  if (definition.kind === "scalar") {
    return { scalar: definition.scalar, width: 1 };
  }
  if (definition.kind === "vector") {
    const scalar = inlineType(
      types,
      definition.element,
      new Set(visiting).add(id)
    );
    if (scalar.width !== 1) {
      assemblyFail(
        "VGPU-C1-ASSEMBLY-TYPE",
        `vector ${quoted(id)} does not reference a scalar`
      );
    }
    return { scalar: scalar.scalar, width: definition.width };
  }
  assemblyFail(
    "VGPU-C1-ASSEMBLY-TYPE",
    `interface type ${quoted(id)} is not scalar or vector`
  );
}

function assertInterfaceTypeClosure(semantic) {
  const reachable = new Set();
  const pending = semantic.programs.flatMap((program) =>
    Object.values(program.entryPoints).flatMap((entry) =>
      [...entry.inputs, ...entry.outputs].map((value) => value.type)
    )
  );
  while (pending.length > 0) {
    const id = pending.pop();
    if (reachable.has(id)) continue;
    const definition = semantic.types[id];
    if (!definition || semanticTypeId(definition) !== id) {
      assemblyFail(
        "VGPU-C1-ASSEMBLY-TYPE",
        `semantic type closure contains invalid ID ${quoted(id)}`
      );
    }
    reachable.add(id);
    if (definition.element) pending.push(definition.element);
  }
  if (
    !isDeepStrictEqual(
      [...reachable].sort(compare),
      Object.keys(semantic.types).sort(compare)
    )
  ) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-TYPE",
      "semantic module contains an unreachable interface type"
    );
  }
}

function fingerprintProgram(program, semantic, originSources) {
  const normalizedProgram = structuredClone(program);
  delete normalizedProgram.fingerprint;
  delete normalizedProgram.sources;
  stripInterfaceDiagnosticNames(normalizedProgram);
  const inputHashes = new Map(
    originSources.map((source) => [source.input, source.sha256])
  );
  const value = {
    domain: PROGRAM_FINGERPRINT_DOMAIN,
    layoutModel: semantic.layoutModel,
    sources: program.sources.map((id) => ({
      id,
      sha256: inputHashes.get(id),
    })),
    languageFeatures: [...semantic.capabilities.languageFeatures].sort(compare),
    program: normalizeSemanticSets(
      stripPresentationAndProvenance(normalizedProgram)
    ),
    types: Object.fromEntries(
      Object.entries(semantic.types)
        .sort(([left], [right]) => compare(left, right))
        .map(([id, definition]) => [
          id,
          stripPresentationAndProvenance(definition),
        ])
    ),
    layouts: {},
  };
  if (value.sources.some((source) => source.sha256 === undefined)) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-FINGERPRINT",
      "program fingerprint references an unknown authored input"
    );
  }
  return hashCanonical(value);
}

function stripPresentationAndProvenance(value) {
  if (Array.isArray(value)) return value.map(stripPresentationAndProvenance);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "swiftName" && key !== "source")
      .map(([key, child]) => [key, stripPresentationAndProvenance(child)])
  );
}

function stripInterfaceDiagnosticNames(program) {
  for (const entry of Object.values(program.entryPoints)) {
    for (const value of [...entry.inputs, ...entry.outputs]) delete value.name;
  }
}

function normalizeSemanticSets(value, key = "") {
  if (Array.isArray(value)) {
    const normalized = value.map((child) => normalizeSemanticSets(child));
    const isStringSet =
      ["languageFeatures", "features", "visibility"].includes(key) ||
      (key === "bindings" &&
        normalized.every((child) => typeof child === "string"));
    return isStringSet ? normalized.sort(compare) : normalized;
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      normalizeSemanticSets(child, childKey),
    ])
  );
}

function assertPresentation(presentation, finalized) {
  if (!isPlainObject(presentation)) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-PRESENTATION",
      "presentation must be a plain object"
    );
  }
  assertExactKeys(presentation, ["module", "program"], "presentation");
  for (const [label, value, keys] of [
    ["presentation.module", presentation.module, ["name", "swiftName"]],
    ["presentation.program", presentation.program, ["swiftName"]],
  ]) {
    if (!isPlainObject(value)) {
      assemblyFail(
        "VGPU-C1-ASSEMBLY-PRESENTATION",
        `${label} must be a plain object`
      );
    }
    assertExactKeys(value, keys, label);
    for (const [key, name] of Object.entries(value)) {
      if (
        typeof name !== "string" ||
        name.length === 0 ||
        name.length > (key === "swiftName" ? 256 : 1024) ||
        !name.isWellFormed() ||
        name.normalize("NFC") !== name ||
        (key === "swiftName" && !swiftIdentifier.test(name))
      ) {
        assemblyFail(
          "VGPU-C1-ASSEMBLY-PRESENTATION",
          `${label}.${key} is not a canonical generated name`
        );
      }
    }
  }
  if (
    typeof finalized?.selection?.name !== "string" ||
    finalized.selection.name.length === 0 ||
    finalized.selection.name.length > 1024 ||
    !finalized.selection.name.isWellFormed() ||
    finalized.selection.name.normalize("NFC") !== finalized.selection.name
  ) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-PRESENTATION",
      "finalized program has no valid semantic name"
    );
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== "string") ||
    !isDeepStrictEqual([...actual].sort(compare), [...expected].sort(compare))
  ) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-PRESENTATION",
      `${label} has unexpected properties`
    );
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      assemblyFail(
        "VGPU-C1-ASSEMBLY-PRESENTATION",
        `${label}.${key} must be an enumerable data property`
      );
    }
  }
}

function loadValidators() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const compilerDirectory = resolve(
    directory,
    "../../c1-compiler-protocol/contracts"
  );
  const semanticPath = resolve(
    directory,
    "../../../../docs/plans/native/contracts/semantic-v1.schema.json"
  );
  const schemas = [
    readJson(join(compilerDirectory, "origin-map-v1.schema.json")),
    readJson(join(compilerDirectory, "request-v1.schema.json")),
    readJson(semanticPath),
  ];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) ajv.addSchema(schema);
  return {
    compilerRequest: ajv.getSchema(schemas[1].$id),
    semantic: ajv.getSchema(schemas[2].$id),
  };
}

function assertSchema(validate, value, label) {
  if (!validate(value)) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-SCHEMA",
      `${label} failed JSON Schema validation: ${JSON.stringify(
        validate.errors
      )}`
    );
  }
}

function hashDomainValue(domain, value, normalizeStrings) {
  const encoded = normalizeStrings
    ? canonicalize(value)
    : deterministicStringify(value);
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(encoded, "utf8")
    .digest("hex");
}

function hashCanonical(value) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function canonicalize(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) || Object.is(value, -0))
    ) {
      assemblyFail(
        "VGPU-C1-ASSEMBLY-FINGERPRINT",
        "program fingerprint contains a non-canonical number"
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      assemblyFail(
        "VGPU-C1-ASSEMBLY-FINGERPRINT",
        "program fingerprint contains malformed Unicode"
      );
    }
    return JSON.stringify(value.normalize("NFC"));
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(compare);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  assemblyFail(
    "VGPU-C1-ASSEMBLY-FINGERPRINT",
    `program fingerprint cannot encode ${typeof value}`
  );
}

function requireAssembly(value) {
  const record = assemblies.get(value);
  if (!record) {
    assemblyFail(
      "VGPU-C1-ASSEMBLY-BRAND",
      "value is not a nominal interface-only semantic assembly"
    );
  }
  return record;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function quoted(value) {
  return JSON.stringify(value);
}

function freezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function assemblyFail(code, message) {
  throw new SemanticAssemblyError(code, message);
}
