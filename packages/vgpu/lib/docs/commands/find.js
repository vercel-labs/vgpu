import { uniqueByPath } from "../index.js";
import { fail, ok } from "./shared.js";

export function findCommand(index, args) {
  if (args.includes("--help") || args.includes("-h")) return ok("Usage: vgpu docs find <query>");
  if (args.length !== 1) return fail("Usage: vgpu docs find <query>");
  const query = args[0].toLowerCase();
  const symbolHits = index.records
    .filter((record) => record.symbol.toLowerCase().includes(query))
    .map((record) => `${record.symbol}\t${record.package}\t${record.virtualPath}`);
  const pathHits = uniqueByPath(index.records)
    .filter((record) => record.virtualPath.toLowerCase().includes(query) || record.repoPath.toLowerCase().includes(query))
    .map((record) => `${record.virtualPath}\t${record.repoPath}`);
  const lines = [...new Set([...symbolHits, ...pathHits])].sort();
  return lines.length > 0 ? ok(lines) : fail(`No docs found for: ${args[0]}`);
}
