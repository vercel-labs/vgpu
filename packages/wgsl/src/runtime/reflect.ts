import type { MangleModule } from "./mangler.ts";
import { bindingKind, reflectedBindingLayout } from "./reflect-bind-layout.ts";
import { parseDeclarations } from "./reflect-declarations.ts";
import { layoutOf } from "./reflect-layout.ts";
import { buildModuleSymbols, buildRegistry, resolveType, unwrapAlias } from "./reflect-symbols.ts";
import type { Attr, BindingInfo, BindingRef, EntryPointInfo, EntryPointInputInfo, HostShareableLayout, ModuleSymbols, ParsedDecls, ParsedEntryPoint, ParsedStructMember, Reflection, Registry } from "./reflect-types.ts";
import { numericAttr } from "./reflect-utils.ts";
import { analyzeWgslTokens } from "./scope-walker.ts";

export { layoutOf } from "./reflect-layout.ts";
export { DEFAULT_LAYOUT_MODE } from "./reflect-types.ts";
export type {
  AccessMode,
  AddressSpace,
  AliasInfo,
  BindingInfo,
  BindingKind,
  BindingRef,
  EntryPointInfo,
  EntryPointInputInfo,
  HostShareableLayout,
  LayoutMember,
  LayoutMode,
  OverrideInfo,
  ReflectedBindingLayout,
  Reflection,
  ReflectionFacade,
  ScalarKind,
  StorageTextureAccess,
  StructInfo,
  StructMemberInfo,
  TextureDimension,
  TextureSampleType,
  TextureViewDimension,
  WGSLType,
} from "./reflect-types.ts";

/**
 * Reflects mangled WGSL modules into the frozen ReflectionFacade contract.
 * The returned names preserve source-facing identifiers while `mangledName` points at emitted WGSL.
 */
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

  bindings.sort((a, b) => a.group - b.group || a.binding - b.binding);
  const uses = entryBindingUses(modules, raw, bindings);
  return {
    bindings,
    entryPoints: raw.flatMap((item) => item.entries.map((entry) => publicEntryPoint(entry, raw.flatMap((decls) => decls.structs), moduleSymbols, registry, uses.get(entry) ?? bindings))),
    overrides: raw.flatMap((item) => item.overrides),
    featuresRequired: [...new Set(raw.flatMap((item) => item.features))],
    aliases: [...registry.aliases.values()],
    structs: [...registry.structs.values()],
    hostShareableLayouts,
  };
}

function entryBindingUses(modules: readonly MangleModule[], raw: readonly ParsedDecls[], all: readonly BindingInfo[]): ReadonlyMap<ParsedEntryPoint, readonly BindingRef[]> {
  const result = new Map<ParsedEntryPoint, readonly BindingRef[]>();
  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
    const module = modules[moduleIndex]!;
    const decls = raw[moduleIndex]!;
    const analysis = analyzeWgslTokens(module.tokens);
    const conservative = analysis.fallback.wholeModule || module.parsed.imports.length > 0;
    const functionDeclarations = new Map<number, number>();
    for (const declaration of analysis.declarations) {
      if (declaration.kind !== "function") continue;
      const fn = analysis.functions.find((item) => item.nameTokenIndex === declaration.tokenIndex);
      if (fn) functionDeclarations.set(declaration.id, fn.id);
    }
    const bindingDeclarations = new Map<number, BindingRef>();
    for (const variable of decls.vars) {
      const group = numericAttr(variable.attrs, "group");
      const binding = numericAttr(variable.attrs, "binding");
      if (group === undefined || binding === undefined) continue;
      const declaration = analysis.declarations.find((item) => item.kind === "global" && item.name === variable.name);
      if (declaration) bindingDeclarations.set(declaration.id, { group, binding });
    }
    for (const entry of decls.entries) {
      const root = analysis.functions.find((fn) => fn.name === entry.name);
      if (conservative || !root) { result.set(entry, all); continue; }
      const pending = [root.id];
      const visited = new Set<number>();
      const used = new Map<string, BindingRef>();
      let fallback = false;
      while (pending.length) {
        const functionId = pending.pop()!;
        if (visited.has(functionId)) continue;
        visited.add(functionId);
        const fn = analysis.functions[functionId];
        if (!fn || fn.skipped) { fallback = true; break; }
        for (const reference of analysis.references) {
          if (reference.functionId !== functionId) continue;
          const binding = bindingDeclarations.get(reference.declarationId);
          if (binding) used.set(`${binding.group}:${binding.binding}`, binding);
          const callee = functionDeclarations.get(reference.declarationId);
          if (callee !== undefined) pending.push(callee);
        }
      }
      result.set(entry, fallback ? all : [...used.values()].sort((a, b) => a.group - b.group || a.binding - b.binding));
    }
  }
  return result;
}

function publicEntryPoint(entry: ParsedEntryPoint, structs: readonly { readonly path: string; readonly mangledName: string; readonly members: readonly ParsedStructMember[] }[], symbols: ReadonlyMap<string, ModuleSymbols>, registry: Registry, bindings: readonly BindingRef[]): EntryPointInfo {
  const result: EntryPointInfo = { name: entry.name, mangledName: entry.mangledName, stage: entry.stage, workgroupSize: entry.workgroupSize };
  Object.defineProperty(result, "bindings", { value: bindings.map(({ group, binding }) => ({ group, binding })), enumerable: false, configurable: true });
  if (entry.stage === "vertex") Object.defineProperty(result, "inputs", { value: vertexInputs(entry, structs, symbols, registry), enumerable: false });
  return result;
}

function vertexInputs(entry: ParsedEntryPoint, structs: readonly { readonly path: string; readonly mangledName: string; readonly members: readonly ParsedStructMember[] }[], symbols: ReadonlyMap<string, ModuleSymbols>, registry: Registry): readonly EntryPointInputInfo[] {
  const inputs: EntryPointInputInfo[] = [];
  for (const param of entry.params) {
    if (hasAttr(param.attrs, "builtin")) continue;
    const type = resolveType(param.type, entry.path, symbols, registry);
    const location = numericAttr(param.attrs, "location");
    if (location !== undefined) {
      inputs.push({ name: param.name, location, type });
      continue;
    }
    const unwrapped = unwrapAlias(type, registry);
    if (unwrapped.kind !== "identifier") continue;
    const parsed = structs.find((item) => item.mangledName === (unwrapped.mangledName ?? unwrapped.name));
    const reflected = registry.structs.get(unwrapped.mangledName ?? unwrapped.name);
    if (!parsed) continue;
    for (let i = 0; i < parsed.members.length; i++) {
      const member = parsed.members[i]!;
      if (hasAttr(member.attrs, "builtin")) continue;
      const memberLocation = numericAttr(member.attrs, "location");
      if (memberLocation === undefined) continue;
      inputs.push({ name: member.name, location: memberLocation, type: reflected?.members[i]?.type ?? resolveType(member.type, parsed.path, symbols, registry) });
    }
  }
  return inputs;
}

function hasAttr(attrs: readonly Attr[], name: string): boolean {
  return attrs.some((attr) => attr.name === name);
}
