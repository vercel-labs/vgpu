import { basename } from "node:path";
import type { DocsManifest, DocsRecord } from "../model.ts";

export interface AllowlistEntry {
  package: string;
  symbol: string;
  repoPath: string;
}

export interface FileReader {
  read(path: string): string;
  exists(path: string): boolean;
}

export function parseAllowlist(text: string): AllowlistEntry[] {
  return text
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter(({ line }) => line.length > 0 && !line.startsWith("#"))
    .map(({ line, index }) => {
      const parts = line.split(/\s+/u);
      if (parts.length !== 3) throw new Error(`Invalid allowlist line ${index}: ${line}`);
      const [pkg, symbol, repoPath] = parts;
      if (!repoPath.endsWith(".docs.md")) throw new Error(`Invalid docs path on line ${index}: ${repoPath}`);
      return { package: pkg, symbol, repoPath };
    });
}

export function virtualPathFor(entry: AllowlistEntry): string {
  return `/${entry.package}/${basename(entry.repoPath)}`;
}

export function createManifest(allowlistText: string, files: FileReader): DocsManifest {
  const entries = parseAllowlist(allowlistText).sort(compareEntry);
  const records = entries.map((entry): DocsRecord => {
    if (!files.exists(entry.repoPath)) throw new Error(`Missing docs file: ${entry.repoPath}`);
    const content = files.read(entry.repoPath).replace(/\r\n?/gu, "\n");
    return { ...entry, virtualPath: virtualPathFor(entry), content };
  });
  return { schemaVersion: 1, formatVersion: "1", records };
}

export function serializeManifest(manifest: DocsManifest): string {
  return `import type { DocsManifest } from "../docs/model.ts";\n\nexport const docsManifest = ${JSON.stringify(
    manifest,
    null,
    2,
  )} as const satisfies DocsManifest;\n`;
}

function compareEntry(a: AllowlistEntry, b: AllowlistEntry): number {
  return `${a.package}\0${a.symbol}\0${a.repoPath}`.localeCompare(`${b.package}\0${b.symbol}\0${b.repoPath}`);
}
