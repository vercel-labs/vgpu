import type { MangleModule } from "./mangler.ts";
import { bindingKind, reflectedBindingLayout } from "./reflect-bind-layout.ts";
import { parseDeclarations } from "./reflect-declarations.ts";
import { layoutOf } from "./reflect-layout.ts";
import { buildModuleSymbols, buildRegistry, resolveType, unwrapAlias } from "./reflect-symbols.ts";
import type { Attr, BindingInfo, EntryPointInfo, EntryPointInputInfo, HostShareableLayout, ModuleSymbols, ParsedEntryPoint, ParsedStructMember, Reflection, Registry } from "./reflect-types.ts";
import { numericAttr } from "./reflect-utils.ts";

export { layoutOf } from "./reflect-layout.ts";
export { DEFAULT_LAYOUT_MODE } from "./reflect-types.ts";
export type {
  AccessMode,
  AddressSpace,
  AliasInfo,
  BindingInfo,
  BindingKind,
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

  return {
    bindings: bindings.sort((a, b) => a.group - b.group || a.binding - b.binding),
    entryPoints: raw.flatMap((item) => item.entries.map((entry) => publicEntryPoint(entry, raw.flatMap((decls) => decls.structs), moduleSymbols, registry))),
    overrides: raw.flatMap((item) => item.overrides),
    featuresRequired: [...new Set(raw.flatMap((item) => item.features))],
    aliases: [...registry.aliases.values()],
    structs: [...registry.structs.values()],
    hostShareableLayouts,
  };
}

function publicEntryPoint(entry: ParsedEntryPoint, structs: readonly { readonly path: string; readonly mangledName: string; readonly members: readonly ParsedStructMember[] }[], symbols: ReadonlyMap<string, ModuleSymbols>, registry: Registry): EntryPointInfo {
  const result: EntryPointInfo = { name: entry.name, mangledName: entry.mangledName, stage: entry.stage, workgroupSize: entry.workgroupSize };
  if (entry.stage !== "vertex") return result;
  Object.defineProperty(result, "inputs", { value: vertexInputs(entry, structs, symbols, registry), enumerable: false });
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
