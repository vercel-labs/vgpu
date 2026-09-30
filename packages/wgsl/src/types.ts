import type {
  EntryPointInfo,
  Reflection,
} from "./runtime/reflect-source.ts";

/** Authored identity for one direct `export fn` that survives shader resolution. */
export interface ShaderFunctionExport {
  readonly name: string;
  readonly resolvedName: string;
  readonly parameterNames: readonly string[];
}

export type WorkgroupAxis = number | "unresolved";

export type ShaderEntryPoint = Omit<
  EntryPointInfo,
  "workgroupSize" | "bindings" | "samplingPairs"
> & {
  readonly workgroupSize?: readonly [
    WorkgroupAxis,
    WorkgroupAxis,
    WorkgroupAxis,
  ];
  readonly bindings: NonNullable<EntryPointInfo["bindings"]>;
  readonly samplingPairs: NonNullable<EntryPointInfo["samplingPairs"]>;
};

export type ShaderReflection = Omit<Reflection, "entryPoints"> & {
  readonly entryPoints: readonly ShaderEntryPoint[];
};

export interface ShaderSource {
  readonly version: 2;
  readonly wgsl: string;
  readonly reflection: ShaderReflection;
  readonly sourceChecksum: string;
  readonly producer: string;
  readonly functionExports?: readonly ShaderFunctionExport[];
}

export interface WGSLSource {
  readonly text: string;
  readonly path?: string;
  readonly imports?: readonly { readonly path: string; readonly from: string }[];
}

export interface SourceMap {
  readonly version: 1;
  readonly mappings: readonly [];
}

export interface WGSLAst {
  readonly version: 1;
  readonly modules: readonly [{ readonly path: string; readonly text: string }];
  readonly diagnostics: readonly [];
  readonly sourceMap: SourceMap;
  readonly cacheKey: Record<string, string>;
}

export interface ResolvedShader {
  readonly kind: "wgsl";
  readonly wgsl: string;
  readonly source: WGSLSource;
  readonly ast: WGSLAst;
  readonly sourceMap: SourceMap;
  readonly diagnostics: readonly [];
  readonly cacheKey: Record<string, string>;
  readonly entryPoints: readonly string[];
  readonly stats: { readonly lines: number; readonly bytes: number; readonly bindGroups: number };
}
