import type { Diagnostic } from "./diagnostic-types.ts";
import { wgslError, wgslErrorWithFix, type WGSLError } from "./errors.ts";
import { WGSL_KEYWORDS } from "./wgsl-identifiers.ts";

export const NON_ASCII_IDENTIFIER_CODE = "VGPU-WGSL-IDENT-NONASCII";
const XID_ISSUE_URL = "https://github.com/vercel-labs/vgpu/issues/294";

export type TokenKind = "ident" | "keyword" | "string" | "lineComment" | "blockComment" | "punct" | "number";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

/**
 * Tokenizes WGSL. `path` is only used to attribute diagnostics to a file; pass it whenever the
 * caller knows which module the source came from.
 */
export function scan(source: string, path?: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const push = (kind: TokenKind, start: number, end: number, atLine: number, atColumn: number) =>
    tokens.push({ kind, text: source.slice(start, end), start, end, line: atLine, column: atColumn });
  const step = () => {
    if (source[i] === "\n") { line++; column = 1; } else column++;
    i++;
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) { step(); continue; }
    const start = i, atLine = line, atColumn = column;
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") step();
      push("lineComment", start, i, atLine, atColumn); continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      let depth = 0;
      while (i < source.length) {
        if (source[i] === "/" && source[i + 1] === "*") { depth++; step(); step(); continue; }
        if (source[i] === "*" && source[i + 1] === "/") {
          depth--; step(); step();
          if (depth === 0) { push("blockComment", start, i, atLine, atColumn); break; }
          continue;
        }
        step();
      }
      if (depth !== 0) throw wgslError("VGPU-WGSL-LEX-UNTERM-COMMENT", "Unterminated block comment", atLine, atColumn);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      step();
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\n") throw wgslError("VGPU-WGSL-LEX-UNTERM-STRING", "Unterminated string", atLine, atColumn);
        if (source[i] === "\\") step();
        step();
      }
      if (i >= source.length) throw wgslError("VGPU-WGSL-LEX-UNTERM-STRING", "Unterminated string", atLine, atColumn);
      step(); push("string", start, i, atLine, atColumn); continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) step();
      const text = source.slice(start, i);
      push(WGSL_KEYWORDS.has(text) ? "keyword" : "ident", start, i, atLine, atColumn); continue;
    }
    // WGSL's `decimal_float_literal` may start with a dot (`.5`, `.5e2`, `.5f`), so a `.` directly
    // followed by a digit opens a number token rather than a member access: neither member names nor
    // swizzles can start with a digit, so `v.x` / `a.xyz` stay punct + ident. Trailing-dot forms
    // (`1.`, `1.e3`) enter through the leading-digit case and are unchanged.
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      if (ch === ".") step();
      while (i < source.length) {
        const current = source[i]!;
        if (/[A-Za-z0-9_.]/.test(current)) { step(); continue; }
        if ((current === "+" || current === "-") && isExponentMarker(source[i - 1]) && /[0-9]/.test(source[i + 1] ?? "")) {
          step(); continue;
        }
        break;
      }
      push("number", start, i, atLine, atColumn); continue;
    }
    // Anything non-ASCII that survives to here is in code position: comments, strings and
    // blankspace were consumed above, and WGSL has no non-ASCII operators. WGSL identifiers are
    // Unicode (XID_Start/XID_Continue) but every stage below this one — the printer's separator
    // predicates, the scope walker, the mangler, reflection — is ASCII-only, so such an identifier
    // was either fused into the preceding keyword (`let Ω` -> `letΩ`), misdiagnosed as a missing
    // identifier, or silently reflected under a truncated name. Reject it here instead: the
    // scanner is the one choke point every path shares, minify/validate settings included.
    if (ch.charCodeAt(0) > 0x7f) throw nonAsciiIdentifierError(source, i, line, column, path);
    step(); push("punct", start, i, atLine, atColumn);
  }
  return tokens;
}

/**
 * Names the whole offending identifier, not just the character that tripped the scan: `café` is
 * reached at `é` (after `ident:caf`) and `Ω` at its first character, and both read better reported
 * as one name anchored at the identifier's own line/column.
 */
function nonAsciiIdentifierError(source: string, index: number, line: number, column: number, path: string | undefined): WGSLError {
  let start = index;
  while (start > 0 && isIdentByte(source[start - 1]!)) start--;
  let end = index + 1;
  while (end < source.length && isIdentByte(source[end]!)) end++;
  const text = source.slice(start, end);
  // Identifiers cannot span a newline, so only the column moves when walking back to `start`.
  const atColumn = column - (index - start);
  const where = path === undefined ? "" : ` in ${path}`;
  const error = wgslErrorWithFix(
    NON_ASCII_IDENTIFIER_CODE,
    `Non-ASCII identifier '${text}'${where} at line ${line} column ${atColumn}; vgpu's WGSL pipeline supports ASCII identifiers only`,
    { fix: `Rename '${text}' using ASCII letters, digits and '_'. Unicode (XID) identifiers are tracked in ${XID_ISSUE_URL}`, line, column: atColumn },
  ) as Diagnostic;
  error.range = { file: path, start: { line, column: atColumn } };
  return error as WGSLError;
}

/** Identifier bytes for error reporting: ASCII word characters plus anything non-ASCII. */
function isIdentByte(char: string): boolean {
  return char.charCodeAt(0) > 0x7f || /[A-Za-z0-9_]/.test(char);
}

export function hasTopLevelImport(source: string): boolean {
  const tokens = scan(source);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "lineComment" || token.kind === "blockComment") continue;
    if (token.kind === "keyword" && isTopLevelDirectiveKeyword(token.text)) {
      i = skipDirective(tokens, i);
      continue;
    }
    return token.kind === "keyword" && token.text === "import";
  }
  return false;
}

const topLevelDirectiveKeywords = new Set(["enable", "requires", "diagnostic"]);

function isExponentMarker(char: string | undefined): boolean {
  return char === "e" || char === "E" || char === "p" || char === "P";
}

function isTopLevelDirectiveKeyword(text: string): boolean {
  return topLevelDirectiveKeywords.has(text);
}

function skipDirective(tokens: readonly Token[], start: number): number {
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "punct" && token.text === ";") return i;
  }
  return tokens.length;
}

