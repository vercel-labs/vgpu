import { wgslError } from "../runtime/errors.ts";
import { resolveShader } from "../runtime/resolveShader.ts";
import { hasTopLevelImport } from "../runtime/scanner.ts";

type LoaderContext = { resourcePath?: string; async?: () => (error: Error | null, result?: string) => void; addDependency?: (file: string) => void };

export default function wgslWebpackLoader(this: LoaderContext, source: string): string | void {
  if (!hasTopLevelImport(source)) return `export default ${JSON.stringify(source)};`;
  const done = this.async?.();
  const run = async () => {
    const resolved = await resolveShader({ entry: this.resourcePath ?? "<webpack>", validate: false });
    // Webpack loader API: https://webpack.js.org/api/loaders/#thisadddependency
    // Invalidate this loader's output when any transitively-imported .wgsl file changes.
    for (const dep of resolved.deps) if (dep !== this.resourcePath) this.addDependency?.(dep);
    return `export default ${JSON.stringify(resolved.wgsl)};`;
  };
  if (!done) throw wgslError("VGPU-WGSL-RUNTIME-IMPORT", "@vgpu/wgsl webpack loader requires asynchronous mode for imports.");
  run().then((code) => done(null, code), (error: unknown) => done(error instanceof Error ? error : new Error(String(error))));
}
