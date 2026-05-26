import type { CommandResult, DocsIndex } from "../model.ts";
import { fail, ok } from "./shared.ts";

export function symbolsCommand(index: DocsIndex, args: string[]): CommandResult {
  if (args.includes("--help")) return ok("Usage: vgpu docs symbols");
  if (args.length !== 0) return fail("Usage: vgpu docs symbols");
  const lines = index.records.map((record) => `${record.symbol}\t${record.package}\t${record.virtualPath}`);
  return ok([...new Set(lines)].sort());
}
