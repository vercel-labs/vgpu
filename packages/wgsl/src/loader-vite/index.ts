import { assertNoErrorDiagnostics } from "../loader-shared/diagnostics.ts";
import { shaderSourceModule } from "../loader-shared/emit.ts";
import { packedQueryModule } from "../loader-shared/packed-query.ts";
import { hasDirectFunctionExport } from "../loader-shared/source.ts";
import { applyMinifyWgsl, type MinifyOption } from "../runtime/minify.ts";
import { withEntrySource } from "../runtime/package-resolution.ts";
import { reservedIdentifierDiagnosticsForSource } from "../runtime/reserved-identifiers.ts";
import { resolveShader } from "../runtime/resolve-shader.ts";
import { hasTopLevelImport } from "../runtime/scanner.ts";

export interface ViteLoadResult { readonly code: string; readonly map: null }
export interface WgslVitePluginOptions {
  /** See `MinifyOption`: `true` is whitespace plus safe identifier shortening; object form defaults to whitespace-only. */
  readonly minify?: MinifyOption;
}
export interface TransformWgslOptions extends WgslVitePluginOptions { readonly source: string; readonly id: string; readonly onDependency?: (absPath: string) => void }
type VitePluginContext = { addWatchFile(fileName: string): void };

/**
 * Transforms a `.wgsl` source through the resolver and returns a `{code, map}`
 * pair suitable for a Rollup/Vite `transform` hook.
 *
 * @remarks
 * An ordinary leaf with no top-level imports or direct function exports returns
 * early without invoking the `onDependency` callback. This is intentional:
 * bundlers (webpack, vite, turbopack) already track the entry module automatically,
 * so explicit notification would be redundant. The callback is only invoked for
 * transitively-imported `.wgsl` files.
 */
export function transformWgsl(source: string, id: string, options?: WgslVitePluginOptions): Promise<ViteLoadResult>;
export function transformWgsl(opts: TransformWgslOptions): Promise<ViteLoadResult>;
export async function transformWgsl(sourceOrOpts: string | TransformWgslOptions, id?: string, options: WgslVitePluginOptions = {}): Promise<ViteLoadResult> {
  const opts = typeof sourceOrOpts === "string" ? { ...options, source: sourceOrOpts, id: id ?? "<vite>" } : sourceOrOpts;
  const request = splitRequest(opts.id);
  const packedModule = packedQueryModule(request.resourcePath, request.resourceQuery);
  if (packedModule !== null) return { code: packedModule, map: null };
  const hasImports = hasTopLevelImport(opts.source);
  const exportedLeaf = !hasImports && hasDirectFunctionExport(opts.source, opts.id);
  if (!hasImports && !exportedLeaf) {
    // An ordinary leaf .wgsl can be a legitimate entry that declares bindings, so the
    // entry-only module-purity rule is intentionally enforced only when an
    // importer resolves a graph through resolveShader().
    assertNoErrorDiagnostics(reservedIdentifierDiagnosticsForSource(opts.id, opts.source), opts.id);
    const wgsl = applyMinifyWgsl(opts.source, opts.minify);
    return { code: shaderSourceModule(wgsl, opts.id), map: null };
  }
  const resolved = await resolveShader(withEntrySource({
    entry: opts.id,
    validate: false,
    minify: opts.minify,
    onDependency: opts.onDependency,
  }, opts.source));
  assertNoErrorDiagnostics(resolved.diagnostics, opts.id);
  return { code: shaderSourceModule(resolved.wgsl, opts.id, resolved.functionExports), map: null };
}

export function wgslVitePlugin(options: WgslVitePluginOptions = {}): { readonly name: string; readonly transform: (this: VitePluginContext, source: string, id: string) => Promise<ViteLoadResult | null> } {
  return {
    name: "@vgpu/wgsl",
    async transform(source, id) {
      const request = splitRequest(id);
      const packedModule = packedQueryModule(request.resourcePath, request.resourceQuery);
      if (packedModule !== null) return { code: packedModule, map: null };
      if (!id.endsWith(".wgsl")) return null;
      return transformWgsl({
        source,
        id,
        minify: options.minify,
        onDependency: (absPath) => this.addWatchFile(absPath),
      });
    },
  };
}

function splitRequest(id: string): { readonly resourcePath: string; readonly resourceQuery: string } {
  const query = id.search(/[?#]/u);
  return query < 0
    ? { resourcePath: id, resourceQuery: "" }
    : { resourcePath: id.slice(0, query), resourceQuery: id.slice(query) };
}

export default wgslVitePlugin;
