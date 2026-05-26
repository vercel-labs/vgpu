import { resolvePath, resolveSymbol } from "../index.js";
import { ambiguous, fail, ok } from "./shared.js";

export function catCommand(index, args) {
  if (args.includes("--help") || args.includes("-h")) return ok("Usage: vgpu docs cat <path|symbol>");
  if (args.length !== 1) return fail("Usage: vgpu docs cat <path|symbol>");
  const target = args[0];
  if (target.startsWith("/")) {
    const record = resolvePath(index, target)[0];
    return record ? ok(record.content.trimEnd()) : fail(`Path not found: ${target}`);
  }
  const resolved = resolveSymbol(index, target);
  if (!resolved) return fail(`Symbol not found: ${target}`);
  if (Array.isArray(resolved)) return ambiguous(target, resolved);
  return ok(resolved.content.trimEnd());
}
