import { dirname } from "node:path";
import type { ShaderFunctionExport } from "../types.ts";
import { sourceMap, toAstModule } from "./ast-projection.ts";
import { assertModulesHaveNoBindings } from "./assert-module-purity.ts";
import { cacheKeys } from "./cache-key.ts";
import type { DiagnosticList } from "./diagnostic-types.ts";
import { remember } from "./lru.ts";
import { assertNoMangleCollisions, emitModule, isEntryPoint, type ExportMap, type ExportTarget, type MangleModule } from "./mangler.ts";
import { applyMinifyWgsl, normalizeMinifyOption, type MinifyOption } from "./minify.ts";
import { canonicalEntry, readModule, resolveImport as resolvePath } from "./package-resolution.ts";
import { parseModule, type ImportDecl } from "./parser.ts";
import { reflect, type EntryPointInfo, type Reflection } from "./reflect.ts";
import { reservedIdentifierDiagnostics } from "./reserved-identifiers.ts";
import { reflectSource } from "./reflect-source.ts";
import { eliminateDeadDeclarations } from "./declaration-dce.ts";
import { collectFunctionExports, finalizeFunctionExports } from "./function-exports.ts";
import { applyIdentifierMinifyWgsl } from "./identifier-minify.ts";
import { wgslError } from "./errors.ts";
import { scan } from "./scanner.ts";
import { releaseValidationDevice, retainValidationDevice } from "./validation-device.ts";
import { resolveDefaultValidateMode, validateWGSL, type ValidateMode, type ValidationOutcome } from "./validation.ts";

export { reflectSource } from "./reflect-source.ts";
export type { BindingInfo, BindingKind, BindingRef, EntryPointInfo, EntryPointInputInfo, HostShareableLayout, LayoutMember, ReflectedBindingLayout, Reflection, ReflectionFacade, SamplingPair, WGSLType } from "./reflect.ts";
export type { MinifyOption, MinifyOptions, NormalizedMinifyOptions } from "./minify.ts";
export type { ShaderFunctionExport, ShaderSource } from "../types.ts";
export interface ResolveOptions {
  readonly entry: string;
  readonly rootDir?: string;
  readonly packageMap?: Record<string, string>;
  readonly modules?: Record<string, string>;
  /** Called once for each imported module as soon as its path is resolved, even if loading later fails. */
  readonly onDependency?: (path: string) => void;
  /**
   * Validate emitted WGSL against a real WebGPU adapter (`createShaderModule` plus a
   * compilation-info round trip).
   *
   * - `"off"` / `false` — never attempt validation; device code is never imported.
   * - `"auto"` (default) — attempt validation. If a device is available, invalid WGSL still throws
   *   `VGPU-WGSL-NAGA-UNKNOWN`. If no device/adapter is available, warns once to stderr with the
   *   error code and fix, continues, and records the skip on `ResolvedShader.validation`.
   * - `"require"` / `true` — attempt validation; throws `VGPU-WGSL-VALIDATE-NO-DEVICE` (or
   *   `VGPU-WGSL-VALIDATE-ADAPTER-MISSING`) instead of silently skipping when no device is
   *   available.
   *
   * Defaults to `"auto"`, or to `VGPU_VALIDATE` (`"off"|"auto"|"require"`) when set — an explicit
   * `validate` option here always wins over `VGPU_VALIDATE`.
   *
   * Independent of this option, `minify: true` / `minify: { identifiers: "safe" }` always
   * self-checks that identifier renaming did not orphan a reference to a local it renamed. That
   * check needs no GPU and cannot be disabled.
   */
  readonly validate?: ValidateMode | boolean;
  /**
   * WGSL minification. `true` uses the production preset
   * `{ whitespace: true, identifiers: "safe" }`; object form defaults to
   * whitespace-only minification unless `identifiers: "safe"` is provided.
   */
  readonly minify?: MinifyOption;
}
export interface WGSLModule { readonly path: string; readonly exports: readonly { readonly name: string; readonly localName: string; readonly sourcePath: string }[]; readonly imports: readonly { readonly from: string; readonly bindings: readonly { readonly local: string; readonly imported: string }[] }[]; readonly bytes: number; readonly hash8: string }
export interface WGSLAst { readonly version: 1; readonly modules: readonly WGSLModule[]; readonly diagnostics: DiagnosticList; readonly sourceMap: SourceMap; readonly cacheKey: Record<string, string> }
export interface SourceMap { readonly version: 3; readonly sources: readonly string[]; readonly mappings: string }
export interface ResolvedShader { readonly wgsl: string; readonly functionExports: readonly ShaderFunctionExport[]; readonly deps: readonly string[]; readonly cacheKey: Record<string, string>; readonly ast: WGSLAst; readonly sourceMap: SourceMap; readonly diagnostics: DiagnosticList; readonly reflection: Reflection; readonly validation: { readonly mode: ValidateMode; readonly attempted: boolean; readonly ok: boolean; readonly skipped?: { readonly code: string; readonly message: string; readonly fix?: string } } }

const scanCache = new Map<string, MangleModule>();

/** `true` -> `"require"`, `false` -> `"off"`, unset -> `VGPU_VALIDATE` (default `"auto"`). */
function normalizeValidateMode(value: ResolveOptions["validate"]): ValidateMode {
  if (value === undefined) return resolveDefaultValidateMode();
  if (value === true) return "require";
  if (value === false) return "off";
  return value;
}

export async function resolveShader(opts: ResolveOptions): Promise<ResolvedShader> {
  const loaded = new Map<string, MangleModule>();
  const diagnostics: DiagnosticList[number][] = [];
  const entry = canonicalEntry(opts.entry, opts);
  await loadGraph(entry, opts, loaded, [], diagnostics);
  const modules = [...loaded.values()];
  const deps = [...loaded.keys()].sort();
  assertModulesHaveNoBindings(modules, entry);
  assertNoMangleCollisions(modules.map((module) => module.path));
  assertNoJsVisibleDuplicates(modules);
  for (const module of modules) diagnostics.push(...reservedIdentifierDiagnostics(module));
  const exportsByPath = buildExports(modules);
  const pathOf = (from: string, imp: ImportDecl) => resolvePath(imp.from, from, opts, diagnostics);
  const emittedWgsl = eliminateDeadDeclarations(modules.map((module) => `// vgsl-module: ${module.path}\n${emitModule(module, exportsByPath, pathOf).trim()}\n`).join("\n"));
  const functionExportCandidates = collectFunctionExports(modules);
  const reflection = reflect(modules, pathOf);
  const emittedReflection = reflectSource(emittedWgsl, entry);
  for (const reflectedEntry of reflection.entryPoints) {
    const emittedEntry = emittedReflection.entryPoints.find((item) => item.name === reflectedEntry.mangledName);
    // Whole-program re-attachment: per-module reflection cannot see bindings reached through
    // imported helpers, so overwrite with the values reflected off the emitted program. The
    // `readonly` markers on `EntryPointInfo` are a contract for consumers, not for this builder —
    // narrow the mutation to these two fields instead of widening the public type.
    const mutable = reflectedEntry as { -readonly [K in "bindings" | "samplingPairs"]: EntryPointInfo[K] };
    if (emittedEntry?.bindings) mutable.bindings = emittedEntry.bindings;
    if (emittedEntry?.samplingPairs) mutable.samplingPairs = emittedEntry.samplingPairs;
  }
  const map = sourceMap(modules);
  const minify = normalizeMinifyOption(opts.minify);
  const validateMode = normalizeValidateMode(opts.validate);
  // One lease for the whole call: this function validates twice whenever minification rewrote the
  // emitted text, and without an outer lease the idle release could destroy the device between the
  // two, paying full adapter discovery again mid-call. Released in `finally` so a thrown diagnostic
  // still frees it.
  if (validateMode !== "off") retainValidationDevice();
  let validationOutcome: ValidationOutcome;
  let wgsl: string;
  let identifierReplacements: ReadonlyMap<number, string> = new Map();
  try {
    validationOutcome = validateMode === "off" ? { attempted: false, ok: true } : await validateWGSL(emittedWgsl, validateMode);
    if (minify.identifiers === "safe") {
      const result = applyIdentifierMinifyWgsl(emittedWgsl, { whitespace: minify.whitespace });
      wgsl = result.wgsl;
      identifierReplacements = result.replacements;
    } else {
      wgsl = applyMinifyWgsl(emittedWgsl, minify);
    }
    if (validateMode !== "off" && wgsl !== emittedWgsl) {
      // The artifact the caller receives is the artifact that gets validated. The first pass above
      // stays because it runs on the pre-minify text and so yields accurate line/column diagnostics;
      // this pass is what makes `validation.ok === true` a statement about the returned `wgsl`,
      // whatever the minify mode (whitespace-only included — a whitespace-stage bug used to escape
      // here). Skipped when minification was a no-op: the same string was already validated.
      // Both calls share the memoized device from validation-device.ts, so they agree in practice;
      // merging keeps the reported outcome correct if that ever stops being true.
      const second = await validateWGSL(wgsl, validateMode);
      validationOutcome = { attempted: validationOutcome.attempted || second.attempted, ok: validationOutcome.ok && second.ok, ...((validationOutcome.skipped ?? second.skipped) ? { skipped: validationOutcome.skipped ?? second.skipped } : {}) };
    }
  } finally {
    if (validateMode !== "off") releaseValidationDevice();
  }
  const cacheKey = cacheKeys(modules, reflection, opts.rootDir ?? dirname(entry));
  const ast: WGSLAst = { version: 1, modules: modules.map(toAstModule), diagnostics, sourceMap: map, cacheKey };
  const functionExports = finalizeFunctionExports(functionExportCandidates, emittedWgsl, identifierReplacements);
  return { wgsl, functionExports, deps, cacheKey, ast, sourceMap: map, diagnostics, reflection, validation: { mode: validateMode, ...validationOutcome } };
}

async function loadGraph(path: string, opts: ResolveOptions, loaded: Map<string, MangleModule>, stack: string[], diagnostics: DiagnosticList[number][]): Promise<void> {
  if (stack.includes(path)) throw wgslError("VGPU-WGSL-IMP-SELF", `Import cycle: ${[...stack, path].join(" -> ")}`);
  if (loaded.has(path)) return;
  const source = await readModule(path, opts);
  const cacheKey = `${path}:${source}`;
  let module = scanCache.get(cacheKey);
  if (!module) { const tokens = scan(source, path); module = { path, source, tokens, parsed: parseModule(tokens) }; remember(scanCache, cacheKey, module); }
  loaded.set(path, module);
  stack.push(path);
  for (const imp of module.parsed.imports) {
    const dependency = resolvePath(imp.from, path, opts, diagnostics);
    if (!loaded.has(dependency)) opts.onDependency?.(dependency);
    await loadGraph(dependency, opts, loaded, stack, diagnostics);
  }
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
function entryKind(module: MangleModule, name: string, kind: string): string { return isEntryPoint(module, name) ? "entry" : kind; }
