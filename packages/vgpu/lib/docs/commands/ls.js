import { normalizePath } from "../index.js";
import { fail, ok } from "./shared.js";

const ROOT_TIP = "Tip: start with \"vgpu docs cat getting-started.md\"; /guides holds concept guides; @vgpu/render/* is low-level tooling.";

export function lsCommand(index, args) {
  if (args.includes("--help") || args.includes("-h")) return ok("Usage: vgpu docs ls [path]");
  if (args.length > 1) return fail("Usage: vgpu docs ls [path]");
  const path = normalizePath(args[0] ?? "/");
  const entries = listDocs(index, path);
  if (!entries) return fail(`Path not found: ${path}`);
  return ok(path === "/" ? [...entries, ROOT_TIP] : entries);
}

export function listDocs(index, path = "/") {
  path = normalizePath(path);
  if (path === "/") return index.packages.map((pkg) => `/${pkg}`);
  if (path === "/guides") {
    const guides = index.records.filter((record) => record.kind === "guide").sort(compareGuide);
    return guides.map((record) => record.virtualPath.slice(path.length + 1));
  }

  const children = new Set();
  for (const record of index.records) {
    if (record.virtualPath === path) return [record.virtualPath];
    if (!record.virtualPath.startsWith(`${path}/`)) continue;
    const rest = record.virtualPath.slice(path.length + 1);
    children.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest);
  }
  return children.size > 0 ? [...children].sort() : undefined;
}

function compareGuide(left, right) {
  if (left.symbol === "getting-started") return -1;
  if (right.symbol === "getting-started") return 1;
  const leftOrdered = typeof left.order === "number";
  const rightOrdered = typeof right.order === "number";
  if (leftOrdered && rightOrdered) return left.order - right.order || left.virtualPath.localeCompare(right.virtualPath);
  if (leftOrdered !== rightOrdered) return leftOrdered ? -1 : 1;
  return left.virtualPath.localeCompare(right.virtualPath);
}
