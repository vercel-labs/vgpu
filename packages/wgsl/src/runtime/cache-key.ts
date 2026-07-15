import { createHash } from "node:crypto";
import type { MangleModule } from "./mangler.ts";
import type { Reflection } from "./reflect.ts";

export function cacheKeys(modules: readonly MangleModule[], reflection: Reflection, rootDir: string): Record<string, string> {
  const entries = reflection.entryPoints.length ? reflection.entryPoints.map((entry) => entry.name) : ["main"];
  const keys: Record<string, string> = {};
  for (const entryPoint of entries) {
    const graph = {
      bindings: [...reflection.bindings].sort((a, b) => a.group - b.group || a.binding - b.binding),
      entryPoint,
      overrides: [...reflection.overrides].map((item) => item.name).sort(),
      reachableModules: modules.map((module) => ({
        deps: module.parsed.imports.map((imp) => imp.from).sort(),
        exports: module.parsed.exports.map((exp) => exp.name).sort(),
        modulePath: module.path.replace(rootDir, "").replace(/^\//, ""),
        normalizedSourceHash: sha(normalize(module.source)),
      })).sort((a, b) => a.modulePath.localeCompare(b.modulePath)),
      rootDir: rootDir.split(/[\\/]/).filter(Boolean).pop() ?? "",
      types: "",
      version: "vgsl-1",
    };
    keys[entryPoint] = `vgsl-1:${sha(canonical(graph)).slice(0, 32)}`;
  }
  return keys;
}

function normalize(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/\s+/g, "");
}
function sha(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
