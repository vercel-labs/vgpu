import type { Diagnostic } from "./diagnostic-types.ts";
import { wgslError } from "./errors.ts";
import { scan, type Token } from "./scanner.ts";
import { WGSL_RESERVED_WORDS, WGSL_SPEC_KEYWORDS } from "./wgsl-identifiers.ts";

export const RESERVED_IDENTIFIER_CODE = "VGPU-WGSL-RESERVED-IDENT";

/** Declaration sites reported by {@link reservedIdentifierDiagnostics}. */
type DeclarationSite =
  | "struct"
  | "struct member"
  | "type alias"
  | "module-scope variable"
  | "override"
  | "function"
  | "function parameter"
  | "local variable";

export interface ReservedIdentifierModule {
  readonly path: string;
  readonly tokens: readonly Token[];
}

/**
 * Reports declared identifiers that WGSL forbids (reserved words and keywords).
 * Dawn/Tint rejects these at shader module creation, so `vgpu check` must catch
 * them without a GPU. Declaration sites are found on the token stream produced by
 * {@link scan}, mirroring the structure walked by `parseDeclarations`.
 */
export function reservedIdentifierDiagnostics(module: ReservedIdentifierModule): Diagnostic[] {
  const tokens = module.tokens.filter((token) => token.kind !== "lineComment" && token.kind !== "blockComment");
  const found: Diagnostic[] = [];
  const report = (index: number, site: DeclarationSite): void => {
    const diagnostic = reservedIdentifierDiagnostic(module.path, tokens[index], site);
    if (diagnostic) found.push(diagnostic);
  };
  let i = 0;
  let depth = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.text === "{") { depth++; i++; continue; }
    if (token.text === "}") { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth > 0) { i++; continue; }
    const start = i;
    i = skipAttributes(tokens, i);
    if (tokens[i]?.text === "export") i++;
    const kind = tokens[i]?.text;
    // `import ... from "..."` is vgpu module syntax; its identifiers are never emitted verbatim.
    if (kind === "import" || kind === "enable" || kind === "requires" || kind === "diagnostic" || kind === "const_assert") {
      i = statementEnd(tokens, i) + 1;
      continue;
    }
    if (kind === "struct") { i = visitStruct(tokens, i, report); continue; }
    if (kind === "fn") { i = visitFunction(tokens, i, report); continue; }
    if (kind === "alias") { report(i + 1, "type alias"); i = statementEnd(tokens, i) + 1; continue; }
    if (kind === "var" || kind === "const" || kind === "override" || kind === "let") {
      report(declaredNameIndex(tokens, i), kind === "override" ? "override" : "module-scope variable");
      i = statementEnd(tokens, i) + 1;
      continue;
    }
    i = Math.max(start + 1, i + 1);
  }
  return found;
}

/**
 * Convenience wrapper for callers that hold raw source instead of scanned tokens
 * (leaf shaders in `compile()` and in the bundler loaders). Lexer failures are
 * swallowed: unterminated comments/strings are reported by the callers that scan
 * for emission, and this pass must never be the thing that breaks a build.
 */
export function reservedIdentifierDiagnosticsForSource(path: string, source: string): Diagnostic[] {
  try {
    return reservedIdentifierDiagnostics({ path, tokens: scan(source) });
  } catch {
    return [];
  }
}

function visitStruct(tokens: readonly Token[], index: number, report: (index: number, site: DeclarationSite) => void): number {
  report(index + 1, "struct");
  const open = findText(tokens, index + 2, "{");
  if (open === -1) return index + 2;
  const close = matchingIndex(tokens, open);
  if (close === -1) return open + 1;
  visitDeclarationList(tokens, open + 1, close, "struct member", report);
  return close + 1;
}

function visitFunction(tokens: readonly Token[], index: number, report: (index: number, site: DeclarationSite) => void): number {
  report(index + 1, "function");
  const open = findText(tokens, index + 2, "(");
  if (open === -1) return index + 2;
  const close = matchingIndex(tokens, open);
  if (close === -1) return open + 1;
  visitDeclarationList(tokens, open + 1, close, "function parameter", report);
  const bodyOpen = findText(tokens, close + 1, "{");
  if (bodyOpen === -1) return close + 1;
  const bodyClose = matchingIndex(tokens, bodyOpen);
  if (bodyClose === -1) return bodyOpen + 1;
  for (let i = bodyOpen + 1; i < bodyClose; i++) {
    const token = tokens[i]!;
    if (token.kind !== "keyword") continue;
    if (token.text !== "let" && token.text !== "var" && token.text !== "const") continue;
    report(declaredNameIndex(tokens, i), "local variable");
  }
  return bodyClose + 1;
}

/** Walks a comma separated `name: type` list (struct members, function parameters). */
function visitDeclarationList(tokens: readonly Token[], start: number, end: number, site: DeclarationSite, report: (index: number, site: DeclarationSite) => void): void {
  let i = start;
  while (i < end) {
    i = skipAttributes(tokens, i);
    if (i >= end) break;
    const text = tokens[i]!.text;
    if (text === "," || text === ";") { i++; continue; }
    report(i, site);
    i = declarationListItemEnd(tokens, i + 1, end) + 1;
  }
}

function declarationListItemEnd(tokens: readonly Token[], start: number, end: number): number {
  let angle = 0;
  for (let i = start; i < end; i++) {
    const text = tokens[i]!.text;
    if (text === "<") angle++;
    if (text === ">") angle = Math.max(0, angle - 1);
    if (angle === 0 && (text === "," || text === ";")) return i;
  }
  return end;
}

/** Index of the declared name after `var`/`let`/`const`/`override`, skipping a `var<...>` template. */
function declaredNameIndex(tokens: readonly Token[], keywordIndex: number): number {
  if (tokens[keywordIndex + 1]?.text !== "<") return keywordIndex + 1;
  const close = matchingIndex(tokens, keywordIndex + 1);
  return close === -1 ? -1 : close + 1;
}

function skipAttributes(tokens: readonly Token[], start: number): number {
  let i = start;
  while (tokens[i]?.text === "@") {
    i += 2;
    if (tokens[i]?.text !== "(") continue;
    const close = matchingIndex(tokens, i);
    if (close === -1) return i;
    i = close + 1;
  }
  return i;
}

function statementEnd(tokens: readonly Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const text = tokens[i]!.text;
    if (text === "{" || text === "(") depth++;
    if (text === "}" || text === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && text === ";") return i;
  }
  return tokens.length;
}

function findText(tokens: readonly Token[], start: number, text: string): number {
  for (let i = start; i < tokens.length; i++) if (tokens[i]!.text === text) return i;
  return -1;
}

function matchingIndex(tokens: readonly Token[], open: number): number {
  const start = tokens[open]?.text;
  const end = start === "(" ? ")" : start === "{" ? "}" : start === "<" ? ">" : undefined;
  if (start === undefined || end === undefined) return -1;
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i]!.text === start) depth++;
    else if (tokens[i]!.text === end && --depth === 0) return i;
  }
  return -1;
}

function reservedIdentifierDiagnostic(path: string, token: Token | undefined, site: DeclarationSite): Diagnostic | undefined {
  if (!token || (token.kind !== "ident" && token.kind !== "keyword")) return undefined;
  const reserved = WGSL_RESERVED_WORDS.has(token.text);
  if (!reserved && !WGSL_SPEC_KEYWORDS.has(token.text)) return undefined;
  const classification = reserved ? "a reserved word" : "a keyword";
  const message = `'${token.text}' is ${classification} in WGSL and cannot be used as an identifier; rename this ${site} (for example '${token.text}_')`;
  const diagnostic = wgslError(RESERVED_IDENTIFIER_CODE, message, token.line, token.column) as Diagnostic;
  diagnostic.range = { file: path, start: { line: token.line, column: token.column } };
  return diagnostic;
}
