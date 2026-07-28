// Shared, side-effect-free logic for `pnpm bundle-check` (scripts/check-bundle-size.mjs).
// Kept separate from IO so the threshold/measurement/update rules stay unit-testable.

/** Budgets are always multiples of this many bytes. */
export const BUDGET_STEP = 512;

/** Minimum guaranteed headroom between a measured size and its budget. */
export const MIN_HEADROOM = 512;

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
 * Convention: the smallest multiple of 512 that sits at least 512 B above the measured size, so
 * headroom is never an accident of rounding (see issue #200).
 */
export function nextBudgetBytes(measuredBytes) {
  if (!Number.isFinite(measuredBytes) || measuredBytes < 0) throw new Error(`cannot derive a budget from ${measuredBytes}`);
  return Math.ceil((measuredBytes + MIN_HEADROOM) / BUDGET_STEP) * BUDGET_STEP;
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
  lines.push(`  fix: if the growth is intentional run \`pnpm bundle-check --update\` to re-baseline (would write ${verdict.suggestedBudgetBytes} B: next ${BUDGET_STEP} B multiple at least ${MIN_HEADROOM} B above measured)`);
  return lines.join("\n");
}

export function exportBudgetField(subpath) {
  return `${EXPORT_BUDGET_FIELD}[${JSON.stringify(subpath)}]`;
}

export function exportLabel(pkgName, subpath) {
  return `${pkgName}${subpath === "." ? "" : subpath.slice(1)}`;
}

export const BUDGET_NOTE = `Gzip ceilings use 512-byte granularity: each budget is the next 512-byte multiple at least 512 B above the measured size, so headroom is never a rounding accident. Regenerate with \`pnpm bundle-check --update\`. ${PACKAGE_AUDIENCE_FIELD}/${EXPORT_AUDIENCE_FIELD} select the gate: "client" entries ship to browsers and fail on any byte over budget; "tooling" entries (loaders, Node runtime, CLI, package tarballs) only warn until growth passes ${THRESHOLD_FIELD} (default 5%). Tarballs measure published dist bytes with sourcemap sourcesContent stripped and *.docs.md excluded.`;

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

/** Minimal ustar reader: npm/pnpm tarballs only hold regular files, directories and GNU long names. */
export function parseTarEntries(buffer) {
  const entries = [];
  let offset = 0;
  let longName;
  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = readField(header, 0, 100);
    const size = Number.parseInt(readField(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const body = buffer.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + size);
    if (type === "L") longName = body.toString("utf8").replace(/\0+$/, "");
    else if (type === "0" || type === "\0") entries.push({ path: longName ?? joinTarPath(readField(header, 345, 155), name), contents: Buffer.from(body) });
    if (type !== "L") longName = undefined;
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return entries;
}

function joinTarPath(prefix, name) {
  return prefix ? `${prefix}/${name}` : name;
}

function readField(header, start, length) {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}
