import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { resolveVirtualShader } from "../../c1-compiler-protocol/lib/virtual-resolver.mjs";

export const RESOLVED_DECLARATIONS_CONTRACT =
  "vgpu-c1-resolved-entry-declarations/v1";

const declarationIndexes = new WeakMap();
const stages = new Set(["vertex", "fragment", "compute"]);
const stageOrder = new Map([
  ["vertex", 0],
  ["fragment", 1],
  ["compute", 2],
]);
const wgslIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export class ResolvedDeclarationsError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ResolvedDeclarationsError";
    this.code = code;
  }
}

/**
 * Runs the real virtual resolver and captures its entry declarations in the
 * same turn. Callers never receive a public mint that could brand a structural
 * clone as resolver authority.
 */
export async function resolveVirtualShaderWithDeclarations(input) {
  const graph = await resolveVirtualShader(input);
  return Object.freeze({
    graph,
    declarations: createResolvedDeclarationIndex(graph),
  });
}

/** Validates a negative-canary candidate without minting usable authority. */
export function validateResolvedDeclarationCandidate(graph) {
  createResolvedDeclarationIndex(graph, false);
  return true;
}

function createResolvedDeclarationIndex(graph, authorize = true) {
  assertResolverGraph(graph);

  const originSources = new Map(
    graph.originMap.sources.map((source) => [source.input, source])
  );
  const sourcesByInput = new Map();
  const sourceByVirtualPath = new Map();
  for (const source of graph.sources) {
    assertSource(source);
    if (
      sourcesByInput.has(source.id) ||
      sourceByVirtualPath.has(source.virtualPath)
    ) {
      declarationFail(
        "VGPU-C1-DECLARATIONS-RESOLVER",
        "resolver source identities are duplicated"
      );
    }
    const origin = originSources.get(source.id);
    if (origin && origin.sha256 !== source.sha256) {
      declarationFail(
        "VGPU-C1-DECLARATIONS-RESOLVER",
        `resolver source ${quoted(source.id)} disagrees with the origin map`
      );
    }
    const retained = Object.freeze({
      id: source.id,
      virtualPath: source.virtualPath,
      text: source.text,
      sha256: source.sha256,
    });
    sourcesByInput.set(source.id, retained);
    sourceByVirtualPath.set(source.virtualPath, retained);
  }

  const reflectedEntries = graph.resolved.reflection.entryPoints;
  const entries = [];
  const seen = new Set();
  for (const module of graph.resolved.ast.modules) {
    const source = sourceByVirtualPath.get(module.path);
    if (!source) {
      declarationFail(
        "VGPU-C1-DECLARATIONS-RESOLVER",
        `resolver AST module ${quoted(module.path)} has no authored source`
      );
    }
    if (!originSources.has(source.id)) {
      declarationFail(
        "VGPU-C1-DECLARATIONS-RESOLVER",
        `resolver AST module ${quoted(module.path)} is absent from provenance`
      );
    }
    if (!Array.isArray(module.entryPointDeclarations)) {
      declarationFail(
        "VGPU-C1-DECLARATIONS-RESOLVER",
        `resolver AST module ${quoted(module.path)} omitted entry declarations`
      );
    }

    for (const declaration of module.entryPointDeclarations) {
      assertDeclarationShape(declaration, module.path);
      const matches = reflectedEntries.filter(
        (entry) =>
          entry.name === declaration.name &&
          entry.stage === declaration.stage &&
          typeof entry.mangledName === "string"
      );
      if (
        matches.length !== 1 ||
        !wgslIdentifier.test(matches[0].mangledName)
      ) {
        declarationFail(
          "VGPU-C1-DECLARATIONS-RESOLVER",
          `authored entry ${quoted(
            declaration.name
          )} does not map to one resolved entry`
        );
      }
      const snippet = sourceSlice(source.text, declaration.span);
      if (!containsIdentifier(snippet, declaration.name)) {
        declarationFail(
          "VGPU-C1-DECLARATIONS-SPAN",
          `entry span for ${quoted(
            declaration.name
          )} does not contain its authored name`
        );
      }

      const entry = {
        stage: declaration.stage,
        names: {
          authored: declaration.name,
          wgsl: matches[0].mangledName,
        },
        source: {
          input: source.id,
          start: { ...declaration.span.start },
          end: { ...declaration.span.end },
        },
      };
      const key = entryKey(entry.stage, entry.names.wgsl);
      if (seen.has(key)) {
        declarationFail(
          "VGPU-C1-DECLARATIONS-RESOLVER",
          `resolved entry ${quoted(entry.names.wgsl)} is duplicated`
        );
      }
      seen.add(key);
      entries.push(entry);
    }
  }

  for (const reflected of reflectedEntries) {
    if (
      !stages.has(reflected?.stage) ||
      !wgslIdentifier.test(reflected?.mangledName ?? "") ||
      !seen.has(entryKey(reflected.stage, reflected.mangledName))
    ) {
      declarationFail(
        "VGPU-C1-DECLARATIONS-RESOLVER",
        `resolved entry ${quoted(
          reflected?.mangledName
        )} has no exact authored declaration`
      );
    }
  }

  entries.sort(
    (left, right) =>
      stageOrder.get(left.stage) - stageOrder.get(right.stage) ||
      compare(left.names.wgsl, right.names.wgsl)
  );
  const snapshot = freezeJson({
    schemaVersion: 1,
    contractId: RESOLVED_DECLARATIONS_CONTRACT,
    resolvedSource: {
      virtualPath: graph.originMap.generatedSource.virtualPath,
      sha256: graph.originMap.generatedSource.sha256,
    },
    sources: graph.originMap.sources.map((source) => ({ ...source })),
    entries,
  });
  const record = {
    resolvedText: graph.resolved.wgsl,
    originMap: structuredClone(graph.originMap),
    sourcesByInput,
    entriesByKey: new Map(
      snapshot.entries.map((entry) => [
        entryKey(entry.stage, entry.names.wgsl),
        entry,
      ])
    ),
  };
  if (authorize) declarationIndexes.set(snapshot, record);
  return snapshot;
}

export function isResolvedDeclarationIndex(value) {
  return (
    typeof value === "object" && value !== null && declarationIndexes.has(value)
  );
}

/** Proves that the resolver evidence is the authored prefix of this capsule. */
export function assertResolvedDeclarationsForFinalizedCapsule(
  declarations,
  finalized
) {
  const record = requireIndex(declarations);
  const capsule = finalized?.capsule;
  if (!capsule?.source || !capsule?.originMap) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-CAPSULE",
      "declaration association requires a finalized source capsule"
    );
  }
  if (
    capsule.source.virtualPath !== declarations.resolvedSource.virtualPath ||
    !isDeepStrictEqual(capsule.originMap.sources, declarations.sources) ||
    !isDeepStrictEqual(capsule.originMap.segments, record.originMap.segments)
  ) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-CAPSULE",
      "resolver declarations belong to another authored capsule"
    );
  }

  if (finalized.injection === undefined) {
    if (
      capsule.source.sha256 !== declarations.resolvedSource.sha256 ||
      capsule.source.text !== record.resolvedText ||
      !isDeepStrictEqual(capsule.originMap, record.originMap)
    ) {
      declarationFail(
        "VGPU-C1-DECLARATIONS-CAPSULE",
        "non-injected capsule differs from its resolver output"
      );
    }
  } else {
    const expectedPrefix = `${record.resolvedText}\n`;
    const authoredBytes = Buffer.byteLength(record.resolvedText, "utf8");
    const finalBytes = Buffer.byteLength(capsule.source.text, "utf8");
    if (
      !capsule.source.text.startsWith(expectedPrefix) ||
      finalized.injection.generated?.startByte !== authoredBytes ||
      finalized.injection.generated?.endByte !== finalBytes ||
      capsule.originMap.generatedSource.virtualPath !==
        record.originMap.generatedSource.virtualPath
    ) {
      declarationFail(
        "VGPU-C1-DECLARATIONS-CAPSULE",
        "injected capsule does not preserve the resolver output as its authored prefix"
      );
    }
  }
  return declarations;
}

/** Returns the one resolver-owned record for an authored selected entry. */
export function resolvedDeclarationForSelectedEntry(
  declarations,
  finalized,
  stage
) {
  const record = requireIndex(declarations);
  assertResolvedDeclarationsForFinalizedCapsule(declarations, finalized);
  const selected = finalized?.selection?.entryPoints?.[stage];
  if (!selected || selected.stage !== stage) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-ENTRY",
      `finalized program has no selected ${quoted(stage)} entry`
    );
  }
  if (selected.origin === "injected") return undefined;
  if (selected.origin !== "authored") {
    declarationFail(
      "VGPU-C1-DECLARATIONS-ENTRY",
      `selected ${quoted(stage)} entry has an unknown origin`
    );
  }

  const entry = record.entriesByKey.get(entryKey(stage, selected.names?.wgsl));
  if (!entry) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-ENTRY",
      `selected authored ${quoted(stage)} entry has no resolver declaration`
    );
  }
  const source = record.sourcesByInput.get(entry.source.input);
  const origin = finalized.capsule.originMap.sources.find(
    (candidate) => candidate.input === entry.source.input
  );
  if (
    !source ||
    !origin ||
    source.sha256 !== origin.sha256 ||
    source.sha256 !== sha256(source.text)
  ) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-CAPSULE",
      `entry ${quoted(entry.names.authored)} source is absent or crossed`
    );
  }
  const snippet = sourceSlice(source.text, entry.source);
  if (!containsIdentifier(snippet, entry.names.authored)) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-SPAN",
      `entry ${quoted(entry.names.authored)} has a stale source span`
    );
  }
  return entry;
}

function assertResolverGraph(graph) {
  if (
    typeof graph !== "object" ||
    graph === null ||
    !Array.isArray(graph.sources) ||
    typeof graph.resolved?.wgsl !== "string" ||
    !Array.isArray(graph.resolved?.ast?.modules) ||
    !Array.isArray(graph.resolved?.reflection?.entryPoints) ||
    !Array.isArray(graph.originMap?.sources) ||
    !Array.isArray(graph.originMap?.segments)
  ) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-RESOLVER",
      "resolved declaration capture requires one complete resolver graph"
    );
  }
  const sourceHash = sha256(graph.resolved.wgsl);
  if (
    graph.originMap.generatedSource?.sha256 !== sourceHash ||
    typeof graph.originMap.generatedSource?.virtualPath !== "string"
  ) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-RESOLVER",
      "resolver output and origin-map identity disagree"
    );
  }
}

function assertSource(source) {
  if (
    typeof source?.id !== "string" ||
    typeof source.virtualPath !== "string" ||
    typeof source.text !== "string" ||
    source.sha256 !== sha256(source.text)
  ) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-RESOLVER",
      "resolver source record is malformed or has a stale hash"
    );
  }
}

function assertDeclarationShape(declaration, modulePath) {
  if (
    !stages.has(declaration?.stage) ||
    !wgslIdentifier.test(declaration?.name ?? "") ||
    !declaration.span?.start ||
    !declaration.span?.end
  ) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-RESOLVER",
      `resolver AST module ${quoted(
        modulePath
      )} has a malformed entry declaration`
    );
  }
}

function sourceSlice(source, span) {
  const start = sourceOffset(source, span.start);
  const end = sourceOffset(source, span.end);
  if (end <= start) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-SPAN",
      "entry declaration span must be non-empty and end-exclusive"
    );
  }
  return source.slice(start, end);
}

function sourceOffset(source, position) {
  if (
    !Number.isSafeInteger(position?.line) ||
    position.line < 1 ||
    !Number.isSafeInteger(position?.column) ||
    position.column < 1
  ) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-SPAN",
      "entry declaration position is not a positive safe integer"
    );
  }
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  const lineStart = starts[position.line - 1];
  if (lineStart === undefined) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-SPAN",
      "entry declaration line is outside its authored source"
    );
  }
  const nextLine = starts[position.line];
  const lineEnd = nextLine === undefined ? source.length : nextLine - 1;
  const offset = lineStart + position.column - 1;
  if (offset > lineEnd) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-SPAN",
      "entry declaration column is outside its authored source"
    );
  }
  return offset;
}

function containsIdentifier(source, identifier) {
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9_])${identifier}(?:$|[^A-Za-z0-9_])`,
    "u"
  );
  return pattern.test(source);
}

function requireIndex(value) {
  const record = declarationIndexes.get(value);
  if (!record) {
    declarationFail(
      "VGPU-C1-DECLARATIONS-BRAND",
      "value is not a nominal resolved declaration index"
    );
  }
  return record;
}

function entryKey(stage, wgsl) {
  return `${stage}\u0000${wgsl}`;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

function declarationFail(code, message) {
  throw new ResolvedDeclarationsError(code, message);
}
