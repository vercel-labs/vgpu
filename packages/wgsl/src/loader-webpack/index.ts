import { assertNoErrorDiagnostics } from "../loader-shared/diagnostics.ts";
import { shaderSourceModule } from "../loader-shared/emit.ts";
import { hasDirectFunctionExport } from "../loader-shared/source.ts";
import { wgslError } from "../runtime/errors.ts";
import { applyMinifyWgsl, type MinifyOption } from "../runtime/minify.ts";
import { withEntrySource } from "../runtime/package-resolution.ts";
import { reservedIdentifierDiagnosticsForSource } from "../runtime/reserved-identifiers.ts";
import { resolveShader } from "../runtime/resolve-shader.ts";
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
  const path = this.resourcePath ?? "<webpack>";
  const hasImports = hasTopLevelImport(source);
  const exportedLeaf = !hasImports && hasDirectFunctionExport(source, path);
  if (!hasImports && !exportedLeaf) {
    // An ordinary leaf .wgsl can be a legitimate entry that declares bindings, so the
    // entry-only module-purity rule is intentionally enforced only when an
    // importer resolves a graph through resolveShader().
    assertNoErrorDiagnostics(reservedIdentifierDiagnosticsForSource(path, source), path);
    const wgsl = applyMinifyWgsl(source, options.minify);
    return shaderSourceModule(wgsl);
  }
  const done = this.async?.();
  const run = async () => {
    const resolved = await resolveShader(withEntrySource({
      entry: path,
      validate: false,
      minify: options.minify,
      // Register each import as soon as it is discovered so a failed resolution remains watchable.
      onDependency: (dep) => this.addDependency?.(dep),
    }, source));
    assertNoErrorDiagnostics(resolved.diagnostics, path);
    return shaderSourceModule(resolved.wgsl, resolved.functionExports);
  };
  if (!done) throw wgslError("VGPU-WGSL-RUNTIME-IMPORT", "@vgpu/wgsl webpack loader requires asynchronous mode for imports or direct exports.");
  run().then((code) => done(null, code), (error: unknown) => done(error instanceof Error ? error : new Error(String(error))));
}

function readOptions(context: LoaderContext): WgslWebpackLoaderOptions {
  const raw = context.getOptions?.();
  if (raw && typeof raw === "object" && "minify" in raw) return { minify: (raw as { minify?: MinifyOption }).minify };
  return {};
}
