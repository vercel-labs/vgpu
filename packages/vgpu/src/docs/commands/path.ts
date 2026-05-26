import { resolveSymbol } from "../index.ts";
import type { CommandResult, DocsIndex } from "../model.ts";
import { ambiguous, fail, ok } from "./shared.ts";

export function pathCommand(index: DocsIndex, args: string[]): CommandResult {
  if (args.includes("--help")) return ok("Usage: vgpu docs path <symbol>");
  if (args.length !== 1) return fail("Usage: vgpu docs path <symbol>");
  const resolved = resolveSymbol(index, args[0]);
  if (!resolved) return fail(`Symbol not found: ${args[0]}`);
  if (Array.isArray(resolved)) return ambiguous(args[0], resolved);
  return ok(resolved.virtualPath);
}
