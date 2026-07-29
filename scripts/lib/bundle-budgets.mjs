// Shared, side-effect-free logic for `pnpm bundle-check` (scripts/check-bundle-size.mjs).
// Kept separate from IO so the threshold/measurement/update rules stay unit-testable.

/** Budgets are always multiples of this many bytes. */
export const BUDGET_STEP = 512;

/** Default growth threshold for `tooling` budgets: 5% over budget still passes (with a warning). */
export const DEFAULT_GROWTH_THRESHOLD = 0.05;

/** Audience of a measured artifact. Unclassified artifacts default to `client` (hard gate). */
export const DEFAULT_AUDIENCE = "client";

export const AUDIENCES = ["client", "tooling"];

export const EXPORT_BUDGET_FIELD = "vgpuExportBundleBudgetsGzipBytes";
export const PACKAGE_BUDGET_FIELD = "vgpuBundleBudgetGzipBytes";
export const EXPORT_AUDIENCE_FIELD = "vgpuExportBundleAudiences";
export const PACKAGE_AUDIENCE_FIELD = "vgpuBundleAudience";
export const THRESHOLD_FIELD = "vgpuBundleBudgetGrowthThreshold";
export const EXPORT_NOTE_FIELD = "vgpuExportBundleBudgetNote";
export const PACKAGE_NOTE_FIELD = "vgpuBundleBudgetNote";

/**
 * Convention: the smallest 512 B multiple strictly greater than the measured size.
 */
export function nextBudgetBytes(measuredBytes) {
  if (!Number.isFinite(measuredBytes) || measuredBytes < 0) throw new Error(`cannot derive a budget from ${measuredBytes}`);
  return (Math.floor(measuredBytes / BUDGET_STEP) + 1) * BUDGET_STEP;
}

/** Soft ceiling for `tooling` budgets: growth up to this size warns instead of failing. */
export function softLimitBytes(budgetBytes, threshold = DEFAULT_GROWTH_THRESHOLD) {
  return Math.floor(budgetBytes * (1 + threshold));
}

export function resolveThreshold(pkg, override) {
  if (override !== undefined) return override;
  const declared = pkg?.[THRESHOLD_FIELD];
  if (declared === undefined) return DEFAULT_GROWTH_THRESHOLD;
  if (typeof declared !== "number" || !Number.isFinite(declared) || declared < 0) {
    throw new Error(`${pkg.name}: ${THRESHOLD_FIELD} must be a non-negative number, got ${JSON.stringify(declared)}`);
  }
  return declared;
}

/** Audience for an export subpath: per-export override, else package default, else `client`. */
export function resolveExportAudience(pkg, subpath) {
  const audience = pkg?.[EXPORT_AUDIENCE_FIELD]?.[subpath] ?? pkg?.[PACKAGE_AUDIENCE_FIELD] ?? DEFAULT_AUDIENCE;
  return validateAudience(audience, exportLabel(pkg?.name, subpath));
}

export function resolvePackageAudience(pkg) {
  return validateAudience(pkg?.[PACKAGE_AUDIENCE_FIELD] ?? DEFAULT_AUDIENCE, pkg?.name);
}

function validateAudience(audience, label) {
  if (!AUDIENCES.includes(audience)) throw new Error(`${label}: unknown audience ${JSON.stringify(audience)} (expected ${AUDIENCES.join(" | ")})`);
  return audience;
}

/**
 * Verdict for one measured artifact.
 * - `client`: hard gate, any byte over budget fails.
 * - `tooling`: soft gate, over budget warns until the growth threshold is exceeded.
 */
export function evaluateBudget({ measuredBytes, budgetBytes, audience = DEFAULT_AUDIENCE, threshold = DEFAULT_GROWTH_THRESHOLD }) {
  const soft = audience === "tooling";
  const limitBytes = soft ? softLimitBytes(budgetBytes, threshold) : budgetBytes;
  const status = measuredBytes <= budgetBytes ? "ok" : measuredBytes <= limitBytes ? "warn" : "fail";
  return {
    status,
    audience,
    soft,
    threshold: soft ? threshold : 0,
    measuredBytes,
    budgetBytes,
    limitBytes,
    overBudgetBytes: measuredBytes - budgetBytes,
    overLimitBytes: measuredBytes - limitBytes,
    headroomBytes: budgetBytes - measuredBytes,
    suggestedBudgetBytes: Number.isFinite(measuredBytes) ? nextBudgetBytes(measuredBytes) : budgetBytes,
  };
}

export function formatBytes(bytes) {
  return Number.isFinite(bytes) ? `${bytes} B` : "missing artifact";
}

function percent(numerator, denominator) {
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/** One line per artifact, always printed. */
export function formatVerdictLine(label, verdict) {
  const prefix = verdict.status === "ok" ? "" : verdict.status === "warn" ? "WARN " : "FAIL ";
  const head = `${prefix}${label} [${verdict.audience}]: ${formatBytes(verdict.measuredBytes)} gzip / ${verdict.budgetBytes} B budget`;
  if (verdict.status === "ok") return `${head} (headroom ${verdict.headroomBytes} B)`;
  const over = `+${verdict.overBudgetBytes} B over budget`;
  if (verdict.status === "warn") {
    return `${head} (${over}, ${percent(verdict.overBudgetBytes, verdict.budgetBytes)}; within the ${percent(verdict.threshold, 1)} tooling growth threshold, soft limit ${verdict.limitBytes} B)`;
  }
  return `${head} (${over}${verdict.soft ? `, ${verdict.overLimitBytes} B past the ${verdict.limitBytes} B soft limit` : ""})`;
}

/**
 * Actionable failure block: names the budget field, the package/entry, measured vs budget and the
 * `--update` escape hatch, so a red `test-fast` job explains itself (issue #200).
 */
export function formatFailure({ label, field, manifestPath, verdict }) {
  const lines = [`${label}: ${formatBytes(verdict.measuredBytes)} gzip exceeds the ${verdict.soft ? `tooling soft limit of ${verdict.limitBytes}` : `hard client budget of ${verdict.budgetBytes}`} B`];
  lines.push(`  budget field: ${manifestPath} -> ${field} (currently ${verdict.budgetBytes} B, measured ${formatBytes(verdict.measuredBytes)})`);
  if (verdict.soft) {
    lines.push(`  audience: tooling (soft gate) -> growth up to +${percent(verdict.threshold, 1)} (${verdict.limitBytes} B) only warns; this is ${verdict.overLimitBytes} B past that`);
  } else {
    lines.push(`  audience: client (hard gate) -> browser bytes, ${verdict.overBudgetBytes} B over budget; prefer shrinking the entry over raising the budget`);
  }
  lines.push(`  fix: if the growth is intentional run \`pnpm bundle-check --update\` to re-baseline (would write ${verdict.suggestedBudgetBytes} B: next ${BUDGET_STEP} B multiple strictly above measured)`);
  return lines.join("\n");
}

export function exportBudgetField(subpath) {
  return `${EXPORT_BUDGET_FIELD}[${JSON.stringify(subpath)}]`;
}

export function exportLabel(pkgName, subpath) {
  return `${pkgName}${subpath === "." ? "" : subpath.slice(1)}`;
}

export const BUDGET_NOTE = `Gzip ceilings use 512-byte granularity: each budget is the next 512-byte multiple strictly above the measured size. Regenerate with \`pnpm bundle-check --update\`. ${PACKAGE_AUDIENCE_FIELD}/${EXPORT_AUDIENCE_FIELD} select the gate: "client" entries ship to browsers and fail on any byte over budget; "tooling" entries (loaders, Node runtime, CLI, package tarballs) only warn until growth passes ${THRESHOLD_FIELD} (default 5%). Tarballs measure published dist bytes with sourcemap sourcesContent stripped and *.docs.md excluded.`;

/**
 * Tarball measurement (issue #200 C): count published dist bytes only. Co-located `*.docs.md`
 * files are dropped and sourcemap `sourcesContent` is stripped, so documenting the API or emitting
 * maps never competes with the size gate.
 */
export function isMeasuredTarballEntry(path) {
  return !path.endsWith(".docs.md");
}

export function stripSourcesContent(path, contents) {
  if (!path.endsWith(".map")) return contents;
  let map;
  try {
    map = JSON.parse(contents.toString("utf8"));
  } catch {
    return contents;
  }
  if (!Array.isArray(map.sourcesContent)) return contents;
  delete map.sourcesContent;
  return Buffer.from(JSON.stringify(map), "utf8");
}

/**
 * The budget metadata itself is published bytes, so leaving it in would make `--update` chase its
 * own tail (writing a bigger budget grows the manifest, which grows the measurement). Dropping it
 * keeps the measurement invariant under re-baselining, so `--update` converges in one pass.
 */
export function stripBudgetMetadata(path, contents) {
  if (path !== "package/package.json") return contents;
  let manifest;
  try {
    manifest = JSON.parse(contents.toString("utf8"));
  } catch {
    return contents;
  }
  const keys = Object.keys(manifest).filter((key) => /^vgpu(Export)?Bundle/.test(key));
  if (!keys.length) return contents;
  for (const key of keys) delete manifest[key];
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Deterministic payload measured for a package tarball: filtered, stripped files sorted by path. */
export function measuredTarballPayload(entries) {
  return Buffer.concat(
    entries
      .filter((entry) => isMeasuredTarballEntry(entry.path))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((entry) => stripBudgetMetadata(entry.path, stripSourcesContent(entry.path, entry.contents))),
  );
}

const TAR_BLOCK = 512;

/** Entry types this reader understands. Anything else is an error rather than a silent skip. */
const TAR_FILE_TYPES = new Set(["0", "\0", "7"]);
const TAR_SKIPPED_TYPES = new Set(["5", "1", "2", "3", "4", "6"]);

/**
 * Minimal tar reader for npm/pnpm tarballs (ustar with optional GNU long names and PAX headers).
 *
 * This feeds a size gate, so it is deliberately fail-closed: anything it cannot interpret exactly
 * -- an unknown entry type, a non-octal or out-of-range size, a truncated body, a missing
 * end-of-archive marker, an empty archive -- throws instead of returning fewer bytes than the
 * tarball really holds. A silently under-counted measurement would turn a budget into a false pass.
 */
export function parseTarEntries(buffer) {
  const entries = [];
  let offset = 0;
  let terminated = false;
  let pathOverride;
  let sizeOverride;
  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) {
      requireEndOfArchive(buffer, offset);
      terminated = true;
      break;
    }
    const type = String.fromCharCode(header[156] || 0x30);
    const isFile = TAR_FILE_TYPES.has(type);
    const dataSize = isFile && sizeOverride !== undefined ? sizeOverride : readTarSize(header, offset);
    const paddedSize = Math.ceil(dataSize / TAR_BLOCK) * TAR_BLOCK;
    if (offset + TAR_BLOCK + paddedSize > buffer.length) {
      throw new Error(`tar entry at offset ${offset} claims ${dataSize} B but the archive ends after ${buffer.length - offset - TAR_BLOCK} B (truncated archive)`);
    }
    const body = buffer.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + dataSize);
    if (type === "L") {
      pathOverride = body.toString("utf8").replace(/\0+$/, "");
    } else if (type === "x") {
      const records = parsePaxRecords(body, offset);
      if (records.path !== undefined) pathOverride = records.path;
      if (records.size !== undefined) sizeOverride = readPaxSize(records.size, offset);
    } else if (type === "g") {
      const records = parsePaxRecords(body, offset);
      for (const key of ["path", "size"]) {
        if (records[key] !== undefined) throw new Error(`tar global PAX header at offset ${offset} overrides "${key}" for every entry, which this reader does not support`);
      }
    } else if (isFile) {
      entries.push({ path: pathOverride ?? joinTarPath(readField(header, 345, 155), readField(header, 0, 100)), contents: Buffer.from(body) });
      pathOverride = undefined;
      sizeOverride = undefined;
    } else if (TAR_SKIPPED_TYPES.has(type)) {
      pathOverride = undefined;
      sizeOverride = undefined;
    } else {
      throw new Error(`unsupported tar entry type ${JSON.stringify(type)} at offset ${offset} (${JSON.stringify(readField(header, 0, 100))})`);
    }
    offset += TAR_BLOCK + paddedSize;
  }
  if (!terminated) throw new Error(`tar is missing its end-of-archive marker after ${offset} B (truncated archive)`);
  if (!entries.length) throw new Error("tar contains no files, refusing to measure an empty archive");
  return entries;
}

/** The archive must end with two zero blocks and nothing but zero padding after them. */
function requireEndOfArchive(buffer, offset) {
  const tail = buffer.subarray(offset);
  if (tail.length < 2 * TAR_BLOCK) throw new Error(`tar ends with ${tail.length} B of zero padding, expected at least two ${TAR_BLOCK} B zero blocks`);
  const trailing = tail.findIndex((byte) => byte !== 0);
  if (trailing !== -1) throw new Error(`tar has ${tail.length - trailing} B of data after its end-of-archive marker at offset ${offset + trailing}`);
}

function readTarSize(header, offset) {
  if (header[124] & 0x80) throw new Error(`tar entry at offset ${offset} uses a base-256 size field, which this reader does not support`);
  const raw = readField(header, 124, 12).trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error(`tar entry at offset ${offset} has a malformed octal size field ${JSON.stringify(raw)}`);
  const size = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`tar entry at offset ${offset} has an out-of-range size ${JSON.stringify(raw)}`);
  return size;
}

function readPaxSize(raw, offset) {
  const size = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(size)) throw new Error(`tar PAX header at offset ${offset} has a malformed size record ${JSON.stringify(raw)}`);
  return size;
}

/** PAX extended headers are `"<length> <key>=<value>\n"` records; a malformed one is fatal. */
function parsePaxRecords(body, offset) {
  const records = {};
  let cursor = 0;
  while (cursor < body.length) {
    const space = body.indexOf(0x20, cursor);
    if (space === -1) throw new Error(`tar PAX header at offset ${offset} has a record without a length separator`);
    const rawLength = body.subarray(cursor, space).toString("utf8");
    const length = Number(rawLength);
    if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(length) || length <= space - cursor + 1 || cursor + length > body.length) {
      throw new Error(`tar PAX header at offset ${offset} has a record with an invalid length ${JSON.stringify(rawLength)}`);
    }
    if (body[cursor + length - 1] !== 0x0a) throw new Error(`tar PAX header at offset ${offset} has a record that does not end with a newline`);
    const record = body.subarray(space + 1, cursor + length - 1).toString("utf8");
    const separator = record.indexOf("=");
    if (separator === -1) throw new Error(`tar PAX header at offset ${offset} has a record without "=": ${JSON.stringify(record)}`);
    records[record.slice(0, separator)] = record.slice(separator + 1);
    cursor += length;
  }
  return records;
}

function joinTarPath(prefix, name) {
  return prefix ? `${prefix}/${name}` : name;
}

function readField(header, start, length) {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/**
 * Structural exclusions for consumer-experience bundles (T202-06). The checker receives esbuild's
 * metafile input paths and reports the exact retained modules rather than relying on gzip size as
 * a proxy for tree-shaking. Paths may point at either src or dist and are normalized to `/` first.
 */
const EXPERIENCE_EXCLUSIONS = {
  "effect-only": [
    ["scene primitive mesh", /(?:^|\/)mesh-[^/]+(?:\.[^/]+)?$/],
    ["timer", /(?:^|\/)timer(?:\.[^/]+)?$/],
    ["visibility", /(?:^|\/)visibility(?:\.[^/]+)?$/],
    ["query ring", /(?:^|\/)query-ring(?:\.[^/]+)?$/],
    ["compute", /(?:^|\/)compute(?:\.[^/]+)?$/],
    ["bundle", /(?:^|\/)bundle(?:\.[^/]+)?$/],
    ["uniforms", /(?:^|\/)uniforms(?:\.[^/]+)?$/],
    ["storage", /(?:^|\/)storage(?:\.[^/]+)?$/],
    ["geometry descriptor", /(?:^|\/)geometry-descriptor(?:\.[^/]+)?$/],
  ],
  "triangle-low-level": [
    ["scene primitive mesh", /(?:^|\/)mesh-[^/]+(?:\.[^/]+)?$/],
  ],
  // A recipe may retain its own generator and shared cache, but must not pull in the other 14.
  "draw-recipe-box": [
    ["non-box scene primitive mesh", /(?:^|\/)mesh-(?:capsule|cone|cylinder|disk|dodecahedron|fullscreen-quad|icosahedron|icosphere|octahedron|plane|ring|sphere|tetrahedron|torus)(?:\.[^/]+)?$/],
  ],
};

/**
 * Inputs actually retained in an esbuild output. `metafile.inputs` alone lists every scanned
 * module, including dead branches of a barrel, so it cannot support tree-shaking assertions.
 */
export function retainedMetafileInputs(output) {
  return Object.entries(output.inputs ?? {})
    .filter(([, details]) => details.bytesInOutput > 0)
    .map(([input]) => input);
}

/** Returns retained forbidden modules as `{ category, input }`, suitable for CI diagnostics. */
export function prohibitedExperienceInputs(experience, inputs) {
  const exclusions = EXPERIENCE_EXCLUSIONS[experience] ?? [];
  return inputs.flatMap((input) => {
    const normalized = input.replaceAll("\\", "/");
    return exclusions.filter(([, pattern]) => pattern.test(normalized)).map(([category]) => ({ category, input: normalized }));
  });
}
