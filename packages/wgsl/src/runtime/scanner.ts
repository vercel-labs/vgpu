import { wgslError } from "./errors.ts";
import { WGSL_KEYWORDS } from "./wgslIdentifiers.ts";

export type TokenKind = "ident" | "keyword" | "string" | "lineComment" | "blockComment" | "punct" | "number";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export function scan(source: string): Token[] {
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
    if (/[0-9]/.test(ch)) {
      while (i < source.length && /[A-Za-z0-9_.]/.test(source[i]!)) step();
      push("number", start, i, atLine, atColumn); continue;
    }
    step(); push("punct", start, i, atLine, atColumn);
  }
  return tokens;
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

