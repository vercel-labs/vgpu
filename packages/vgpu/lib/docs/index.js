import { docsManifest } from "../generated/docs-manifest.generated.js";

export function loadManifest() {
  return docsManifest;
}

export function buildIndex(manifest = loadManifest()) {
  const paths = new Map();
  const symbols = new Map();
  const packages = new Set();
  for (const record of manifest.records) {
    packages.add(record.package);
    push(paths, record.virtualPath, record);
    push(symbols, record.symbol, record);
  }
  return { records: manifest.records, packages: [...packages].sort(), paths, symbols };
}

export function resolveSymbol(index, symbol) {
  const records = index.symbols.get(symbol);
  if (!records || records.length === 0) return undefined;
  const unique = uniqueByPath(records);
  return unique.length === 1 ? unique[0] : unique;
}

export function resolvePath(index, path) {
  return uniqueByPath(index.paths.get(normalizePath(path)) ?? []);
}

export function uniqueByPath(records) {
  return [...new Map(records.map((record) => [record.virtualPath, record])).values()];
}

export function normalizePath(path) {
  if (path === "/") return path;
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function push(map, key, value) {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}
