import { docsManifest } from "../generated/docs-manifest.generated.ts";
import type { DocsIndex, DocsManifest, DocsRecord } from "./model.ts";

export function loadManifest(): DocsManifest {
  return docsManifest;
}

export function buildIndex(manifest: DocsManifest = loadManifest()): DocsIndex {
  const records = [...manifest.records].sort(compareRecord);
  const paths = new Map<string, DocsRecord[]>();
  const symbols = new Map<string, DocsRecord[]>();
  for (const record of records) {
    push(paths, record.virtualPath, record);
    push(symbols, record.symbol, record);
  }
  return {
    manifest,
    records,
    paths,
    symbols,
    packages: [...new Set(records.map((record) => record.package))].sort(),
  };
}

export function uniqueByPath(records: DocsRecord[]): DocsRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.virtualPath)) return false;
    seen.add(record.virtualPath);
    return true;
  });
}

export function resolveSymbol(index: DocsIndex, symbol: string): DocsRecord | DocsRecord[] | undefined {
  const hits = uniqueByPath(index.symbols.get(symbol) ?? []);
  if (hits.length === 0) return undefined;
  if (hits.length === 1) return hits[0];
  return hits;
}

function push(map: Map<string, DocsRecord[]>, key: string, record: DocsRecord): void {
  const records = map.get(key);
  if (records) records.push(record);
  else map.set(key, [record]);
}

function compareRecord(a: DocsRecord, b: DocsRecord): number {
  return `${a.virtualPath}\0${a.symbol}`.localeCompare(`${b.virtualPath}\0${b.symbol}`);
}
