import type { ImportDecl, ModuleParse } from "./parser.ts";
import { scan, type Token } from "./scanner.ts";
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
  for (const local of module.parsed.locals) if (!isVisible(local.kind, module, local.name)) table.set(local.name, mangle(module.path, local.name));
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
  let out = "", cursor = 0;
  const skip = new Set(module.parsed.imports.flatMap((imp) => range(imp.start, imp.end)));
  const shadowed = shadowedTokens(module.tokens);
  for (let i = 0; i < module.tokens.length; i++) {
    const token = module.tokens[i]!;
    if (skip.has(token.start)) { out += module.source.slice(cursor, token.start); cursor = Math.max(cursor, token.end); continue; }
    out += module.source.slice(cursor, token.start);
    const namespace = namespaceReplacement(module, i, exportsByPath, pathOf);
    if (namespace) { out += namespace.name; cursor = namespace.end; i += 2; continue; }
    if (bareNamespace(module, i)) throw wgslError("VGPU-WGSL-NS-NOTVALUE", `Namespace ${token.text} is not a WGSL value`, token.line, token.column);
    out += token.kind === "ident" && !shadowed.has(i) && !blocked(module.tokens, i) ? table.get(token.text) ?? token.text : token.text;
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
/**
 * Token indices at which a function-scope local hides a module-scope name.
 *
 * This used to be a flat `Set<string>` of every local name seen so far, and it never closed: one
 * `let helper` in a nested block — or a parameter named `helper` on an unrelated function — stopped
 * every *later* `helper` token in the module from being mangled, while the declaration itself,
 * emitted before the shadow, still was. Declaration DCE then correctly dropped the mangled
 * declaration nothing referenced any more and the shader failed to compile with
 * `unresolved call target 'helper'`. Scoping each shadow to the block that introduced it fixes it.
 */
function shadowedTokens(tokens: readonly Token[]): ReadonlySet<number> {
  const shadowed = new Set<number>();
  const hide = (name: string, start: number, end: number): void => { for (let i = start; i <= end; i++) if (tokens[i]?.text === name) shadowed.add(i); };
  for (let i = 0, depth = 0; i < tokens.length; i++) {
    const text = tokens[i]!.text;
    if (text === "{") depth++;
    else if (text === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && text === "fn") i = hideFunctionLocals(tokens, i, hide);
  }
  return shadowed;
}

/** Parameters shadow the body only; a local shadows from its own `;` to the end of its block. */
function hideFunctionLocals(tokens: readonly Token[], fnIndex: number, hide: (name: string, start: number, end: number) => void): number {
  const open = seek(tokens, fnIndex, "("), close = open === undefined ? undefined : matchPair(tokens, open, "(", ")");
  const bodyOpen = close === undefined ? undefined : seek(tokens, close, "{"), bodyClose = bodyOpen === undefined ? undefined : matchPair(tokens, bodyOpen, "{", "}");
  if (open === undefined || close === undefined || bodyOpen === undefined || bodyClose === undefined) return fnIndex;
  // A parameter is in scope in the body compound statement only, so sibling parameter types, their
  // template args and the `-> ReturnType` still name module scope and must stay substitutable. The
  // parameter's own token needs no hiding: `blocked()` already refuses any ident followed by `:`
  // that is not a var/let/const declaration.
  for (let i = open + 1; i < close; i++) if (tokens[i]!.kind === "ident" && tokens[i + 1]?.text === ":") hide(tokens[i]!.text, bodyOpen, bodyClose);
  const scopeEnds = [bodyClose];
  for (let i = bodyOpen + 1; i < bodyClose; i++) {
    while (scopeEnds.length > 1 && i > scopeEnds[scopeEnds.length - 1]!) scopeEnds.pop();
    const text = tokens[i]!.text;
    // A `for` frame spans header plus body so a loop variable does not leak past the loop.
    if (text === "for" || text === "{") { scopeEnds.push(blockEnd(tokens, i, scopeEnds[scopeEnds.length - 1]!)); continue; }
    if (text !== "let" && text !== "var" && text !== "const") continue;
    const name = localNameIndex(tokens, i);
    if (name === undefined || name >= bodyClose) continue;
    // WGSL brings a local into scope only at the end of its declaration statement, so the
    // initializer in `let helper = helper(1.0);` still names the module-scope `helper`. Hide the
    // declared token itself (it must never be rewritten) plus everything after the `;`.
    hide(tokens[name]!.text, name, name);
    hide(tokens[name]!.text, (seek(tokens, name, ";") ?? name) + 1, scopeEnds[scopeEnds.length - 1]!);
    i = name;
  }
  return bodyClose;
}

function blockEnd(tokens: readonly Token[], index: number, fallback: number): number {
  if (tokens[index]!.text === "{") return matchPair(tokens, index, "{", "}") ?? fallback;
  const header = seek(tokens, index, "("), close = header === undefined ? undefined : matchPair(tokens, header, "(", ")");
  const body = close === undefined ? undefined : seek(tokens, close, "{");
  return (body === undefined ? undefined : matchPair(tokens, body, "{", "}")) ?? fallback;
}

function localNameIndex(tokens: readonly Token[], kindIndex: number): number | undefined {
  let i = kindIndex + 1;
  if (tokens[i]?.text === "<") { const end = matchPair(tokens, i, "<", ">"); if (end === undefined) return undefined; i = end + 1; }
  return tokens[i]?.kind === "ident" ? i : undefined;
}

function seek(tokens: readonly Token[], start: number, text: string): number | undefined { for (let i = start + 1; i < tokens.length; i++) if (tokens[i]!.text === text) return i; return undefined; }
function matchPair(tokens: readonly Token[], openIndex: number, open: string, close: string): number | undefined { let depth = 0; for (let i = openIndex; i < tokens.length; i++) { if (tokens[i]!.text === open) depth++; else if (tokens[i]!.text === close && --depth === 0) return i; } return undefined; }
function blocked(tokens: readonly Token[], i: number): boolean { const prev = tokens[i - 1]?.text, next = tokens[i + 1]?.text; return prev === "@" || prev === "." || (next === ":" && !declared(tokens, i)) || prev === "enable" || prev === "requires" || prev === "override"; }
function declared(tokens: readonly Token[], i: number): boolean { for (let j = i - 1; j >= 0 && tokens[j]?.text !== ";" && tokens[j]?.text !== "{" && tokens[j]?.text !== "}"; j--) if (["var", "let", "const", "override"].includes(tokens[j]!.text)) return true; return false; }
const exportDeclarationKinds = new Set(["fn", "struct", "const", "alias", "var", "override"]);

function stripExports(source: string): string {
  const tokens = scan(source);
  let out = "";
  let cursor = 0;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isCommentToken(token)) continue;
    if (token.text === "{") { depth++; continue; }
    if (token.text === "}") { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0 || token.text !== "export" || declarationKindAfterExport(tokens, i) === undefined) continue;
    out += source.slice(cursor, token.start);
    cursor = token.end;
  }
  return cursor === 0 ? source : out + source.slice(cursor);
}

function declarationKindAfterExport(tokens: readonly Token[], exportIndex: number): string | undefined {
  let i = nextCodeToken(tokens, exportIndex + 1);
  while (tokens[i]?.text === "@") {
    const nameIndex = nextCodeToken(tokens, i + 1);
    if (tokens[nameIndex]?.kind !== "ident" && tokens[nameIndex]?.kind !== "keyword") return undefined;
    i = nextCodeToken(tokens, nameIndex + 1);
    if (tokens[i]?.text === "(") {
      const close = matchPair(tokens, i, "(", ")");
      if (close === undefined) return undefined;
      i = nextCodeToken(tokens, close + 1);
    }
  }
  return exportDeclarationKinds.has(tokens[i]?.text ?? "") ? tokens[i]!.text : undefined;
}

function nextCodeToken(tokens: readonly Token[], start: number): number {
  let i = start;
  while (tokens[i] && isCommentToken(tokens[i]!)) i++;
  return i;
}

function isCommentToken(token: Token): boolean { return token.kind === "lineComment" || token.kind === "blockComment"; }
function attributeNameAt(tokens: readonly Token[], atIndex: number): string | undefined {
  if (tokens[atIndex]?.text !== "@") return undefined;
  return tokens[nextCodeToken(tokens, atIndex + 1)]?.text;
}
function isVisible(kind: string, module: MangleModule, name: string): boolean { return kind === "override" || isEntryPoint(module, name) || isBindingVar(module, name); }
function isBindingVar(module: MangleModule, name: string): boolean {
  for (let i = 0; i < module.tokens.length; i++) {
    if (module.tokens[i]?.text !== "var") continue;
    const nameIndex = varNameIndex(module.tokens, i);
    if (module.tokens[nameIndex]?.text !== name) continue;
    for (let j = i - 1; j >= 0 && module.tokens[j]?.text !== ";" && module.tokens[j]?.text !== "}"; j--) {
      if (["group", "binding"].includes(attributeNameAt(module.tokens, j) ?? "")) return true;
    }
  }
  return false;
}
function varNameIndex(tokens: readonly Token[], varIndex: number): number {
  if (tokens[varIndex + 1]?.text !== "<") return varIndex + 1;
  let depth = 0;
  for (let i = varIndex + 1; i < tokens.length; i++) {
    if (tokens[i]?.text === "<") depth++;
    if (tokens[i]?.text === ">") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return varIndex + 1;
}
export function isEntryPoint(module: MangleModule, name: string): boolean {
  let depth = 0;
  for (let i = 0; i < module.tokens.length; i++) {
    const token = module.tokens[i]!;
    if (token.text === "{") { depth++; continue; }
    if (token.text === "}") { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (token.text !== "fn" || module.tokens[nextCodeToken(module.tokens, i + 1)]?.text !== name) continue;
    for (let j = i - 1; j >= 0 && module.tokens[j]?.text !== ";" && module.tokens[j]?.text !== "}"; j--) {
      if (["vertex", "fragment", "compute"].includes(attributeNameAt(module.tokens, j) ?? "")) return true;
    }
  }
  return false;
}
function isTargetVisible(target: ExportTarget): boolean { return target.kind === "override" || target.kind === "entry"; }
function range(start: number, end: number): number[] { const values: number[] = []; for (let i = start; i < end; i++) values.push(i); return values; }
