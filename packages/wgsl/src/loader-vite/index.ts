import { applyMinifyWgsl, type MinifyOption } from "../runtime/minify.ts";
import { resolveShader } from "../runtime/resolveShader.ts";
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
 * If the source has no top-level imports (i.e. is a leaf shader), `transformWgsl`
 * returns early without invoking the `onDependency` callback. This is intentional:
 * bundlers (webpack, vite, turbopack) already track the entry module automatically,
 * so explicit notification would be redundant. The callback is only invoked for
 * transitively-imported `.wgsl` files.
 */
export function transformWgsl(source: string, id: string, options?: WgslVitePluginOptions): Promise<ViteLoadResult>;
export function transformWgsl(opts: TransformWgslOptions): Promise<ViteLoadResult>;
export async function transformWgsl(sourceOrOpts: string | TransformWgslOptions, id?: string, options: WgslVitePluginOptions = {}): Promise<ViteLoadResult> {
  const opts = typeof sourceOrOpts === "string" ? { ...options, source: sourceOrOpts, id: id ?? "<vite>" } : sourceOrOpts;
  if (!hasTopLevelImport(opts.source)) {
    const wgsl = applyMinifyWgsl(opts.source, opts.minify);
    return { code: `export default ${JSON.stringify(wgsl)};`, map: null };
  }
  const resolved = await resolveShader({ entry: opts.id, validate: false, minify: opts.minify });
  for (const dep of resolved.deps) if (dep !== opts.id) opts.onDependency?.(dep);
  return { code: `export default ${JSON.stringify(resolved.wgsl)};`, map: null };
}

export function wgslVitePlugin(options: WgslVitePluginOptions = {}): { readonly name: string; readonly transform: (this: VitePluginContext, source: string, id: string) => Promise<ViteLoadResult | null> } {
  return {
    name: "@vgpu/wgsl",
    async transform(source, id) {
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

export default wgslVitePlugin;
