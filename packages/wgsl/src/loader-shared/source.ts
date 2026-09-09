import { scan, type Token } from "../runtime/scanner.ts";

export function hasDirectFunctionExport(source: string, path: string): boolean {
  const tokens = scan(source, path);
  let braceDepth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isComment(token)) continue;
    if (token.text === "{") { braceDepth++; continue; }
    if (token.text === "}") { braceDepth = Math.max(0, braceDepth - 1); continue; }
    if (braceDepth !== 0) continue;
    if (token.text === "@") { i = skipAttribute(tokens, i); continue; }
    if (token.text === "export" && tokenAfterExport(tokens, i)?.text === "fn") return true;
  }
  return false;
}

function tokenAfterExport(tokens: readonly Token[], exportIndex: number): Token | undefined {
  let index = nextCodeToken(tokens, exportIndex + 1);
  while (tokens[index]?.text === "@") index = nextCodeToken(tokens, skipAttribute(tokens, index) + 1);
  return tokens[index];
}

function skipAttribute(tokens: readonly Token[], atIndex: number): number {
  const nameIndex = nextCodeToken(tokens, atIndex + 1);
  const openIndex = nextCodeToken(tokens, nameIndex + 1);
  if (tokens[openIndex]?.text !== "(") return nameIndex;
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    if (tokens[i]?.text === "(") depth++;
    if (tokens[i]?.text === ")" && --depth === 0) return i;
  }
  return tokens.length - 1;
}

function nextCodeToken(tokens: readonly Token[], start: number): number {
  let index = start;
  while (tokens[index] && isComment(tokens[index]!)) index++;
  return index;
}

function isComment(token: Token): boolean {
  return token.kind === "lineComment" || token.kind === "blockComment";
}
