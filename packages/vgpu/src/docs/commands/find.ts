import { uniqueByPath } from "../index.ts";
import type { CommandResult, DocsIndex } from "../model.ts";
import { fail, ok } from "./shared.ts";

export function findCommand(index: DocsIndex, args: string[]): CommandResult {
  if (args.includes("--help")) return ok("Usage: vgpu docs find <term>");
  if (args.length !== 1) return fail("Usage: vgpu docs find <term>");
  const term = args[0].toLowerCase();
  const symbolHits = index.records
    .filter((record) => record.symbol.toLowerCase().includes(term))
    .map((record) => `${record.symbol}\t${record.package}\t${record.virtualPath}`);
  if (symbolHits.length > 0) return ok([...new Set(symbolHits)].sort());

  const pathHits = uniqueByPath(index.records)
    .filter((record) => record.virtualPath.toLowerCase().includes(term) || record.repoPath.toLowerCase().includes(term))
    .map((record) => `${record.virtualPath}\t${record.repoPath}`);
  return pathHits.length > 0 ? ok(pathHits.sort()) : fail(`No docs found for: ${args[0]}`);
}
