import { shaderSourceModule } from "../loader-shared/emit.ts";
import { wgslError } from "../runtime/errors.ts";
import { applyMinifyWgsl, type MinifyOption } from "../runtime/minify.ts";
import { resolveShader } from "../runtime/resolveShader.ts";
import { hasTopLevelImport } from "../runtime/scanner.ts";

export interface WgslWebpackLoaderOptions {
  /** See `MinifyOption`: `true` is whitespace plus safe identifier shortening; object form defaults to whitespace-only. */
  readonly minify?: MinifyOption;
}
type LoaderContext = {
  resourcePath?: string;
  async?: () => (error: Error | null, result?: string) => void;
  addDependency?: (file: string) => void;
  getOptions?: () => unknown;
};

export default function wgslWebpackLoader(this: LoaderContext, source: string): string | void {
  const options = readOptions(this);
  if (!hasTopLevelImport(source)) {
    // A leaf .wgsl can be a legitimate entry that declares bindings, so the
    // entry-only module-purity rule is intentionally enforced only when an
    // importer resolves a graph through resolveShader().
    const wgsl = applyMinifyWgsl(source, options.minify);
    return shaderSourceModule(wgsl);
  }
  const done = this.async?.();
  const run = async () => {
    const resolved = await resolveShader({ entry: this.resourcePath ?? "<webpack>", validate: false, minify: options.minify });
    // Webpack loader API: https://webpack.js.org/api/loaders/#thisadddependency
    // Invalidate this loader's output when any transitively-imported .wgsl file changes.
    for (const dep of resolved.deps) if (dep !== this.resourcePath) this.addDependency?.(dep);
    return shaderSourceModule(resolved.wgsl);
  };
  if (!done) throw wgslError("VGPU-WGSL-RUNTIME-IMPORT", "@vgpu/wgsl webpack loader requires asynchronous mode for imports.");
  run().then((code) => done(null, code), (error: unknown) => done(error instanceof Error ? error : new Error(String(error))));
}

function readOptions(context: LoaderContext): WgslWebpackLoaderOptions {
  const raw = context.getOptions?.();
  if (raw && typeof raw === "object" && "minify" in raw) return { minify: (raw as { minify?: MinifyOption }).minify };
  return {};
}
