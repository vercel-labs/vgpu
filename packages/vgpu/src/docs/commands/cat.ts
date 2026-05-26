import { resolveSymbol, uniqueByPath } from "../index.ts";
import type { CommandResult, DocsIndex } from "../model.ts";
import { ambiguous, fail, ok } from "./shared.ts";

export function catCommand(index: DocsIndex, args: string[]): CommandResult {
  if (args.includes("--help")) return ok("Usage: vgpu docs cat <path|symbol>");
  if (args.length !== 1) return fail("Usage: vgpu docs cat <path|symbol>");
  const target = args[0];
  if (target.startsWith("/")) {
    const record = uniqueByPath(index.paths.get(target) ?? [])[0];
    return record ? ok(record.content.trimEnd()) : fail(`Path not found: ${target}`);
  }
  const resolved = resolveSymbol(index, target);
  if (!resolved) return fail(`Symbol not found: ${target}`);
  if (Array.isArray(resolved)) return ambiguous(target, resolved);
  return ok(resolved.content.trimEnd());
}
