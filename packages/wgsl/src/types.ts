/** Authored identity for one direct `export fn` that survives shader resolution. */
export interface ShaderFunctionExport {
  readonly name: string;
  readonly resolvedName: string;
  readonly parameterNames: readonly string[];
}

/** V1 loader artifact. Extra metadata is additive; bindings remain reserved for a future version bump. */
export interface ShaderSource {
  readonly version: 1;
  readonly wgsl: string;
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
