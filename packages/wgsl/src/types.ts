/** V1 loader artifact. The bindings field is reserved for a future version bump and is not part of this shape. */
export interface ShaderSource {
  readonly version: 1;
  readonly wgsl: string;
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
