import { wgslError } from "./errors.ts";
import type { Token } from "./scanner.ts";

export interface ImportBinding { readonly imported: string; readonly local: string; readonly namespace?: false }
export interface NamespaceBinding { readonly imported: "*"; readonly local: string; readonly namespace: true }
export interface ImportDecl { readonly from: string; readonly bindings: readonly (ImportBinding | NamespaceBinding)[]; readonly start: number; readonly end: number }
export interface ExportDecl { readonly name: string; readonly localName: string; readonly kind: string }
export interface ModuleParse { readonly imports: readonly ImportDecl[]; readonly exports: readonly ExportDecl[]; readonly locals: readonly ExportDecl[] }

const declKinds = new Set(["fn", "struct", "const", "alias", "var", "override"]);

export function parseModule(tokens: readonly Token[]): ModuleParse {
  const imports: ImportDecl[] = [];
  const locals: ExportDecl[] = [];
  const exports: ExportDecl[] = [];
  let i = 0;
  let sawDecl = false;
  let depth = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.text === "{") { depth++; i++; continue; }
    if (token.text === "}") { depth = Math.max(0, depth - 1); i++; continue; }
    if (isComment(token)) { i++; continue; }
    if (depth > 0) { i++; continue; }
    if (token.text === "import") {
      if (sawDecl) throw wgslError("VGPU-WGSL-IMP-ORDER", "Imports must precede declarations", token.line, token.column);
      const [decl, next] = parseImport(tokens, i);
      imports.push(decl); i = next; continue;
    }
    if (token.text === "export" && tokens[i + 1]?.text === "{") throw wgslError("VGPU-WGSL-EXP-REEXPORT-CYCLE", "Re-export cycles are not supported", token.line, token.column);
    if (token.text === "@" && tokens[i + 2]?.text === "export" && tokens[i + 3]?.text === "@") throw wgslError("VGPU-WGSL-EXP-NOTDECL", "Repeated export attributes", token.line, token.column);
    const exported = token.text === "export" || (token.text === "@" && tokens[i + 2]?.text === "export");
    const kindIndex = exported ? skipAttrs(tokens, token.text === "export" ? i + 1 : i + 3) : i;
    const kind = tokens[kindIndex];
    if (kind && declKinds.has(kind.text)) {
      const name = findDeclName(tokens, kindIndex);
      locals.push({ name, localName: name, kind: kind.text });
      if (exported) exports.push({ name, localName: name, kind: kind.text });
      sawDecl = true;
    }
    i++;
  }
  return { imports, exports, locals };
}

function parseImport(tokens: readonly Token[], start: number): [ImportDecl, number] {
  let i = start + 1;
  const bindings: (ImportBinding | NamespaceBinding)[] = [];
  if (tokens[i]?.text === "{") {
    i++;
    while (tokens[i] && tokens[i]!.text !== "}") {
      if (isComment(tokens[i]!)) { i++; continue; }
      const imported = expectIdent(tokens[i]);
      let local = imported; i++;
      if (tokens[i]?.text === "as") { local = expectIdent(tokens[i + 1]); i += 2; }
      bindings.push({ imported, local });
      if (tokens[i]?.text === ",") i++;
    }
    i++; expectText(tokens[i], "from"); i++;
  } else if (tokens[i]?.text === "*") {
    expectText(tokens[i + 1], "as");
    bindings.push({ imported: "*", local: expectIdent(tokens[i + 2]), namespace: true });
    i += 3; expectText(tokens[i], "from"); i++;
  } else if (tokens[i]?.kind === "string") {
    throw wgslError("VGPU-WGSL-IMP-SIDEEFFECT", "Side-effect imports are not supported", tokens[i]!.line, tokens[i]!.column);
  } else {
    throw wgslError("VGPU-WGSL-IMP-DEFAULT", "Default imports are not supported", tokens[i]?.line, tokens[i]?.column);
  }
  const fromToken = tokens[i];
  if (fromToken?.kind !== "string") throw wgslError("VGPU-WGSL-RES-NOTFOUND", "Import path must be a string", fromToken?.line, fromToken?.column);
  const from = fromToken.text.slice(1, -1); i++;
  if (tokens[i]?.text === ";") i++;
  return [{ from, bindings, start: tokens[start]!.start, end: tokens[i - 1]!.end }, i];
}

function skipAttrs(tokens: readonly Token[], i: number): number {
  while (tokens[i]?.text === "@") { i += 2; if (tokens[i]?.text === "(") while (tokens[i] && tokens[i]!.text !== ")") i++; if (tokens[i]?.text === ")") i++; }
  return i;
}
function findDeclName(tokens: readonly Token[], kindIndex: number): string {
  let i = kindIndex + 1;
  if (tokens[kindIndex]?.text === "var" && tokens[i]?.text === "<") while (tokens[i] && tokens[i]!.text !== ">") i++;
  for (; i < tokens.length; i++) if (tokens[i]!.kind === "ident") return tokens[i]!.text;
  throw wgslError("VGPU-WGSL-EXP-NOTDECL", "Exported declaration has no name", tokens[kindIndex]?.line, tokens[kindIndex]?.column);
}
function expectText(token: Token | undefined, text: string): void { if (token?.text !== text) throw wgslError("VGPU-WGSL-IMP-DEFAULT", `Expected ${text}`, token?.line, token?.column); }
function expectIdent(token: Token | undefined): string { if (token?.kind !== "ident") throw wgslError("VGPU-WGSL-IMP-DEFAULT", "Expected identifier", token?.line, token?.column); return token.text; }
function isComment(token: Token): boolean { return token.kind === "lineComment" || token.kind === "blockComment"; }
