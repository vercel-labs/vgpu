import type { Token } from "./scanner.ts";

export type TokenReplacementMap = ReadonlyMap<Token | number | string, string>;
export type TokenReplacementCallback = (token: Token, index: number) => string | undefined;

export interface TokenPrinterOptions {
  readonly replacements?: TokenReplacementMap;
  readonly replaceToken?: TokenReplacementCallback;
}

type Gap = "none" | "whitespace" | "comment";

const commentKinds = new Set(["lineComment", "blockComment"] as const);
const commentJoinOperators = new Set([
  "==", "!=", "<=", ">=", "->", "&&", "||", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
  "<<", ">>", "<<=", ">>=",
]);
const whitespaceAmbiguousOperators = new Set(["&&", "||", "++", "--", "<<", ">>", "<<=", ">>="]);

export function printWgslTokens(tokens: readonly Token[], options: TokenPrinterOptions = {}): string {
  let out = "";
  let previous: PrintedToken | undefined;
  let sawComment = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isComment(token)) { sawComment = true; continue; }

    const text = replacementText(token, i, options);
    if (text === "") continue;

    if (previous) {
      const gap: Gap = sawComment ? "comment" : previous.token.end < token.start ? "whitespace" : "none";
      if (needsSeparator(previous, { token, text }, gap)) out += " ";
    }
    out += text;
    previous = { token, text };
    sawComment = false;
  }

  return out;
}

interface PrintedToken { readonly token: Token; readonly text: string }

function replacementText(token: Token, index: number, options: TokenPrinterOptions): string {
  const callback = options.replaceToken?.(token, index);
  if (callback !== undefined) return callback;
  const replacements = options.replacements;
  if (!replacements) return token.text;
  return replacements.get(token) ?? replacements.get(index) ?? replacements.get(token.text) ?? token.text;
}

function needsSeparator(previous: PrintedToken, current: PrintedToken, gap: Gap): boolean {
  const left = previous.text;
  const right = current.text;
  const leftLast = left[left.length - 1] ?? "";
  const rightFirst = right[0] ?? "";

  if (isIdentContinue(leftLast) && isIdentContinue(rightFirst)) return true;
  if (previous.token.kind === "number" && (leftLast === "e" || leftLast === "E" || leftLast === "p" || leftLast === "P") && (rightFirst === "+" || rightFirst === "-")) return true;
  if ((isIdentContinue(leftLast) || leftLast === ")" || leftLast === "]" || leftLast === ">") && rightFirst === "@") return true;
  if ((leftLast === ")" || leftLast === "]" || leftLast === ">" || leftLast === "\"" || leftLast === "'") && isIdentStart(rightFirst)) return true;
  if (isDigit(leftLast) && rightFirst === ".") return true;
  if (leftLast === "." && isDigit(rightFirst)) return true;

  if (isPunctuationToken(previous.token, left) && isPunctuationToken(current.token, right)) {
    return needsPunctuationSeparator(left, right, gap);
  }

  return false;
}

function needsPunctuationSeparator(left: string, right: string, gap: Gap): boolean {
  const joined = left + right;
  if (gap === "comment" && commentJoinOperators.has(joined)) return false;
  if (gap !== "none" && (left === ">" && right === ">")) return true;
  if (gap !== "none" && whitespaceAmbiguousOperators.has(joined)) return true;
  if (gap !== "none" && left === "-" && right === ">") return true;
  return false;
}

function isComment(token: Token): boolean { return commentKinds.has(token.kind as "lineComment" | "blockComment"); }
function isPunctuationToken(token: Token, text: string): boolean { return token.kind === "punct" || /^[^A-Za-z0-9_\s]+$/.test(text); }
function isIdentStart(char: string): boolean { return /[A-Za-z_]/.test(char); }
function isIdentContinue(char: string): boolean { return /[A-Za-z0-9_]/.test(char); }
function isDigit(char: string): boolean { return /[0-9]/.test(char); }
