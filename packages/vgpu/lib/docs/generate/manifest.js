import { readFileSync } from "node:fs";
import { MANIFEST_VERSION } from "../model.js";

export function parseAllowlist(text) {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [packageName, symbol, repoPath, ...extra] = line.split(/\s+/u);
    if (!packageName || !symbol || !repoPath || extra.length > 0) throw new Error(`Invalid allowlist line: ${line}`);
    return { package: packageName, symbol, repoPath };
  });
}

export function virtualPathFor(entry) {
  return `/${entry.package}/${entry.repoPath.split("/").at(-1)}`;
}

// Guide docs are conceptual topics (not tied to an exported symbol). They live under the synthetic
// "guides" package; the symbol is the file slug so `vgpu docs cat <slug>` resolves.
export function guideEntryFor(repoPath) {
  const file = repoPath.split("/").at(-1);
  return { package: "guides", symbol: file.replace(/\.docs\.md$/u, ""), repoPath };
}

export function guideVirtualPathFor(repoPath) {
  return `/guides/${repoPath.split("/").at(-1)}`;
}

/**
 * Builds the docs manifest from the allowlist (per-symbol API docs) and an optional list of guide
 * doc paths (conceptual topics under docs/topics). Every record carries a `kind` ("api" | "guide").
 */
export function createManifest(allowlistText, options = {}) {
  const read = options.read ?? ((path) => readFileSync(path, "utf8"));
  const exists = options.exists ?? (() => true);
  const load = (repoPath) => {
    if (!exists(repoPath)) throw new Error(`Missing docs file: ${repoPath}`);
    return read(repoPath).replace(/\r\n/gu, "\n");
  };

  const apiRecords = parseAllowlist(allowlistText).map((entry) => ({
    ...entry,
    kind: "api",
    virtualPath: virtualPathFor(entry),
    content: load(entry.repoPath),
  }));

  const guideRecords = (options.guides ?? []).map((repoPath) => ({
    ...guideEntryFor(repoPath),
    kind: "guide",
    virtualPath: guideVirtualPathFor(repoPath),
    content: load(repoPath),
  }));

  const records = [...apiRecords, ...guideRecords].sort(compareRecord);
  return { schemaVersion: MANIFEST_VERSION, generatedFrom: "docs/allowlist.txt + docs/topics", records };
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function compareRecord(a, b) {
  return `${a.package}\0${a.symbol}\0${a.repoPath}`.localeCompare(`${b.package}\0${b.symbol}\0${b.repoPath}`);
}
