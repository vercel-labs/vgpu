import type { MangleModule } from "./mangler.ts";
import type { Token } from "./scanner.ts";

/**
 * Frozen reflection facade exported to runtime consumers. Any change here must be coordinated
 * with every Phase-2 ring-1 consumer because the Reflection interface is considered stable API.
 */
export interface Reflection {
  readonly bindings: readonly BindingInfo[];
  readonly entryPoints: readonly EntryPointInfo[];
  readonly overrides: readonly OverrideInfo[];
  readonly featuresRequired: readonly string[];
  readonly aliases: readonly AliasInfo[];
  readonly structs: readonly StructInfo[];
  readonly hostShareableLayouts: readonly HostShareableLayout[];
}

/** Public alias re-exported for backwards compatibility with the old `ReflectionFacade` name. */
export type ReflectionFacade = Reflection;

/** Layout strategy currently mirrors naga's host-shareable layout calculation. */
export type LayoutMode = "naga-standard";

/** Default layout mode used whenever a layout calculation is requested. */
export const DEFAULT_LAYOUT_MODE: LayoutMode = "naga-standard";

export type BindingKind = "buffer" | "texture" | "sampler" | "externalTexture" | "unknown";
export type AddressSpace = "function" | "private" | "workgroup" | "uniform" | "storage" | "handle";
export type AccessMode = "read" | "write" | "read_write";

/**
 * Metadata extracted for every `@group/@binding` declaration in the reflected modules.
 * `mangledName` is stable and can be used to correlate back to transpiled WGSL.
 */
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

/**
 * Host layout metadata describing how a WGSL value should be written to CPU-visible memory.
 * `layoutMode` documents the packing strategy, `runtimeSized` indicates an unsized runtime array
 * that must be manual bound by the caller.
 */
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

/**
 * Struct member layout metadata. `explicitAlign`/`explicitSize` reflect any `@align/@size`
 * attributes expressed in the original WGSL so the caller can reason about manual padding.
 */
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

/** Internal helper describing type information extracted from `parseDeclarations`. */
export type ParsedStruct = StructInfo & { readonly path: string; readonly originalName: string };
export type ParsedAlias = AliasInfo & { readonly path: string; readonly originalName: string };

export type ParsedDecls = {
  readonly structs: readonly ParsedStruct[];
  readonly aliases: readonly ParsedAlias[];
  readonly vars: readonly VarDecl[];
  readonly entries: readonly EntryPointInfo[];
  readonly overrides: readonly OverrideInfo[];
  readonly features: readonly string[];
};

export type VarDecl = {
  readonly path: string;
  readonly name: string;
  readonly mangledName: string;
  readonly attrs: readonly Attr[];
  readonly addressSpace?: AddressSpace;
  readonly access?: AccessMode;
  readonly type: WGSLType;
};

export type Attr = { readonly name: string; readonly args: readonly Token[]; readonly token?: Token };

export type ModuleSymbols = ReadonlyMap<string, SymbolTarget>;
export type SymbolTarget = { readonly path: string; readonly name: string; readonly mangledName: string; readonly kind: "struct" | "alias" | "namespace" };

export type Registry = {
  readonly structs: ReadonlyMap<string, StructInfo>;
  readonly aliases: ReadonlyMap<string, AliasInfo>;
  readonly byMangled: ReadonlyMap<string, StructInfo | AliasInfo>;
};

export interface ReflectionContext {
  readonly modules: readonly MangleModule[];
}

export interface ParseStructResult {
  readonly item?: ParsedStruct;
  readonly next: number;
}

export interface ParseAliasResult {
  readonly item?: ParsedAlias;
  readonly next: number;
}

export interface ParseVarResult {
  readonly item?: VarDecl;
  readonly next: number;
}

export interface ParseEntryPointResult {
  readonly item?: EntryPointInfo;
  readonly next: number;
}

export interface ParseOverrideResult {
  readonly item?: OverrideInfo;
  readonly next: number;
}

