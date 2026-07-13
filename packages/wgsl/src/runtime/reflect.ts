import { mangle, type MangleModule } from "./mangler.ts";
import type { ImportDecl } from "./parser.ts";
import type { Token } from "./scanner.ts";
import { wgslError } from "./errors.ts";
import { arrayLengthError, boolHostShareableError, namespaceTypeError, unknownTypeError, unsupportedTypeError } from "./diagnostics.ts";

export type ReflectionFacade = Reflection;
export type LayoutMode = "naga-standard";
export const DEFAULT_LAYOUT_MODE: LayoutMode = "naga-standard";

export interface Reflection {
  readonly bindings: readonly BindingInfo[];
  readonly entryPoints: readonly EntryPointInfo[];
  readonly overrides: readonly OverrideInfo[];
  readonly featuresRequired: readonly string[];
  readonly aliases: readonly AliasInfo[];
  readonly structs: readonly StructInfo[];
  readonly hostShareableLayouts: readonly HostShareableLayout[];
}

export type BindingKind = "buffer" | "texture" | "sampler" | "externalTexture" | "unknown";
export type AddressSpace = "function" | "private" | "workgroup" | "uniform" | "storage" | "handle";
export type AccessMode = "read" | "write" | "read_write";

export interface BindingInfo {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
  readonly mangledName: string;
  readonly type: WGSLType;
  readonly kind: BindingKind;
  readonly addressSpace?: AddressSpace;
  readonly access?: AccessMode;
  readonly struct?: StructInfo;
  readonly layout?: HostShareableLayout;
  readonly bindingLayout?: ReflectedBindingLayout;
}
export interface EntryPointInfo {
  readonly name: string;
  readonly mangledName: string;
  readonly stage: "vertex" | "fragment" | "compute";
  readonly workgroupSize?: readonly [number, number, number];
}
export interface OverrideInfo { readonly name: string; readonly mangledName: string; readonly defaultValue?: string }

export interface AliasInfo { readonly name: string; readonly mangledName: string; readonly target: WGSLType }
export interface StructInfo { readonly name: string; readonly mangledName: string; readonly members: readonly StructMemberInfo[] }
export interface StructMemberInfo {
  readonly name: string;
  readonly type: WGSLType;
  readonly align?: number;
  readonly size?: number;
}

export type ScalarKind = "f32" | "f16" | "i32" | "u32" | "bool";
export type TextureDimension = "1d" | "2d" | "2d_array" | "3d" | "cube" | "cube_array" | "multisampled_2d" | "depth_2d" | "depth_2d_array" | "depth_cube" | "depth_cube_array" | "depth_multisampled_2d";
export type TextureSampleType = "float" | "unfilterable-float" | "depth" | "sint" | "uint";
export type TextureViewDimension = "1d" | "2d" | "2d-array" | "cube" | "cube-array" | "3d";
export type StorageTextureAccess = "write-only" | "read-only" | "read-write";
export type ReflectedBindingLayout =
  | { readonly kind: "buffer"; readonly buffer: { readonly type: "uniform" | "storage" | "read-only-storage"; readonly hasDynamicOffset: false; readonly minBindingSize?: number } }
  | { readonly kind: "sampler"; readonly sampler: { readonly type: "filtering" | "non-filtering" | "comparison" } }
  | { readonly kind: "texture"; readonly texture: { readonly sampleType: TextureSampleType; readonly viewDimension: TextureViewDimension; readonly multisampled: boolean } }
  | { readonly kind: "storageTexture"; readonly storageTexture: { readonly access: StorageTextureAccess; readonly format: string; readonly viewDimension: TextureViewDimension } }
  | { readonly kind: "externalTexture"; readonly externalTexture: Record<string, never> };
export type WGSLType =
  | { readonly kind: "scalar"; readonly name: ScalarKind }
  | { readonly kind: "atomic"; readonly element: WGSLType }
  | { readonly kind: "vector"; readonly width: 2 | 3 | 4; readonly element: WGSLType }
  | { readonly kind: "matrix"; readonly columns: 2 | 3 | 4; readonly rows: 2 | 3 | 4; readonly element: WGSLType }
  | { readonly kind: "array"; readonly element: WGSLType; readonly count?: number; readonly countExpression?: string }
  | { readonly kind: "ptr"; readonly addressSpace: string; readonly element: WGSLType; readonly access?: string }
  | { readonly kind: "sampler"; readonly comparison: boolean }
  | { readonly kind: "texture"; readonly textureKind: string; readonly dimension?: TextureDimension; readonly sampleType?: WGSLType; readonly texelFormat?: string; readonly access?: AccessMode }
  | { readonly kind: "identifier"; readonly name: string; readonly mangledName?: string };

export interface HostShareableLayout {
  readonly name: string;
  readonly mangledName: string;
  readonly addressSpace: "uniform" | "storage";
  readonly layoutMode: LayoutMode;
  readonly type: WGSLType;
  readonly align: number;
  readonly size?: number;
  readonly stride?: number;
  readonly members?: readonly LayoutMember[];
  readonly element?: HostShareableLayout;
  readonly runtimeSized?: boolean;
}
export interface LayoutMember {
  readonly name: string;
  readonly offset: number;
  readonly align: number;
  readonly size?: number;
  readonly type: WGSLType;
  readonly layout: HostShareableLayout;
  readonly explicitAlign?: number;
  readonly explicitSize?: number;
}

type Attr = { readonly name: string; readonly args: readonly Token[] };
type ParsedDecls = {
  readonly structs: readonly (StructInfo & { readonly path: string; readonly originalName: string })[];
  readonly aliases: readonly (AliasInfo & { readonly path: string; readonly originalName: string })[];
  readonly vars: readonly VarDecl[];
  readonly entries: readonly EntryPointInfo[];
  readonly overrides: readonly OverrideInfo[];
  readonly features: readonly string[];
};
type VarDecl = {
  readonly path: string;
  readonly name: string;
  readonly mangledName: string;
  readonly attrs: readonly Attr[];
  readonly addressSpace?: AddressSpace;
  readonly access?: AccessMode;
  readonly type: WGSLType;
};
type SymbolTarget = { readonly path: string; readonly name: string; readonly mangledName: string; readonly kind: "struct" | "alias" | "namespace" };
type ModuleSymbols = ReadonlyMap<string, SymbolTarget>;
type Registry = { readonly structs: ReadonlyMap<string, StructInfo>; readonly aliases: ReadonlyMap<string, AliasInfo>; readonly byMangled: ReadonlyMap<string, StructInfo | AliasInfo> };

export function reflect(modules: readonly MangleModule[]): Reflection {
  const raw = modules.map(parseDeclarations);
  const moduleSymbols = buildModuleSymbols(modules, raw);
  const registry = buildRegistry(raw, moduleSymbols);
  const bindings: BindingInfo[] = [];
  const hostShareableLayouts: HostShareableLayout[] = [];

  for (const decls of raw) {
    for (const variable of decls.vars) {
      const group = numericAttr(variable.attrs, "group");
      const binding = numericAttr(variable.attrs, "binding");
      if (group === undefined || binding === undefined) continue;
      const type = resolveType(variable.type, variable.path, moduleSymbols, registry);
      const kind = bindingKind(type, variable.addressSpace);
      const layout = variable.addressSpace === "uniform" || variable.addressSpace === "storage"
        ? layoutOf(type, variable.addressSpace, variable.name, variable.mangledName, registry)
        : undefined;
      if (layout) hostShareableLayouts.push(layout);
      bindings.push({
        group,
        binding,
        name: variable.name,
        mangledName: variable.mangledName,
        type,
        kind,
        addressSpace: variable.addressSpace,
        access: variable.access,
        struct: type.kind === "identifier" ? registry.structs.get(type.mangledName ?? type.name) : undefined,
        layout,
        bindingLayout: reflectedBindingLayout(kind, variable.addressSpace, variable.access, type, layout),
      });
    }
  }

  return {
    bindings: bindings.sort((a, b) => a.group - b.group || a.binding - b.binding),
    entryPoints: raw.flatMap((item) => item.entries),
    overrides: raw.flatMap((item) => item.overrides),
    featuresRequired: [...new Set(raw.flatMap((item) => item.features))],
    aliases: [...registry.aliases.values()],
    structs: [...registry.structs.values()],
    hostShareableLayouts,
  };
}

export function layoutOf(type: WGSLType, addressSpace: "uniform" | "storage", name = typeName(type), mangledName = name, registry?: Registry): HostShareableLayout {
  const resolved = registry ? resolveAliasesDeep(type, registry) : type;
  switch (resolved.kind) {
    case "scalar": {
      const size = scalarSize(resolved.name);
      if (resolved.name === "bool") throw boolHostShareableError();
      return { name, mangledName, addressSpace, layoutMode: DEFAULT_LAYOUT_MODE, type: resolved, align: size, size };
    }
    case "atomic": {
      return { name, mangledName, addressSpace, layoutMode: DEFAULT_LAYOUT_MODE, type: resolved, align: 4, size: 4 };
    }
    case "vector": {
      const element = layoutOf(resolved.element, addressSpace, name, mangledName, registry);
      const scalar = element.size ?? 4;
      const align = resolved.width === 2 ? scalar * 2 : scalar * 4;
      return { name, mangledName, addressSpace, layoutMode: DEFAULT_LAYOUT_MODE, type: resolved, align, size: scalar * resolved.width };
    }
    case "matrix": {
      const column: WGSLType = { kind: "vector", width: resolved.rows, element: resolved.element };
      const columnLayout = layoutOf(column, addressSpace, `${name}[]`, `${mangledName}[]`, registry);
      const stride = roundUp(columnLayout.align, columnLayout.size ?? 0);
      return { name, mangledName, addressSpace, layoutMode: DEFAULT_LAYOUT_MODE, type: resolved, align: columnLayout.align, size: stride * resolved.columns, stride, element: columnLayout };
    }
    case "array": {
      if (resolved.countExpression !== undefined && !isLiteralArrayCount(resolved.countExpression)) throw arrayLengthError();
      const element = layoutOf(resolved.element, addressSpace, `${name}[]`, `${mangledName}[]`, registry);
      const stride = roundUp(requiredAlign(resolved.element, addressSpace, registry), element.size ?? 0);
      return { name, mangledName, addressSpace, layoutMode: DEFAULT_LAYOUT_MODE, type: resolved, align: requiredAlign(resolved, addressSpace, registry), size: resolved.count === undefined ? undefined : stride * resolved.count, stride, element, runtimeSized: resolved.count === undefined };
    }
    case "identifier": {
      if (!registry) throw unknownTypeError(resolved.name, "<unknown>");
      const struct = registry.structs.get(resolved.mangledName ?? resolved.name);
      if (!struct) throw unknownTypeError(resolved.name, "<unknown>");
      const members: LayoutMember[] = [];
      let offset = 0;
      let maxAlign = 1;
      for (const member of struct.members) {
        const memberLayout = layoutOf(member.type, addressSpace, member.name, member.name, registry);
        const align = Math.max(requiredAlign(member.type, addressSpace, registry), member.align ?? 1);
        const size = Math.max(memberLayout.size ?? 0, member.size ?? 0);
        offset = roundUp(align, offset);
        members.push({ name: member.name, offset, align, size, type: member.type, layout: memberLayout, explicitAlign: member.align, explicitSize: member.size });
        const unwrappedMember = unwrapAlias(member.type, registry);
        const isStruct = unwrappedMember.kind === "identifier" && registry.structs.has(unwrappedMember.mangledName ?? unwrappedMember.name);
        offset += addressSpace === "uniform" && isStruct ? roundUp(16, size) : size;
        maxAlign = Math.max(maxAlign, align);
      }
      const align = addressSpace === "uniform" ? roundUp(16, maxAlign) : maxAlign;
      return { name, mangledName, addressSpace, layoutMode: DEFAULT_LAYOUT_MODE, type: resolved, align, size: roundUp(align, offset), members };
    }
    default:
      throw unsupportedTypeError(typeName(resolved));
  }
}

function requiredAlign(type: WGSLType, addressSpace: "uniform" | "storage", registry?: Registry): number {
  const resolved = registry ? unwrapAlias(type, registry) : type;
  const natural = naturalAlign(resolved, addressSpace, registry);
  return addressSpace === "uniform" && (resolved.kind === "array" || (resolved.kind === "identifier" && !!registry?.structs.get(resolved.mangledName ?? resolved.name))) ? roundUp(16, natural) : natural;
}

function naturalAlign(type: WGSLType, addressSpace: "uniform" | "storage", registry?: Registry): number {
  const resolved = registry ? unwrapAlias(type, registry) : type;
  switch (resolved.kind) {
    case "scalar": if (resolved.name === "bool") throw boolHostShareableError(); return scalarSize(resolved.name);
    case "atomic": return 4;
    case "vector": return resolved.width === 2 ? naturalAlign(resolved.element, addressSpace, registry) * 2 : naturalAlign(resolved.element, addressSpace, registry) * 4;
    case "matrix": return naturalAlign({ kind: "vector", width: resolved.rows, element: resolved.element }, addressSpace, registry);
    case "array": return requiredAlign(resolved.element, addressSpace, registry);
    case "identifier": {
      const struct = registry?.structs.get(resolved.mangledName ?? resolved.name);
      if (!struct) throw unknownTypeError(resolved.name, "<unknown>");
      return Math.max(1, ...struct.members.map((member) => Math.max(requiredAlign(member.type, addressSpace, registry), member.align ?? 1)));
    }
    default: throw unsupportedTypeError(typeName(resolved));
  }
}

function parseDeclarations(module: MangleModule): ParsedDecls {
  const structs: (StructInfo & { path: string; originalName: string })[] = [];
  const aliases: (AliasInfo & { path: string; originalName: string })[] = [];
  const vars: VarDecl[] = [];
  const entries: EntryPointInfo[] = [];
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
      const name = expectIdent(tokens[i + 1]);
      const open = findNext(tokens, i + 2, "{");
      const close = matching(tokens, open);
      structs.push({ name, originalName: name, mangledName: mangledDeclName(module, name, "struct"), members: parseMembers(tokens.slice(open + 1, close)), path: module.path });
      i = close + 1;
      continue;
    }
    if (kind === "alias") {
      const name = expectIdent(tokens[i + 1]);
      const eq = findNext(tokens, i + 2, "=");
      const end = skipUntil(tokens, eq + 1, ";");
      aliases.push({ name, originalName: name, mangledName: mangledDeclName(module, name, "alias"), target: parseType(tokens.slice(eq + 1, end)), path: module.path });
      i = end + 1;
      continue;
    }
    if (kind === "var") {
      const { addressSpace, access, after } = parseVarTemplate(tokens, i + 1);
      const name = expectIdent(tokens[after]);
      const colon = findNext(tokens, after + 1, ":");
      const end = skipUntil(tokens, colon + 1, ";");
      vars.push({ path: module.path, name, mangledName: mangledDeclName(module, name, "var"), attrs, addressSpace, access, type: parseType(tokens.slice(colon + 1, end)) });
      i = end + 1;
      continue;
    }
    if (kind === "fn") {
      const name = expectIdent(tokens[i + 1]);
      const stage = attrs.find((attr) => attr.name === "vertex" || attr.name === "fragment" || attr.name === "compute")?.name as EntryPointInfo["stage"] | undefined;
      if (stage) entries.push({ name, mangledName: name, stage, workgroupSize: parseWorkgroupSize(attrs) });
      i++;
      continue;
    }
    if (kind === "override") {
      const name = expectIdent(tokens[i + 1]);
      const end = skipUntil(tokens, i + 1, ";");
      const eq = findToken(tokens, i + 2, end, "=");
      overrides.push({ name, mangledName: name, defaultValue: eq === undefined ? undefined : tokens.slice(eq + 1, end).map((t) => t.text).join("") });
      i = end + 1;
      continue;
    }
    i = Math.max(start + 1, i + 1);
  }
  return { structs, aliases, vars, entries, overrides, features };
}

function parseMembers(tokens: readonly Token[]): StructMemberInfo[] {
  const members: StructMemberInfo[] = [];
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
    members.push({ name, type: parseType(tokens.slice(colon + 1, end)), align: numericAttr(attrs, "align"), size: numericAttr(attrs, "size") });
    i = end + 1;
  }
  return members;
}

function parseType(tokens: readonly Token[]): WGSLType {
  const trimmed = trim(tokens);
  if (trimmed.length === 0) throw wgslError("VGPU-WGSL-REFLECT-TYPE", "Expected WGSL type");
  const text = trimmed.map((token) => token.text).join("");
  const scalar = scalarName(text);
  if (scalar) return { kind: "scalar", name: scalar };
  const vec = text.match(/^vec([234])([fiuh])$/);
  if (vec) return { kind: "vector", width: Number(vec[1]) as 2 | 3 | 4, element: suffixScalar(vec[2]!) };
  const mat = text.match(/^mat([234])x([234])([fh])$/);
  if (mat) return { kind: "matrix", columns: Number(mat[1]) as 2 | 3 | 4, rows: Number(mat[2]) as 2 | 3 | 4, element: mat[3] === "h" ? { kind: "scalar", name: "f16" } : { kind: "scalar", name: "f32" } };
  if (trimmed[1]?.text === "<") {
    const head = trimmed[0]!.text;
    const inner = splitGeneric(trimmed.slice(2, -1));
    if (head === "array") {
      const countExpression = inner[1]?.map((t) => t.text).join("");
      const count = countExpression === undefined ? undefined : literalArrayCount(countExpression);
      return { kind: "array", element: parseType(inner[0] ?? []), count, countExpression };
    }
    if (head === "atomic") return { kind: "atomic", element: parseType(inner[0] ?? []) };
    if (head === "vec2" || head === "vec3" || head === "vec4") return { kind: "vector", width: Number(head.slice(3)) as 2 | 3 | 4, element: parseType(inner[0] ?? []) };
    if (/^mat[234]x[234]$/.test(head)) return { kind: "matrix", columns: Number(head[3]) as 2 | 3 | 4, rows: Number(head[5]) as 2 | 3 | 4, element: parseType(inner[0] ?? []) };
    if (head === "ptr") return { kind: "ptr", addressSpace: inner[0]?.map((t) => t.text).join("") ?? "", element: parseType(inner[1] ?? []), access: inner[2]?.map((t) => t.text).join("") };
    if (head === "sampler") return { kind: "sampler", comparison: false };
    if (head.startsWith("texture_storage_")) return { kind: "texture", textureKind: head, dimension: head.slice("texture_storage_".length) as TextureDimension, texelFormat: inner[0]?.map((t) => t.text).join(""), access: normalizeAccess(inner[1]?.map((t) => t.text).join("")) };
    if (head.startsWith("texture_")) return { kind: "texture", textureKind: head, dimension: head.slice("texture_".length) as TextureDimension, sampleType: inner[0] ? parseType(inner[0]) : undefined };
  }
  if (text === "sampler" || text === "sampler_comparison") return { kind: "sampler", comparison: text === "sampler_comparison" };
  if (text === "texture_external") return { kind: "texture", textureKind: text };
  if (text.startsWith("texture_depth_")) return { kind: "texture", textureKind: text, dimension: text.slice("texture_".length) as TextureDimension };
  if (text.startsWith("texture_")) return { kind: "texture", textureKind: text, dimension: text.slice("texture_".length) as TextureDimension };
  return { kind: "identifier", name: text };
}

function buildModuleSymbols(modules: readonly MangleModule[], parsed: readonly ParsedDecls[]): ReadonlyMap<string, ModuleSymbols> {
  const own = new Map<string, Map<string, SymbolTarget>>();
  for (const decls of parsed) {
    const map = new Map<string, SymbolTarget>();
    for (const item of [...decls.structs, ...decls.aliases]) map.set(item.originalName, { path: item.path, name: item.originalName, mangledName: item.mangledName, kind: "members" in item ? "struct" : "alias" });
    own.set(decls.structs[0]?.path ?? decls.aliases[0]?.path ?? decls.vars[0]?.path ?? "", map);
  }
  const byPath = new Map(modules.map((module) => [module.path, own.get(module.path) ?? new Map<string, SymbolTarget>()]));
  const result = new Map<string, ModuleSymbols>();
  for (const module of modules) {
    const map = new Map(byPath.get(module.path));
    for (const imp of module.parsed.imports) addImportedSymbols(module, imp, map, modules, byPath);
    result.set(module.path, map);
  }
  return result;
}

function addImportedSymbols(module: MangleModule, imp: ImportDecl, map: Map<string, SymbolTarget>, modules: readonly MangleModule[], byPath: ReadonlyMap<string, ReadonlyMap<string, SymbolTarget>>): void {
  const targetPath = resolveImportPath(imp.from, module.path, modules);
  const exports = byPath.get(targetPath);
  for (const binding of imp.bindings) {
    if (binding.namespace) { map.set(binding.local, { path: targetPath, name: binding.local, mangledName: binding.local, kind: "namespace" }); continue; }
    const target = exports?.get(binding.imported);
    if (target) map.set(binding.local, target);
  }
}

function buildRegistry(parsed: readonly ParsedDecls[], symbols: ReadonlyMap<string, ModuleSymbols>): Registry {
  const structs = new Map<string, StructInfo>();
  const aliases = new Map<string, AliasInfo>();
  const byMangled = new Map<string, StructInfo | AliasInfo>();
  const empty: Registry = { structs, aliases, byMangled };
  for (const decls of parsed) {
    for (const item of decls.structs) {
      const value: StructInfo = { name: item.name, mangledName: item.mangledName, members: item.members.map((member) => ({ ...member, type: resolveType(member.type, item.path, symbols, empty) })) };
      structs.set(item.mangledName, value); byMangled.set(item.mangledName, value);
    }
    for (const item of decls.aliases) {
      const value: AliasInfo = { name: item.name, mangledName: item.mangledName, target: resolveType(item.target, item.path, symbols, empty) };
      aliases.set(item.mangledName, value); byMangled.set(item.mangledName, value);
    }
  }
  return { structs, aliases, byMangled };
}

function resolveType(type: WGSLType, path: string, symbols: ReadonlyMap<string, ModuleSymbols>, registry: Registry): WGSLType {
  switch (type.kind) {
    case "identifier": {
      const dot = type.name.indexOf(".");
      if (dot > 0) {
        const ns = type.name.slice(0, dot);
        const target = symbols.get(path)?.get(ns);
        if (target?.kind === "namespace") throw namespaceTypeError(type.name, path);
      }
      const target = symbols.get(path)?.get(type.name);
      if (target?.kind === "namespace") throw namespaceTypeError(type.name, path);
      if (!target) throw unknownTypeError(type.name, path);
      return { kind: "identifier", name: target.name, mangledName: target.mangledName };
    }
    case "array": return { ...type, element: resolveType(type.element, path, symbols, registry) };
    case "atomic": return { ...type, element: resolveType(type.element, path, symbols, registry) };
    case "vector": return { ...type, element: resolveType(type.element, path, symbols, registry) };
    case "matrix": return { ...type, element: resolveType(type.element, path, symbols, registry) };
    case "ptr": return { ...type, element: resolveType(type.element, path, symbols, registry) };
    case "texture": return { ...type, sampleType: type.sampleType ? resolveType(type.sampleType, path, symbols, registry) : undefined };
    default: return type;
  }
}

function unwrapAlias(type: WGSLType, registry?: Registry): WGSLType {
  if (!registry || type.kind !== "identifier") return type;
  const alias = registry.aliases.get(type.mangledName ?? type.name);
  return alias ? unwrapAlias(alias.target, registry) : type;
}

function resolveAliasesDeep(type: WGSLType, registry: Registry): WGSLType {
  const unwrapped = unwrapAlias(type, registry);
  switch (unwrapped.kind) {
    case "array": return { ...unwrapped, element: resolveAliasesDeep(unwrapped.element, registry) };
    case "atomic": return { ...unwrapped, element: resolveAliasesDeep(unwrapped.element, registry) };
    case "vector": return { ...unwrapped, element: resolveAliasesDeep(unwrapped.element, registry) };
    case "matrix": return { ...unwrapped, element: resolveAliasesDeep(unwrapped.element, registry) };
    case "ptr": return { ...unwrapped, element: resolveAliasesDeep(unwrapped.element, registry) };
    case "texture": return { ...unwrapped, sampleType: unwrapped.sampleType ? resolveAliasesDeep(unwrapped.sampleType, registry) : undefined };
    default: return unwrapped;
  }
}

function bindingKind(type: WGSLType, addressSpace?: AddressSpace): BindingKind {
  if (addressSpace === "uniform" || addressSpace === "storage") return "buffer";
  if (type.kind === "sampler") return "sampler";
  if (type.kind === "texture") return type.textureKind === "texture_external" ? "externalTexture" : "texture";
  return "unknown";
}


function reflectedBindingLayout(kind: BindingKind, addressSpace: AddressSpace | undefined, access: AccessMode | undefined, type: WGSLType, layout: HostShareableLayout | undefined): ReflectedBindingLayout | undefined {
  if (kind === "buffer") {
    const bufferType = addressSpace === "uniform" ? "uniform" : access === "read" ? "read-only-storage" : "storage";
    return { kind: "buffer", buffer: { type: bufferType, hasDynamicOffset: false, minBindingSize: layout?.size } };
  }
  if (type.kind === "sampler") return { kind: "sampler", sampler: { type: type.comparison ? "comparison" : "filtering" } };
  if (type.kind !== "texture") return undefined;
  if (type.textureKind === "texture_external") return { kind: "externalTexture", externalTexture: {} };
  if (type.textureKind.startsWith("texture_storage_")) {
    return { kind: "storageTexture", storageTexture: { access: storageTextureAccess(type.access), format: type.texelFormat ?? "rgba8unorm", viewDimension: textureViewDimension(type.dimension) } };
  }
  return { kind: "texture", texture: { sampleType: textureSampleType(type), viewDimension: textureViewDimension(type.dimension), multisampled: type.dimension === "multisampled_2d" || type.dimension === "depth_multisampled_2d" } };
}

function textureSampleType(type: Extract<WGSLType, { readonly kind: "texture" }>): TextureSampleType {
  if (type.textureKind.startsWith("texture_depth_")) return "depth";
  const sample = type.sampleType;
  if (sample?.kind === "scalar" && sample.name === "i32") return "sint";
  if (sample?.kind === "scalar" && sample.name === "u32") return "uint";
  return "unfilterable-float";
}

function textureViewDimension(dimension: TextureDimension | undefined): TextureViewDimension {
  switch (dimension) {
    case "1d": return "1d";
    case "2d_array":
    case "depth_2d_array": return "2d-array";
    case "cube":
    case "depth_cube": return "cube";
    case "cube_array":
    case "depth_cube_array": return "cube-array";
    case "3d": return "3d";
    default: return "2d";
  }
}

function storageTextureAccess(access: AccessMode | undefined): StorageTextureAccess {
  if (access === "read") return "read-only";
  if (access === "read_write") return "read-write";
  return "write-only";
}

function parseVarTemplate(tokens: readonly Token[], i: number): { addressSpace?: AddressSpace; access?: AccessMode; after: number } {
  if (tokens[i]?.text !== "<") return { after: i };
  const close = findNext(tokens, i, ">");
  const parts = splitGeneric(tokens.slice(i + 1, close)).map((part) => part.map((t) => t.text).join(""));
  return { addressSpace: parts[0] as AddressSpace | undefined, access: normalizeAccess(parts[1]), after: close + 1 };
}

function readAttrs(tokens: readonly Token[], start: number): [Attr[], number] {
  const attrs: Attr[] = [];
  let i = start;
  while (tokens[i]?.text === "@") {
    const name = expectIdent(tokens[i + 1]);
    i += 2;
    let args: Token[] = [];
    if (tokens[i]?.text === "(") {
      const close = matching(tokens, i);
      args = tokens.slice(i + 1, close);
      i = close + 1;
    }
    attrs.push({ name, args });
  }
  return [attrs, i];
}

function parseWorkgroupSize(attrs: readonly Attr[]): readonly [number, number, number] | undefined {
  const attr = attrs.find((item) => item.name === "workgroup_size");
  if (!attr) return undefined;
  const values = splitGeneric(attr.args).map((part) => Number(part.map((token) => token.text).join("")));
  return [values[0] ?? 1, values[1] ?? 1, values[2] ?? 1];
}

function numericAttr(attrs: readonly Attr[], name: string): number | undefined {
  const attr = attrs.find((item) => item.name === name);
  if (!attr) return undefined;
  const text = attr.args.map((token) => token.text).join("");
  const value = Number(text.replace(/[ui]$/, ""));
  return Number.isFinite(value) ? value : undefined;
}

function splitGeneric(tokens: readonly Token[]): readonly (readonly Token[])[] {
  const parts: Token[][] = [[]];
  let angle = 0;
  let paren = 0;
  for (const token of tokens) {
    if (token.text === "<") angle++;
    else if (token.text === ">") angle = Math.max(0, angle - 1);
    else if (token.text === "(") paren++;
    else if (token.text === ")") paren = Math.max(0, paren - 1);
    if (token.text === "," && angle === 0 && paren === 0) { parts.push([]); continue; }
    parts[parts.length - 1]!.push(token);
  }
  return parts.map(trim).filter((part) => part.length > 0);
}

function trim(tokens: readonly Token[]): readonly Token[] {
  let start = 0;
  let end = tokens.length;
  while (start < end && tokens[start]!.text === ",") start++;
  while (end > start && tokens[end - 1]!.text === ",") end--;
  return tokens.slice(start, end);
}

function mangledDeclName(module: MangleModule, name: string, kind: string): string {
  return kind === "override" ? name : mangle(module.path, name);
}
function literalArrayCount(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!isLiteralArrayCount(text)) return undefined;
  return Number(text.replace(/[ui]$/, ""));
}
function isLiteralArrayCount(text: string): boolean { return /^(0|[1-9][0-9]*)([ui])?$/.test(text); }
function expectIdent(token: Token | undefined): string { if (token?.kind !== "ident" && token?.kind !== "keyword") throw wgslError("VGPU-WGSL-REFLECT-PARSE", "Expected identifier", token?.line, token?.column); return token.text; }
function findNext(tokens: readonly Token[], start: number, text: string): number { for (let i = start; i < tokens.length; i++) if (tokens[i]!.text === text) return i; throw wgslError("VGPU-WGSL-REFLECT-PARSE", `Expected ${text}`, tokens[start]?.line, tokens[start]?.column); }
function findToken(tokens: readonly Token[], start: number, end: number, text: string): number | undefined { for (let i = start; i < end; i++) if (tokens[i]!.text === text) return i; return undefined; }
function skipUntil(tokens: readonly Token[], start: number, text: string): number { let depth = 0; for (let i = start; i < tokens.length; i++) { if (tokens[i]!.text === "{" || tokens[i]!.text === "(") depth++; if (tokens[i]!.text === "}" || tokens[i]!.text === ")") depth = Math.max(0, depth - 1); if (depth === 0 && tokens[i]!.text === text) return i; } return tokens.length; }
function matching(tokens: readonly Token[], open: number): number { const start = tokens[open]!.text; const end = start === "(" ? ")" : start === "{" ? "}" : ">"; let depth = 0; for (let i = open; i < tokens.length; i++) { if (tokens[i]!.text === start) depth++; if (tokens[i]!.text === end) { depth--; if (depth === 0) return i; } } throw wgslError("VGPU-WGSL-REFLECT-PARSE", `Unclosed ${start}`, tokens[open]?.line, tokens[open]?.column); }
function scalarName(text: string): ScalarKind | undefined { return (["f32", "f16", "i32", "u32", "bool"] as const).find((name) => name === text); }
function suffixScalar(suffix: string): WGSLType { return { kind: "scalar", name: suffix === "f" ? "f32" : suffix === "h" ? "f16" : suffix === "i" ? "i32" : "u32" }; }
function scalarSize(name: ScalarKind): number { return name === "f16" ? 2 : 4; }
function normalizeAccess(value: string | undefined): AccessMode | undefined { if (value === "read" || value === "write" || value === "read_write") return value; return undefined; }
function roundUp(align: number, value: number): number { return Math.ceil(value / align) * align; }
function typeName(type: WGSLType): string { switch (type.kind) { case "scalar": return type.name; case "identifier": return type.name; case "vector": return `vec${type.width}<${typeName(type.element)}>`; case "matrix": return `mat${type.columns}x${type.rows}<${typeName(type.element)}>`; case "array": return `array<${typeName(type.element)}${type.count === undefined ? "" : `,${type.count}`}>`; default: return type.kind; } }
function resolveImportPath(from: string, owner: string, modules: readonly MangleModule[]): string {
  const base = owner.slice(0, owner.lastIndexOf("/") + 1);
  const joined = from.startsWith("/") ? from : normalizeVirtualPath(`${base}${from}`);
  const candidates = [from, joined];
  return candidates.find((candidate) => modules.some((module) => module.path === candidate)) ?? joined;
}
function normalizeVirtualPath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}
