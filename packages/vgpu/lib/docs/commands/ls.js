import { normalizePath } from "../index.js";
import { fail, ok } from "./shared.js";

export function lsCommand(index, args) {
  if (args.includes("--help") || args.includes("-h")) return ok("Usage: vgpu docs ls [path]");
  if (args.length > 1) return fail("Usage: vgpu docs ls [path]");
  const path = normalizePath(args[0] ?? "/");
  if (path === "/") return ok(index.packages.map((pkg) => `/${pkg}`));

  const children = new Set();
  for (const record of index.records) {
    if (record.virtualPath === path) return ok(record.virtualPath);
    if (!record.virtualPath.startsWith(`${path}/`)) continue;
    const rest = record.virtualPath.slice(path.length + 1);
    children.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest);
  }
  return children.size > 0 ? ok([...children].sort()) : fail(`Path not found: ${path}`);
}
