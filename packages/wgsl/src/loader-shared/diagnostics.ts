import type { Diagnostic } from "../runtime/diagnostic-types.ts";
import { wgslError } from "../runtime/errors.ts";

/**
 * Bundler loaders must fail the build on error-severity diagnostics; emitting a
 * module whose WGSL Dawn will reject only defers the failure to pipeline creation.
 * Warnings (e.g. `VGPU-WGSL-PKG-CONDITIONAL`) stay non-fatal.
 */
export function assertNoErrorDiagnostics(diagnostics: readonly Diagnostic[], fallbackPath: string): void {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length === 0) return;
  const details = errors.map((error) => `  ${location(error, fallbackPath)}: ${error.message}`).join("\n");
  throw wgslError(errors[0]!.code, `${errors.length === 1 ? "1 error" : `${errors.length} errors`} in WGSL:\n${details}`, errors[0]!.line, errors[0]!.column);
}

function location(diagnostic: Diagnostic, fallbackPath: string): string {
  const range = diagnostic.range as { file?: string } | undefined;
  const file = typeof range?.file === "string" ? range.file : fallbackPath;
  return diagnostic.line === undefined ? file : `${file}:${diagnostic.line}:${diagnostic.column ?? 0}`;
}
