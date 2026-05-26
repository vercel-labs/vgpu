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

export function createManifest(allowlistText, options = {}) {
  const read = options.read ?? ((path) => readFileSync(path, "utf8"));
  const exists = options.exists ?? (() => true);
  const records = parseAllowlist(allowlistText).map((entry) => {
    if (!exists(entry.repoPath)) throw new Error(`Missing docs file: ${entry.repoPath}`);
    const content = read(entry.repoPath).replace(/\r\n/gu, "\n");
    return { ...entry, virtualPath: virtualPathFor(entry), content };
  });
  records.sort(compareRecord);
  return { schemaVersion: MANIFEST_VERSION, generatedFrom: "docs/allowlist.txt", records };
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function compareRecord(a, b) {
  return `${a.package}\0${a.symbol}\0${a.repoPath}`.localeCompare(`${b.package}\0${b.symbol}\0${b.repoPath}`);
}
