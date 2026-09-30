import { dirname, isAbsolute, relative } from "node:path";
import { assertNoErrorDiagnostics } from "../loader-shared/diagnostics.ts";
import { shaderSourceModuleWithPackedImports, type PackedImportMode } from "../loader-shared/emit.ts";
import { packedModuleAssets, packedQueryModule } from "../loader-shared/packed-query.ts";
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
  resourceQuery?: string;
  resourceFragment?: string;
  async?: () => (error: Error | null, result?: string) => void;
  addDependency?: (file: string) => void;
  getOptions?: () => unknown;
  _compiler?: object;
  _module?: { readonly __reserved?: unknown };
  loaders?: readonly { readonly path?: string }[];
  loaderIndex?: number;
};

export default function wgslWebpackLoader(this: LoaderContext, source: string): string | void {
  const packedModule = packedQueryModule(
    this.resourcePath ?? "<webpack>",
    `${this.resourceQuery ?? ""}${this.resourceFragment ?? ""}`,
  );
  if (packedModule !== null) return packedModule;
  const options = readOptions(this);
  const path = this.resourcePath ?? "<webpack>";
  const packedImports = packedImportMode(this, path);
  const hasImports = hasTopLevelImport(source);
  const exportedLeaf = !hasImports && hasDirectFunctionExport(source, path);
  if (!hasImports && !exportedLeaf) {
    // An ordinary leaf .wgsl can be a legitimate entry that declares bindings, so the
    // entry-only module-purity rule is intentionally enforced only when an
    // importer resolves a graph through resolveShader().
    assertNoErrorDiagnostics(reservedIdentifierDiagnosticsForSource(path, source), path);
    const wgsl = applyMinifyWgsl(source, options.minify);
    return shaderSourceModuleWithPackedImports(wgsl, path, [], packedImports);
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
    return shaderSourceModuleWithPackedImports(resolved.wgsl, path, resolved.functionExports, packedImports);
  };
  if (!done) throw wgslError("VGPU-WGSL-RUNTIME-IMPORT", "@vgpu/wgsl webpack loader requires asynchronous mode for imports or direct exports.");
  run().then((code) => done(null, code), (error: unknown) => done(error instanceof Error ? error : new Error(String(error))));
}

function packedImportMode(context: LoaderContext, resourcePath: string): PackedImportMode {
  if (context._compiler !== undefined && context._compiler !== null) {
    const index = context.loaderIndex;
    const loader = typeof index === "number" ? context.loaders?.[index]?.path : undefined;
    return loader && !/[!?#]/u.test(loader)
      ? { kind: "webpack", webpackLoader: loader }
      : { kind: "inline" };
  }
  if (isTurbopackContext(context._module?.__reserved)) {
    const decoder = relativeAssetRequest(resourcePath, packedModuleAssets().decoder);
    return decoder === null ? { kind: "plain" } : { kind: "inline", decoder };
  }
  return { kind: "inline" };
}

function isTurbopackContext(value: unknown): boolean {
  return value === "TurbopackContext"
    || (typeof value === "symbol" && value.description === "TurbopackContext")
    || (typeof value === "function" && value.name === "TurbopackContext")
    || (typeof value === "object" && value !== null && (
      value.constructor?.name === "TurbopackContext"
      || ("name" in value && value.name === "TurbopackContext")
    ));
}

function relativeAssetRequest(importer: string, asset: string): string | null {
  if (!isAbsolute(importer) || !isAbsolute(asset)) return null;
  const request = relative(dirname(importer), asset).replace(/\\/gu, "/");
  if (request === "" || isAbsolute(request) || /^[A-Za-z]:\//u.test(request)) return null;
  return request.startsWith("./") || request.startsWith("../") ? request : `./${request}`;
}

function readOptions(context: LoaderContext): WgslWebpackLoaderOptions {
  const raw = context.getOptions?.();
  if (raw && typeof raw === "object" && "minify" in raw) return { minify: (raw as { minify?: MinifyOption }).minify };
  return {};
}
