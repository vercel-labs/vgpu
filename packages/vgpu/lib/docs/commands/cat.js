import { resolveDocsTarget } from "./resolve.js";
import { ambiguous, fail, ok } from "./shared.js";

export function catCommand(index, args) {
  if (args.includes("--help") || args.includes("-h")) return ok("Usage: vgpu docs cat <path|symbol>");
  if (args.length !== 1) return fail("Usage: vgpu docs cat <path|symbol>");
  const target = args[0];
  const { resolved, lookup } = resolveDocsTarget(index, target);
  if (!resolved) return fail(`${lookup === "path" ? "Path" : "Symbol"} not found: ${target}`);
  if (Array.isArray(resolved)) return ambiguous(target, resolved);
  return ok(resolved.content.trimEnd());
}
