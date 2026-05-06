import type { ImportDecl, ModuleParse } from "./parser.ts";
import type { Token } from "./scanner.ts";
import { wgslError } from "./errors.ts";
import { xxh64 } from "./xxh64.ts";

export interface MangleModule { readonly path: string; readonly source: string; readonly tokens: readonly Token[]; readonly parsed: ModuleParse }
export interface ExportTarget { readonly path: string; readonly localName: string; readonly kind: string }
export type ExportMap = ReadonlyMap<string, ExportTarget>;

export function hash64(text: string): string { return xxh64(text); }
export function hash8(path: string): string { return hash64(path).slice(0, 8); }
export function mangle(path: string, name: string): string { return `_vgsl_${hash8(path)}__${name}`; }

export function assertNoMangleCollisions(paths: readonly string[]): void {
  const owners = new Map<string, string>();
  for (const path of paths) {
    const full = hash64(path), short = full.slice(0, 8), previous = owners.get(short);
    if (previous && previous !== path) throw wgslError("VGPU-WGSL-MANGLE-COLLISION", `VGPU-WGSL-MANGLE-COLLISION: mangle hash collision between ${previous} (${hash64(previous)}) and ${path} (${full}); rename one directory in either canonical path.`);
    owners.set(short, path);
  }
}

export function emitModule(module: MangleModule, exportsByPath: ReadonlyMap<string, ExportMap>, pathOf: (from: string, imp: ImportDecl) => string): string {
  const table = new Map<string, string>();
  for (const local of module.parsed.locals) if (!isVisible(local.kind, module.source, local.name)) table.set(local.name, mangle(module.path, local.name));
  for (const imp of module.parsed.imports) addImports(module, imp, table, exportsByPath, pathOf);
  return stripExports(substitute(module, table, exportsByPath, pathOf));
}

function addImports(module: MangleModule, imp: ImportDecl, table: Map<string, string>, exportsByPath: ReadonlyMap<string, ExportMap>, pathOf: (from: string, imp: ImportDecl) => string): void {
  const targetPath = pathOf(module.path, imp);
  const targetExports = exportsByPath.get(targetPath);
  for (const binding of imp.bindings) {
    if (binding.namespace) continue;
    const target = targetExports?.get(binding.imported);
    if (!target) throw wgslError("VGPU-WGSL-SYM-NOEXPORT", `Module ${targetPath} has no export ${binding.imported}`);
    table.set(binding.local, isTargetVisible(target) ? target.localName : mangle(target.path, target.localName));
  }
}

function substitute(module: MangleModule, table: ReadonlyMap<string, string>, exportsByPath: ReadonlyMap<string, ExportMap>, pathOf: (from: string, imp: ImportDecl) => string): string {
  let out = "", cursor = 0, braceDepth = 0;
  const skip = new Set(module.parsed.imports.flatMap((imp) => range(imp.start, imp.end)));
  const shadowed = new Set<string>();
  for (let i = 0; i < module.tokens.length; i++) {
    const token = module.tokens[i]!;
    if (token.text === "{") braceDepth++;
    if (token.text === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (token.kind === "ident" && isLocalDecl(module.tokens, i, braceDepth)) shadowed.add(token.text);
    if (skip.has(token.start)) { out += module.source.slice(cursor, token.start); cursor = Math.max(cursor, token.end); continue; }
    out += module.source.slice(cursor, token.start);
    const namespace = namespaceReplacement(module, i, exportsByPath, pathOf);
    if (namespace) { out += namespace.name; cursor = namespace.end; i += 2; continue; }
    if (bareNamespace(module, i)) throw wgslError("VGPU-WGSL-NS-NOTVALUE", `Namespace ${token.text} is not a WGSL value`, token.line, token.column);
    out += token.kind === "ident" && !shadowed.has(token.text) && !blocked(module.tokens, i) ? table.get(token.text) ?? token.text : token.text;
    cursor = token.end;
  }
  return out + module.source.slice(cursor);
}

function namespaceReplacement(module: MangleModule, i: number, exportsByPath: ReadonlyMap<string, ExportMap>, pathOf: (from: string, imp: ImportDecl) => string): { name: string; end: number } | undefined {
  const token = module.tokens[i], dot = module.tokens[i + 1], member = module.tokens[i + 2];
  if (token?.kind !== "ident" || dot?.text !== "." || member?.kind !== "ident") return undefined;
  const imp = module.parsed.imports.find((item) => item.bindings.some((b) => b.namespace && b.local === token.text));
  if (!imp) return undefined;
  const targetPath = pathOf(module.path, imp);
  const target = exportsByPath.get(targetPath)?.get(member.text);
  if (!target) throw wgslError("VGPU-WGSL-NS-NOMEMBER", `Namespace ${token.text} has no member ${member.text}`, member.line, member.column);
  return { name: isTargetVisible(target) ? target.localName : mangle(target.path, target.localName), end: member.end };
}

function bareNamespace(module: MangleModule, i: number): boolean { const token = module.tokens[i]; return token?.kind === "ident" && module.parsed.imports.some((item) => item.bindings.some((b) => b.namespace && b.local === token.text)) && module.tokens[i + 1]?.text !== "."; }
function isLocalDecl(tokens: readonly Token[], i: number, braceDepth: number): boolean { const prev = tokens[i - 1]?.text, next = tokens[i + 1]?.text; if (braceDepth > 0 && (prev === "let" || prev === "var")) return true; if (next === ":") for (let j = i; j >= 0 && tokens[j]?.text !== "{" && tokens[j]?.text !== "}"; j--) if (tokens[j]?.text === "fn") return true; return false; }
function blocked(tokens: readonly Token[], i: number): boolean { const prev = tokens[i - 1]?.text, next = tokens[i + 1]?.text; return prev === "@" || prev === "." || (next === ":" && !declared(tokens, i)) || prev === "enable" || prev === "requires" || prev === "override"; }
function declared(tokens: readonly Token[], i: number): boolean { for (let j = i - 1; j >= 0 && tokens[j]?.text !== ";" && tokens[j]?.text !== "{" && tokens[j]?.text !== "}"; j--) if (["var", "let", "const", "override"].includes(tokens[j]!.text)) return true; return false; }
function stripExports(source: string): string { return source.replace(/\bexport\s+(?=@|fn|struct|const|alias|var|override)/g, "").replace(/(@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?\s*)export\s+(?=fn|struct|const|alias|var|override)/g, "$1"); }
function isVisible(kind: string, source: string, name: string): boolean { return kind === "override" || new RegExp(`@(vertex|fragment|compute)[\\s\\S]*?fn\\s+${name}\\b`).test(source); }
function isTargetVisible(target: ExportTarget): boolean { return target.kind === "override" || target.kind === "entry"; }
function range(start: number, end: number): number[] { const values: number[] = []; for (let i = start; i < end; i++) values.push(i); return values; }
