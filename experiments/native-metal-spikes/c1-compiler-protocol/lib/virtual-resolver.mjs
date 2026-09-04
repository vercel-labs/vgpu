import { createHash } from "node:crypto";
import { posix } from "node:path";

import { resolveShader as productionResolveShader } from "../../../../packages/wgsl/dist/runtime/resolve-shader.js";
import { buildModuleOriginMap, RESOLVER_HEADER_PREFIX } from "./origin-map.mjs";

export const VIRTUAL_RESOLVER_CONTRACT = "vgpu-c1-virtual-resolver/v1";
export const RESOLVER_REQUEST_HASH_DOMAIN =
  "vgpu-c1-virtual-resolver-request/v1";

export class VirtualResolverError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "VirtualResolverError";
    this.code = code;
  }
}

/**
 * Resolves a graph entirely from caller-provided source text.
 *
 * `virtualPath` is the only path identity passed to @vgpu/wgsl. Physical
 * checkout paths are deliberately not accepted by this boundary, so mangled
 * identifiers and resolver metadata are relocatable.
 */
export async function resolveVirtualShader(
  {
    entry,
    sources,
    packageMap,
    generatedVirtualPath = "Intermediate/resolved.wgsl",
  },
  { resolveShaderImpl = productionResolveShader } = {}
) {
  if (typeof resolveShaderImpl !== "function") {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-IMPLEMENTATION",
      "resolveShaderImpl must be a function"
    );
  }

  const canonicalEntry = canonicalVirtualId(entry, "entry");
  const canonicalGeneratedPath = canonicalVirtualId(
    generatedVirtualPath,
    "generatedVirtualPath"
  );
  const sourceSet = createVirtualModules(sources);
  if (sourceSet.inputByVirtualPath[canonicalEntry] === undefined) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-ENTRY-MISSING",
      `entry ${JSON.stringify(canonicalEntry)} is absent from sources`
    );
  }
  const generatedCaseFold = canonicalGeneratedPath.toLocaleLowerCase("en-US");
  const generatedCollision = sourceSet.sources.find(
    (source) =>
      source.virtualPath.toLocaleLowerCase("en-US") === generatedCaseFold
  );
  if (generatedCollision) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-GENERATED-COLLISION",
      `generated path ${JSON.stringify(
        canonicalGeneratedPath
      )} collides with authored source ${JSON.stringify(
        generatedCollision.virtualPath
      )}`
    );
  }
  const canonicalPackages = canonicalizePackageMap(packageMap);

  const resolved = await resolveShaderImpl({
    entry: canonicalEntry,
    rootDir: ".",
    packageMap: canonicalPackages.record,
    modules: sourceSet.modules,
    validate: false,
    minify: false,
  });
  assertResolvedPathsAreVirtual(resolved, sourceSet.inputByVirtualPath);

  const emittedModules = resolved.ast.modules.map((module) => {
    const source = sourceSet.inputByVirtualPath[module.path];
    if (!source) {
      throw new VirtualResolverError(
        "VGPU-C1-RESOLVER-UNDECLARED-MODULE",
        `resolver emitted undeclared module ${JSON.stringify(module.path)}`
      );
    }
    return {
      virtualPath: module.path,
      input: source.id,
      sha256: source.sha256,
    };
  });
  const originMap = buildModuleOriginMap({
    wgsl: resolved.wgsl,
    modules: emittedModules,
    generatedVirtualPath: canonicalGeneratedPath,
  });

  const resolverRequest = {
    contractId: VIRTUAL_RESOLVER_CONTRACT,
    entry: canonicalEntry,
    generatedVirtualPath: canonicalGeneratedPath,
    options: { rootDir: ".", validate: false, minify: false },
    packageMap: canonicalPackages.entries,
    sources: sourceSet.sources.map(({ id, virtualPath, sha256 }) => ({
      id,
      virtualPath,
      sha256,
    })),
  };

  return {
    resolved,
    sources: sourceSet.sources,
    inputByVirtualPath: sourceSet.inputByVirtualPath,
    originMap,
    requestHash: canonicalRequestHash(resolverRequest),
  };
}

/**
 * Validates, NFC-normalizes, sorts, and materializes an in-memory filesystem.
 */
export function createVirtualModules(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-SOURCES",
      "sources must be a non-empty array"
    );
  }

  const normalized = sources.map((source, index) =>
    normalizeSource(source, index)
  );
  normalized.sort((left, right) =>
    compareCodeUnits(left.virtualPath, right.virtualPath)
  );

  const exact = new Set();
  const folded = new Map();
  const inputIds = new Set();
  const modules = Object.create(null);
  const inputByVirtualPath = Object.create(null);
  for (const source of normalized) {
    if (inputIds.has(source.id)) {
      throw new VirtualResolverError(
        "VGPU-C1-RESOLVER-INPUT-DUPLICATE",
        `duplicate source input identity ${JSON.stringify(source.id)}`
      );
    }
    inputIds.add(source.id);
    if (exact.has(source.virtualPath)) {
      throw new VirtualResolverError(
        "VGPU-C1-RESOLVER-SOURCE-DUPLICATE",
        `duplicate virtual path ${JSON.stringify(source.virtualPath)}`
      );
    }
    exact.add(source.virtualPath);

    const caseFolded = source.virtualPath.toLocaleLowerCase("en-US");
    const previous = folded.get(caseFolded);
    if (previous !== undefined) {
      throw new VirtualResolverError(
        "VGPU-C1-RESOLVER-SOURCE-CASE-COLLISION",
        `${JSON.stringify(previous)} collides with ${JSON.stringify(
          source.virtualPath
        )} under case folding`
      );
    }
    folded.set(caseFolded, source.virtualPath);
    modules[source.virtualPath] = source.text;
    inputByVirtualPath[source.virtualPath] = source;
  }

  return { sources: normalized, modules, inputByVirtualPath };
}

/**
 * Package-prefix iteration in resolveShader() is insertion ordered. Rejecting
 * overlaps makes that otherwise-observable order irrelevant instead of
 * silently choosing a longest-prefix policy that the production API does not
 * currently promise.
 */
export function canonicalizePackageMap(packageMap) {
  const rawEntries = packageMapEntries(packageMap);
  const entries = rawEntries.map(([prefix, target], index) => ({
    prefix: canonicalPackagePrefix(prefix, `packageMap prefix ${index}`),
    target: canonicalVirtualId(
      target,
      `packageMap target for ${String(prefix)}`
    ),
  }));
  entries.sort((left, right) => compareCodeUnits(left.prefix, right.prefix));

  const folded = new Map();
  for (const [index, entry] of entries.entries()) {
    const caseFolded = entry.prefix.toLocaleLowerCase("en-US");
    const previous = folded.get(caseFolded);
    if (previous !== undefined) {
      throw new VirtualResolverError(
        "VGPU-C1-RESOLVER-PACKAGE-CASE-COLLISION",
        `${JSON.stringify(previous)} collides with ${JSON.stringify(
          entry.prefix
        )} under case folding`
      );
    }
    folded.set(caseFolded, entry.prefix);

    for (let otherIndex = 0; otherIndex < index; otherIndex++) {
      const other = entries[otherIndex];
      if (
        entry.prefix.startsWith(other.prefix) ||
        other.prefix.startsWith(entry.prefix)
      ) {
        throw new VirtualResolverError(
          "VGPU-C1-RESOLVER-PACKAGE-OVERLAP",
          `package prefixes ${JSON.stringify(
            other.prefix
          )} and ${JSON.stringify(entry.prefix)} overlap`
        );
      }
    }
  }

  const record = Object.create(null);
  for (const { prefix, target } of entries) record[prefix] = target;
  return { entries, record };
}

/** Returns a canonical relative POSIX path suitable as a resolver identity. */
export function canonicalVirtualId(value, label = "virtual path") {
  if (typeof value !== "string" || value.length === 0) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-ID-TYPE",
      `${label} must be a non-empty string`
    );
  }
  if (value.length > 4096) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-ID-LENGTH",
      `${label} exceeds 4096 characters`
    );
  }
  if (!value.isWellFormed()) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-ID-UNICODE",
      `${label} contains an isolated UTF-16 surrogate`
    );
  }
  if (value.includes("\\")) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-ID-BACKSLASH",
      `${label} must use POSIX separators`
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-ID-CONTROL",
      `${label} contains a control character`
    );
  }

  const canonical = value.normalize("NFC");
  if (
    posix.isAbsolute(canonical) ||
    /^[A-Za-z]:/u.test(canonical) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(canonical)
  ) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-ID-ABSOLUTE",
      `${label} must not be an absolute host path`
    );
  }

  const segments = canonical.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-ID-SEGMENT",
      `${label} contains an empty, dot, or dot-dot segment`
    );
  }
  if (posix.normalize(canonical) !== canonical) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-ID-NONCANONICAL",
      `${label} is not a canonical POSIX path`
    );
  }
  return canonical;
}

/**
 * Hashes an arbitrary JSON-compatible request with sorted object keys and NFC
 * strings. The domain is inside the preimage, not adjacent metadata.
 */
export function canonicalRequestHash(
  request,
  domain = RESOLVER_REQUEST_HASH_DOMAIN
) {
  if (typeof domain !== "string" || domain.length === 0) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-HASH-DOMAIN",
      "hash domain must be a non-empty string"
    );
  }
  const normalizedDomain = domain.normalize("NFC");
  const preimage = canonicalStringify({ domain: normalizedDomain, request });
  return {
    domain: normalizedDomain,
    sha256: createHash("sha256").update(preimage, "utf8").digest("hex"),
  };
}

export function canonicalStringify(value) {
  return canonicalValue(value, new Set());
}

function normalizeSource(source, index) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-SOURCE-SHAPE",
      `source ${index} must be an object`
    );
  }
  const virtualPath = canonicalVirtualId(
    source.virtualPath,
    `source ${index} virtualPath`
  );
  const id = canonicalInputId(source.id, `source ${index} id`);
  if (typeof source.text !== "string") {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-SOURCE-TEXT",
      `source ${JSON.stringify(virtualPath)} text must be a string`
    );
  }
  if (!source.text.isWellFormed()) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-SOURCE-UNICODE",
      `source ${JSON.stringify(
        virtualPath
      )} contains an isolated UTF-16 surrogate`
    );
  }
  if (source.text.includes("\u0000")) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-SOURCE-NUL",
      `source ${JSON.stringify(virtualPath)} contains a NUL byte`
    );
  }
  if (/^\/\/ vgsl-module: [^\r\n]*\r?$/mu.test(source.text)) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-HEADER-SPOOF",
      `source ${JSON.stringify(
        virtualPath
      )} contains reserved resolver header ${JSON.stringify(
        RESOLVER_HEADER_PREFIX.trimEnd()
      )}`
    );
  }

  const observedHash = createHash("sha256")
    .update(source.text, "utf8")
    .digest("hex");
  if (
    source.sha256 !== undefined &&
    (typeof source.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(source.sha256))
  ) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-SOURCE-HASH-SHAPE",
      `source ${JSON.stringify(
        virtualPath
      )} sha256 must be 64 lowercase hexadecimal characters`
    );
  }
  if (source.sha256 !== undefined && source.sha256 !== observedHash) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-SOURCE-HASH-MISMATCH",
      `source ${JSON.stringify(
        virtualPath
      )} sha256 does not match its UTF-8 text`
    );
  }
  return { id, virtualPath, text: source.text, sha256: observedHash };
}

function canonicalInputId(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-INPUT-ID",
      `${label} must be a non-empty string of at most 1024 characters`
    );
  }
  if (!value.isWellFormed()) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-INPUT-ID",
      `${label} contains an isolated UTF-16 surrogate`
    );
  }
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-INPUT-ID",
      `${label} contains a backslash or control character`
    );
  }
  const id = value.normalize("NFC");
  if (
    posix.isAbsolute(id) ||
    /^[A-Za-z]:[\\/]/u.test(id) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(id)
  ) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-INPUT-ID",
      `${label} must be a logical identity, not an absolute host path`
    );
  }
  return id;
}

function canonicalPackagePrefix(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-PACKAGE-PREFIX",
      `${label} must be a non-empty string`
    );
  }
  if (!value.isWellFormed()) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-PACKAGE-PREFIX",
      `${label} contains an isolated UTF-16 surrogate`
    );
  }
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-PACKAGE-PREFIX",
      `${label} contains a backslash or control character`
    );
  }
  const prefix = value.normalize("NFC");
  if (
    prefix.startsWith("/") ||
    prefix.startsWith("./") ||
    prefix.startsWith("../") ||
    prefix.startsWith("@/") ||
    /^[A-Za-z]:/u.test(prefix) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(prefix)
  ) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-PACKAGE-PREFIX",
      `${label} must be a bare portable package prefix`
    );
  }
  const pathPart = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (
    pathPart.length === 0 ||
    pathPart
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-PACKAGE-PREFIX",
      `${label} has an empty, dot, or dot-dot segment`
    );
  }
  return prefix;
}

function packageMapEntries(packageMap) {
  if (packageMap === undefined) return [];
  if (Array.isArray(packageMap)) {
    return packageMap.map((entry, index) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.prefix !== "string" ||
        typeof entry.target !== "string"
      ) {
        throw new VirtualResolverError(
          "VGPU-C1-RESOLVER-PACKAGE-MAP",
          `packageMap entry ${index} must contain string prefix and target fields`
        );
      }
      return [entry.prefix, entry.target];
    });
  }
  if (typeof packageMap === "object" && packageMap !== null) {
    return Object.entries(packageMap);
  }
  throw new VirtualResolverError(
    "VGPU-C1-RESOLVER-PACKAGE-MAP",
    "packageMap must be an object or an array of { prefix, target }"
  );
}

function assertResolvedPathsAreVirtual(resolved, inputByVirtualPath) {
  const declared = new Set(Object.keys(inputByVirtualPath));
  const observed = [
    ...(resolved.deps ?? []),
    ...(resolved.sourceMap?.sources ?? []),
    ...(resolved.ast?.modules ?? []).flatMap((module) => [
      module.path,
      ...(module.exports ?? []).map((item) => item.sourcePath),
    ]),
  ];
  for (const path of observed) {
    const canonical = canonicalVirtualId(path, "resolver output path");
    if (canonical !== path || !declared.has(path)) {
      throw new VirtualResolverError(
        "VGPU-C1-RESOLVER-PATH-LEAK",
        `resolver returned path outside the virtual source set: ${JSON.stringify(
          path
        )}`
      );
    }
  }
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      throw new VirtualResolverError(
        "VGPU-C1-RESOLVER-HASH-UNICODE",
        "canonical requests cannot contain isolated UTF-16 surrogates"
      );
    }
    return JSON.stringify(value.normalize("NFC"));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new VirtualResolverError(
        "VGPU-C1-RESOLVER-HASH-NUMBER",
        "canonical requests cannot contain non-finite numbers"
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-HASH-TYPE",
      `canonical requests cannot contain ${typeof value}`
    );
  }
  if (seen.has(value)) {
    throw new VirtualResolverError(
      "VGPU-C1-RESOLVER-HASH-CYCLE",
      "canonical requests cannot contain cycles"
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalValue(item, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new VirtualResolverError(
        "VGPU-C1-RESOLVER-HASH-TYPE",
        "canonical requests may contain only arrays and plain objects"
      );
    }
    const normalizedKeys = Object.keys(value).map((key) => {
      if (!key.isWellFormed()) {
        throw new VirtualResolverError(
          "VGPU-C1-RESOLVER-HASH-UNICODE",
          "canonical request keys cannot contain isolated UTF-16 surrogates"
        );
      }
      return { raw: key, normalized: key.normalize("NFC") };
    });
    normalizedKeys.sort((left, right) =>
      compareCodeUnits(left.normalized, right.normalized)
    );
    for (let index = 1; index < normalizedKeys.length; index++) {
      if (
        normalizedKeys[index - 1].normalized ===
        normalizedKeys[index].normalized
      ) {
        throw new VirtualResolverError(
          "VGPU-C1-RESOLVER-HASH-KEY-COLLISION",
          `canonical request keys ${JSON.stringify(
            normalizedKeys[index - 1].raw
          )} and ${JSON.stringify(
            normalizedKeys[index].raw
          )} collide after NFC normalization`
        );
      }
    }
    return `{${normalizedKeys
      .map(
        ({ raw, normalized }) =>
          `${JSON.stringify(normalized)}:${canonicalValue(value[raw], seen)}`
      )
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
