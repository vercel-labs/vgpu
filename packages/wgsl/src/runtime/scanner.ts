import { wgslError } from "./errors.ts";

export type TokenKind = "ident" | "keyword" | "string" | "lineComment" | "blockComment" | "punct" | "number";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

const keywords = new Set([
  "import", "export", "from", "as", "fn", "struct", "const", "alias", "var", "override", "let", "enable",
  "requires", "return", "if", "else", "for", "while", "loop", "switch", "case", "default", "break", "continue",
]);

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
      step(); step();
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) step();
      if (i >= source.length) throw wgslError("VGPU-WGSL-LEX-UNTERM-COMMENT", "Unterminated block comment", atLine, atColumn);
      step(); step(); push("blockComment", start, i, atLine, atColumn); continue;
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
      push(keywords.has(text) ? "keyword" : "ident", start, i, atLine, atColumn); continue;
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
  for (const token of scan(source)) {
    if (token.kind === "lineComment" || token.kind === "blockComment") continue;
    if (token.kind === "keyword" && (token.text === "enable" || token.text === "requires")) continue;
    return token.kind === "keyword" && token.text === "import";
  }
  return false;
}

