import type { CommandResult, DocsIndex } from "../model.ts";
import { fail, normalizePath, ok } from "./shared.ts";

export function lsCommand(index: DocsIndex, args: string[]): CommandResult {
  if (args.includes("--help")) return ok("Usage: vgpu docs ls [path]");
  if (args.length > 1) return fail("Usage: vgpu docs ls [path]");
  const path = normalizePath(args[0] ?? "/");
  if (path === "/") return ok(index.packages.map((pkg) => `/${pkg}`));

  const children = new Set<string>();
  for (const record of index.records) {
    if (record.virtualPath === path) return ok([record.virtualPath]);
    if (!record.virtualPath.startsWith(`${path}/`)) continue;
    const rest = record.virtualPath.slice(path.length + 1);
    children.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest);
  }
  if (children.size === 0) return fail(`Path not found: ${path}`);
  return ok([...children].sort());
}
