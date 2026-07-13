import type { MangleModule } from "./mangler.ts";
import { bindingKind, reflectedBindingLayout } from "./reflect-bind-layout.ts";
import { parseDeclarations } from "./reflect-declarations.ts";
import { layoutOf } from "./reflect-layout.ts";
import { buildModuleSymbols, buildRegistry, resolveType } from "./reflect-symbols.ts";
import type { BindingInfo, HostShareableLayout, Reflection } from "./reflect-types.ts";
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
    entryPoints: raw.flatMap((item) => item.entries),
    overrides: raw.flatMap((item) => item.overrides),
    featuresRequired: [...new Set(raw.flatMap((item) => item.features))],
    aliases: [...registry.aliases.values()],
    structs: [...registry.structs.values()],
    hostShareableLayouts,
  };
}
