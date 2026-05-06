import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { wgslError, wgslWarning } from "./errors.ts";
import type { Diagnostic } from "./diagnosticTypes.ts";

export interface PackageResolveOptions { readonly entry: string; readonly rootDir?: string; readonly packageMap?: Record<string, string>; readonly modules?: Record<string, string> }

export function resolveImport(spec: string, from: string, opts: PackageResolveOptions, diagnostics: Diagnostic[]): string {
  if (spec.startsWith("/")) throw wgslError("VGPU-WGSL-RES-ABS", "Absolute WGSL imports are not portable");
  if (spec.startsWith("@/") && opts.rootDir) return opts.modules ? defaultVirtual(join(opts.rootDir, spec.slice(2)), opts.modules) : defaultFile(join(opts.rootDir, spec.slice(2)));
  for (const [prefix, target] of Object.entries(opts.packageMap ?? {})) if (spec.startsWith(prefix)) return opts.modules ? defaultVirtual(join(target, spec.slice(prefix.length)), opts.modules) : defaultFile(join(target, spec.slice(prefix.length)));
  if (opts.modules && (spec.startsWith("./") || spec.startsWith("../"))) return defaultVirtual(join(dirname(from), spec), opts.modules);
  if (opts.modules) throw wgslError("VGPU-WGSL-PKG-NOTFOUND", `Package ${spec.split("/")[0]} was not found`);
  if (spec.startsWith("./") || spec.startsWith("../")) return defaultFile(resolve(dirname(from), spec));
  return packageImport(spec, from, diagnostics);
}

export function readModule(path: string, opts: PackageResolveOptions): string {
  const text = opts.modules?.[path];
  if (text !== undefined) return text;
  if (existsSync(path)) return readFileSync(path, "utf8");
  throw wgslError("VGPU-WGSL-RES-NOTFOUND", `WGSL module ${path} was not found`);
}

export function canonicalEntry(entry: string, opts: PackageResolveOptions): string {
  return opts.modules ? defaultVirtual(entry, opts.modules) : defaultFile(resolve(entry));
}

function packageImport(spec: string, from: string, diagnostics: Diagnostic[]): string {
  const parts = spec.split("/");
  const pkg = spec.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
  const sub = `.${spec.slice(pkg.length) || ""}`;
  for (let dir = dirname(from);;) {
    const pkgJson = join(dir, "node_modules", pkg, "package.json");
    if (existsSync(pkgJson)) return packageExport(pkgJson, sub, diagnostics);
    if (isWorkspaceRoot(dir)) break;
    const next = dirname(dir); if (next === dir) break; dir = next;
  }
  throw wgslError("VGPU-WGSL-PKG-NOTFOUND", `Package ${pkg} was not found`);
}

function packageExport(pkgJson: string, sub: string, diagnostics: Diagnostic[]): string {
  const root = dirname(pkgJson);
  const parsed = JSON.parse(readFileSync(pkgJson, "utf8")) as { exports?: Record<string, string | Record<string, string>> };
  const value = parsed.exports?.[sub];
  if (typeof value === "string") return defaultFile(join(root, value));
  if (value && typeof value.default === "string") {
    warnOnce(diagnostics, "VGPU-WGSL-PKG-CONDITIONAL", `Package export ${sub} uses conditional exports; selecting default`);
    return defaultFile(join(root, value.default));
  }
  for (const [key, target] of Object.entries(parsed.exports ?? {})) if (key.includes("*") && typeof target === "string") {
    const [before, after] = key.split("*") as [string, string];
    if (sub.startsWith(before) && sub.endsWith(after)) return defaultFile(join(root, target.replace("*", sub.slice(before.length, sub.length - after.length))));
  }
  throw wgslError("VGPU-WGSL-PKG-NOTFOUND", `Package export ${sub} was not found`);
}

function warnOnce(diagnostics: Diagnostic[], code: string, message: string): void { if (!diagnostics.some((item) => item.code === code && item.message === message)) diagnostics.push(wgslWarning(code, message)); }
function defaultVirtual(path: string, modules: Record<string, string>): string { const clean = normalize(path).replace(/\\/g, "/"); if (modules[clean] !== undefined) return clean; if (modules[`${clean}.wgsl`] !== undefined) return `${clean}.wgsl`; if (modules[`${clean}/index.wgsl`] !== undefined) return `${clean}/index.wgsl`; throw wgslError("VGPU-WGSL-RES-NOTFOUND", `WGSL module ${clean} was not found`); }
function defaultFile(path: string): string { if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.wgsl"); for (const choice of extname(path) ? [path] : [`${path}.wgsl`, join(path, "index.wgsl")]) if (existsSync(choice)) return choice; throw wgslError("VGPU-WGSL-RES-NOTFOUND", `WGSL module ${path} was not found`); }
function isWorkspaceRoot(dir: string): boolean { return existsSync(join(dir, "pnpm-workspace.yaml")) || existsSync(join(dir, ".git")) || dirname(dir) === dir; }
