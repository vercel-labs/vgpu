import type { Attr, EntryPointInfo, EntryPointParam, ParsedAlias, ParsedDecls, ParsedEntryPoint, ParsedStruct, ParsedStructMember, ParseAliasResult, ParseEntryPointResult, ParseOverrideResult, ParseStructResult, ParseVarResult, VarDecl } from "./reflect-types.ts";
import type { MangleModule } from "./mangler.ts";
import { mangle } from "./mangler.ts";
import type { Token } from "./scanner.ts";
import type { OverrideInfo } from "./reflect-types.ts";
import { parseType } from "./reflect-type-parser.ts";
import { expectIdent, findNext, findToken, matching, readAttrs, skipUntil } from "./reflect-token-utils.ts";
import { numericAttr } from "./reflect-utils.ts";
import { parseWorkgroupSize } from "./reflect-entry-points.ts";
import { parseVarTemplate } from "./reflect-vars.ts";

export function parseDeclarations(module: MangleModule): ParsedDecls {
  const structs: ParsedStruct[] = [];
  const aliases: ParsedAlias[] = [];
  const vars: VarDecl[] = [];
  const entries: ParsedEntryPoint[] = [];
  const overrides: OverrideInfo[] = [];
  const features: string[] = [];
  const tokens = module.tokens.filter((token) => token.kind !== "lineComment" && token.kind !== "blockComment");
  let i = 0;
  let depth = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.text === "{") { depth++; i++; continue; }
    if (token.text === "}") { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth > 0) { i++; continue; }
    const start = i;
    const [attrs, afterAttrs] = readAttrs(tokens, i);
    i = afterAttrs;
    if (tokens[i]?.text === "export") i++;
    const kind = tokens[i]?.text;
    if (kind === "enable") {
      if (tokens[i + 1]?.kind === "ident") features.push(tokens[i + 1]!.text);
      i = skipUntil(tokens, i, ";") + 1;
      continue;
    }
    if (kind === "struct") {
      const result = parseStructDecl(module, tokens, i, attrs);
      if (result.item) structs.push(result.item);
      i = result.next;
      continue;
    }
    if (kind === "alias") {
      const result = parseAliasDecl(module, tokens, i, attrs);
      if (result.item) aliases.push(result.item);
      i = result.next;
      continue;
    }
    if (kind === "var") {
      const result = parseVarDecl(module, tokens, i, attrs);
      if (result.item) vars.push(result.item);
      i = result.next;
      continue;
    }
    if (kind === "fn") {
      const result = parseEntryPointDecl(module, tokens, i, attrs);
      if (result.item) entries.push(result.item);
      i = result.next;
      continue;
    }
    if (kind === "override") {
      const result = parseOverrideDecl(tokens, i);
      if (result.item) overrides.push(result.item);
      i = result.next;
      continue;
    }
    i = Math.max(start + 1, i + 1);
  }
  return { structs, aliases, vars, entries, overrides, features };
}

export function parseStructDecl(module: MangleModule, tokens: readonly Token[], index: number, attrs: readonly Attr[]): ParseStructResult {
  const name = expectIdent(tokens[index + 1]);
  const open = findNext(tokens, index + 2, "{");
  const close = matching(tokens, open);
  return {
    item: { name, originalName: name, mangledName: mangledDeclName(module, name, "struct"), members: parseMembers(tokens.slice(open + 1, close)), path: module.path },
    next: close + 1,
  };
}

export function parseAliasDecl(module: MangleModule, tokens: readonly Token[], index: number, attrs: readonly Attr[]): ParseAliasResult {
  const name = expectIdent(tokens[index + 1]);
  const eq = findNext(tokens, index + 2, "=");
  const end = skipUntil(tokens, eq + 1, ";");
  return {
    item: { name, originalName: name, mangledName: mangledDeclName(module, name, "alias"), target: parseType(tokens.slice(eq + 1, end)), path: module.path },
    next: end + 1,
  };
}

export function parseVarDecl(module: MangleModule, tokens: readonly Token[], index: number, attrs: readonly Attr[]): ParseVarResult {
  const { addressSpace, access, after } = parseVarTemplate(tokens, index + 1);
  const name = expectIdent(tokens[after]);
  const colon = findNext(tokens, after + 1, ":");
  const end = skipUntil(tokens, colon + 1, ";");
  return {
    item: { path: module.path, name, mangledName: isBindingVar(attrs) ? name : mangledDeclName(module, name, "var"), attrs, addressSpace, access, type: parseType(tokens.slice(colon + 1, end)) },
    next: end + 1,
  };
}

export function parseEntryPointDecl(module: MangleModule, tokens: readonly Token[], index: number, attrs: readonly Attr[]): ParseEntryPointResult {
  const name = expectIdent(tokens[index + 1]);
  const stage = attrs.find((attr) => attr.name === "vertex" || attr.name === "fragment" || attr.name === "compute")?.name as EntryPointInfo["stage"] | undefined;
  if (!stage) return { item: undefined, next: index + 1 };
  const open = findNext(tokens, index + 2, "(");
  const close = matching(tokens, open);
  return { item: { name, mangledName: name, stage, workgroupSize: parseWorkgroupSize(attrs), path: module.path, params: parseEntryPointParams(tokens.slice(open + 1, close)) }, next: close + 1 };
}

export function parseEntryPointParams(tokens: readonly Token[]): EntryPointParam[] {
  const params: EntryPointParam[] = [];
  let i = 0;
  while (i < tokens.length) {
    const [attrs, afterAttrs] = readAttrs(tokens, i);
    i = afterAttrs;
    if (!tokens[i] || tokens[i]!.text === ",") { i++; continue; }
    const name = expectIdent(tokens[i]);
    const colon = findNext(tokens, i + 1, ":");
    let end = colon + 1;
    let angle = 0;
    while (end < tokens.length) {
      if (tokens[end]!.text === "<") angle++;
      if (tokens[end]!.text === ">") angle = Math.max(0, angle - 1);
      if (angle === 0 && tokens[end]!.text === ",") break;
      end++;
    }
    params.push({ name, attrs, type: parseType(tokens.slice(colon + 1, end)) });
    i = end + 1;
  }
  return params;
}

export function parseOverrideDecl(tokens: readonly Token[], index: number): ParseOverrideResult {
  const name = expectIdent(tokens[index + 1]);
  const end = skipUntil(tokens, index + 1, ";");
  const eq = findToken(tokens, index + 2, end, "=");
  return { item: { name, mangledName: name, defaultValue: eq === undefined ? undefined : tokens.slice(eq + 1, end).map((t) => t.text).join("") }, next: end + 1 };
}

export function parseMembers(tokens: readonly Token[]): ParsedStructMember[] {
  const members: ParsedStructMember[] = [];
  let i = 0;
  while (i < tokens.length) {
    const [attrs, afterAttrs] = readAttrs(tokens, i);
    i = afterAttrs;
    if (!tokens[i] || tokens[i]!.text === "," || tokens[i]!.text === ";") { i++; continue; }
    const name = expectIdent(tokens[i]);
    const colon = findNext(tokens, i + 1, ":");
    let end = colon + 1;
    let angle = 0;
    while (end < tokens.length) {
      if (tokens[end]!.text === "<") angle++;
      if (tokens[end]!.text === ">") angle = Math.max(0, angle - 1);
      if (angle === 0 && (tokens[end]!.text === "," || tokens[end]!.text === ";")) break;
      end++;
    }
    members.push({ name, attrs, type: parseType(tokens.slice(colon + 1, end)), align: numericAttr(attrs, "align"), size: numericAttr(attrs, "size") });
    i = end + 1;
  }
  return members;
}

function mangledDeclName(module: MangleModule, name: string, kind: string): string {
  return kind === "override" ? name : mangle(module.path, name);
}

function isBindingVar(attrs: readonly Attr[]): boolean {
  return numericAttr(attrs, "group") !== undefined || numericAttr(attrs, "binding") !== undefined;
}
