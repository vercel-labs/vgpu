import { wgslError } from "./errors.ts";
import { parseModule } from "./parser.ts";
import { reflect, type Reflection } from "./reflect.ts";
import { scan } from "./scanner.ts";

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
} from "./reflect.ts";

/**
 * Reflects one raw WGSL string through the same scanner/parser/ReflectionFacade path as resolveShader().
 * This intentionally rejects WGSL import graphs; use resolveShader() when imports must be loaded/mangled.
 */
export function reflectSource(wgsl: string, path = "<runtime>"): Reflection {
  const tokens = scan(wgsl);
  const parsed = parseModule(tokens);
  if (parsed.imports.length > 0) {
    throw wgslError("VGPU-WGSL-REFLECT-SOURCE-IMPORT", "reflectSource() accepts a single raw WGSL string; use resolveShader() for WGSL import graphs.");
  }
  return reflect([{ path, source: wgsl, tokens, parsed }]);
}
