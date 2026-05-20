import { wgslError } from "./errors.ts";

const operatorChars = new Set("+-*/%=&|^!<>:.");

export function minifyWgsl(source: string): string {
  let out = "";
  let pendingSpace = false;
  let last = "";

  for (let i = 0; i < source.length;) {
    const char = source[i]!;
    const next = source[i + 1];

    if (isWhitespace(char)) {
      pendingSpace = true;
      i++;
      continue;
    }

    if (char === "/" && next === "/") {
      pendingSpace = true;
      i += 2;
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++;
      continue;
    }

    if (char === "/" && next === "*") {
      pendingSpace = true;
      i = skipBlockComment(source, i);
      continue;
    }

    if (pendingSpace && needsSpace(last, char)) {
      out += " ";
      last = " ";
    }
    out += char;
    last = char;
    pendingSpace = false;
    i++;
  }

  return out.trim();
}

function skipBlockComment(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length;) {
    if (source[i] === "/" && source[i + 1] === "*") {
      depth++;
      i += 2;
      continue;
    }
    if (source[i] === "*" && source[i + 1] === "/") {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  throw wgslError("VGPU-WGSL-MINIFY-BLOCK", "Unterminated WGSL block comment");
}

function needsSpace(previous: string, current: string): boolean {
  if (!previous) return false;
  if (previous === " ") return false;
  if (isWord(previous) && isWord(current)) return true;
  if ((previous === "e" || previous === "E" || previous === "p" || previous === "P") && (current === "+" || current === "-")) return true;
  if ((isWord(previous) || previous === ")" || previous === "]" || previous === ">") && current === "@") return true;
  if ((previous === ")" || previous === "]" || previous === ">") && isWord(current)) return true;
  if (isDigit(previous) && current === ".") return true;
  if (previous === "." && isDigit(current)) return true;
  if (operatorChars.has(previous) && operatorChars.has(current)) return true;
  return false;
}

function isWhitespace(char: string): boolean { return /\s/.test(char); }
function isWord(char: string): boolean { return /[A-Za-z0-9_]/.test(char); }
function isDigit(char: string): boolean { return /[0-9]/.test(char); }
