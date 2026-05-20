import { dirname } from "node:path";
import { sourceMap, toAstModule } from "./astProjection.ts";
import { cacheKeys } from "./cacheKey.ts";
import type { DiagnosticList } from "./diagnosticTypes.ts";
import { remember } from "./lru.ts";
import { assertNoMangleCollisions, emitModule, type ExportMap, type ExportTarget, type MangleModule } from "./mangler.ts";
import { minifyWgsl } from "./minify.ts";
import { canonicalEntry, readModule, resolveImport as resolvePath } from "./packageResolution.ts";
import { parseModule, type ImportDecl } from "./parser.ts";
import { reflect, type Reflection } from "./reflect.ts";
import { wgslError } from "./errors.ts";
import { scan } from "./scanner.ts";
import { validateWGSL } from "./validation.ts";

export interface ResolveOptions { readonly entry: string; readonly rootDir?: string; readonly packageMap?: Record<string, string>; readonly modules?: Record<string, string>; readonly validate?: boolean; readonly minify?: boolean }
export interface WGSLModule { readonly path: string; readonly exports: readonly { readonly name: string; readonly localName: string; readonly sourcePath: string }[]; readonly imports: readonly { readonly from: string; readonly bindings: readonly { readonly local: string; readonly imported: string }[] }[]; readonly bytes: number; readonly hash8: string }
export interface WGSLAst { readonly version: 1; readonly modules: readonly WGSLModule[]; readonly diagnostics: DiagnosticList; readonly sourceMap: SourceMap; readonly cacheKey: Record<string, string> }
export interface SourceMap { readonly version: 3; readonly sources: readonly string[]; readonly mappings: string }
export interface ResolvedShader { readonly wgsl: string; readonly deps: readonly string[]; readonly cacheKey: Record<string, string>; readonly ast: WGSLAst; readonly sourceMap: SourceMap; readonly diagnostics: DiagnosticList; readonly reflection: Reflection }

const scanCache = new Map<string, MangleModule>();

export async function resolveShader(opts: ResolveOptions): Promise<ResolvedShader> {
  const loaded = new Map<string, MangleModule>();
  const diagnostics: DiagnosticList[number][] = [];
  const entry = canonicalEntry(opts.entry, opts);
  await loadGraph(entry, opts, loaded, [], diagnostics);
  const modules = [...loaded.values()];
  const deps = [...loaded.keys()].sort();
  assertNoMangleCollisions(modules.map((module) => module.path));
  assertNoJsVisibleDuplicates(modules);
  const exportsByPath = buildExports(modules);
  const pathOf = (from: string, imp: ImportDecl) => resolvePath(imp.from, from, opts, diagnostics);
  const emittedWgsl = modules.map((module) => `// vgsl-module: ${module.path}\n${emitModule(module, exportsByPath, pathOf).trim()}\n`).join("\n");
  const reflection = reflect(modules);
  const map = sourceMap(modules);
  if (opts.validate !== false) await validateWGSL(emittedWgsl);
  const wgsl = opts.minify === true ? minifyWgsl(emittedWgsl) : emittedWgsl;
  const cacheKey = cacheKeys(modules, reflection, opts.rootDir ?? dirname(entry));
  const ast: WGSLAst = { version: 1, modules: modules.map(toAstModule), diagnostics, sourceMap: map, cacheKey };
  return { wgsl, deps, cacheKey, ast, sourceMap: map, diagnostics, reflection };
}

async function loadGraph(path: string, opts: ResolveOptions, loaded: Map<string, MangleModule>, stack: string[], diagnostics: DiagnosticList[number][]): Promise<void> {
  if (stack.includes(path)) throw wgslError("VGPU-WGSL-IMP-SELF", `Import cycle: ${[...stack, path].join(" -> ")}`);
  if (loaded.has(path)) return;
  const source = await readModule(path, opts);
  const cacheKey = `${path}:${source}`;
  let module = scanCache.get(cacheKey);
  if (!module) { const tokens = scan(source); module = { path, source, tokens, parsed: parseModule(tokens) }; remember(scanCache, cacheKey, module); }
  loaded.set(path, module);
  stack.push(path);
  for (const imp of module.parsed.imports) await loadGraph(resolvePath(imp.from, path, opts, diagnostics), opts, loaded, stack, diagnostics);
  stack.pop();
}

function buildExports(modules: readonly MangleModule[]): ReadonlyMap<string, ExportMap> {
  const byPath = new Map<string, ExportMap>();
  for (const module of modules) {
    const exports = new Map<string, ExportTarget>();
    for (const item of module.parsed.exports) exports.set(item.name, { path: module.path, localName: item.localName, kind: entryKind(module, item.localName, item.kind) });
    byPath.set(module.path, exports);
  }
  for (const module of modules) checkImportShadows(module);
  return byPath;
}

function checkImportShadows(module: MangleModule): void {
  const imported = new Set<string>();
  for (const imp of module.parsed.imports) for (const binding of imp.bindings) {
    if (imported.has(binding.local)) throw wgslError("VGPU-WGSL-SYM-IMPORT-SHADOW", `Import ${binding.local} conflicts with another import`);
    imported.add(binding.local);
    if (!binding.namespace && module.parsed.locals.some((local) => local.name === binding.local)) throw wgslError("VGPU-WGSL-SYM-IMPORT-SHADOW", `Import ${binding.local} shadows a local symbol`);
  }
}

function assertNoJsVisibleDuplicates(modules: readonly MangleModule[]): void {
  const overrides = new Map<string, string>(), entries = new Map<string, string>();
  for (const module of modules) for (const local of module.parsed.locals) {
    if (local.kind === "override") duplicate(overrides, local.name, module.path, "VGPU-WGSL-OVERRIDE-DUP");
    if (entryKind(module, local.name, local.kind) === "entry") duplicate(entries, local.name, module.path, "VGPU-WGSL-ENTRYPOINT-DUP");
  }
}
function duplicate(map: Map<string, string>, name: string, path: string, code: string): void { const previous = map.get(name); if (previous) throw wgslError(code, `${name} appears in ${previous} and ${path}`); map.set(name, path); }
function entryKind(module: MangleModule, name: string, kind: string): string { return module.source.match(new RegExp(`@(vertex|fragment|compute)[\\s\\S]*?fn\\s+${name}\\b`)) ? "entry" : kind; }
