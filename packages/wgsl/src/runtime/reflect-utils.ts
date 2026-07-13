import type { Attr, AccessMode } from "./reflect-types.ts";
import type { Token } from "./scanner.ts";

export function numericAttr(attrs: readonly Attr[], name: string): number | undefined {
  const attr = attrs.find((item) => item.name === name);
  if (!attr) return undefined;
  const text = attr.args.map((token) => token.text).join("");
  const value = Number(text.replace(/[ui]$/, ""));
  return Number.isFinite(value) ? value : undefined;
}

export function splitGeneric(tokens: readonly Token[]): readonly (readonly Token[])[] {
  const parts: Token[][] = [[]];
  let angle = 0;
  let paren = 0;
  for (const token of tokens) {
    if (token.text === "<") angle++;
    else if (token.text === ">") angle = Math.max(0, angle - 1);
    else if (token.text === "(") paren++;
    else if (token.text === ")") paren = Math.max(0, paren - 1);
    if (token.text === "," && angle === 0 && paren === 0) {
      parts.push([]);
      continue;
    }
    parts[parts.length - 1]!.push(token);
  }
  return parts.map(trim).filter((part) => part.length > 0);
}

export function trim(tokens: readonly Token[]): readonly Token[] {
  let start = 0;
  let end = tokens.length;
  while (start < end && tokens[start]!.text === ",") start++;
  while (end > start && tokens[end - 1]!.text === ",") end--;
  return tokens.slice(start, end);
}

export function literalArrayCount(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!isLiteralArrayCount(text)) return undefined;
  return Number(text.replace(/[ui]$/, ""));
}

export function isLiteralArrayCount(text: string): boolean {
  return /^(0|[1-9][0-9]*)([ui])?$/.test(text);
}

export function normalizeAccess(value: string | undefined): AccessMode | undefined {
  if (value === "read" || value === "write" || value === "read_write") return value;
  return undefined;
}

export function scalarName(text: string): "f32" | "f16" | "i32" | "u32" | "bool" | undefined {
  return (["f32", "f16", "i32", "u32", "bool"] as const).find((name) => name === text);
}

export function suffixScalar(suffix: string): { readonly kind: "scalar"; readonly name: "f32" | "f16" | "i32" | "u32" } {
  return { kind: "scalar", name: suffix === "f" ? "f32" : suffix === "h" ? "f16" : suffix === "i" ? "i32" : "u32" };
}

export function scalarSize(name: "f32" | "f16" | "i32" | "u32" | "bool"): number {
  return name === "f16" ? 2 : 4;
}

export function roundUp(align: number, value: number): number {
  return Math.ceil(value / align) * align;
}
