import { wgslError, type VGPUError } from "./errors.ts";
import { scan } from "./scanner.ts";
import { applyIdentifierMinifyWgsl } from "./identifierMinify.ts";
import { printWgslTokens, type TokenPrinterOptions } from "./tokenPrinter.ts";

export type MinifyWgslOptions = TokenPrinterOptions;
/**
 * WGSL minifier controls.
 *
 * Object form defaults to `{ whitespace: true, identifiers: "none" }`.
 * `identifiers: "safe"` may shorten function-local let/var/const, function
 * parameters, for-init locals, and safe resolver-generated private helpers only.
 */
export interface MinifyOptions {
  /** Strip comments and unnecessary whitespace. Defaults to `true` in object form. */
  readonly whitespace?: boolean;
  /** Identifier mode. Defaults to `"none"`; `"safe"` is conservative and AST/scope-aware. */
  readonly identifiers?: "none" | "safe";
}
/** `true` is `{ whitespace: true, identifiers: "safe" }`; `false` disables minification. */
export type MinifyOption = boolean | MinifyOptions;
export interface NormalizedMinifyOptions { readonly whitespace: boolean; readonly identifiers: "none" | "safe" }

const defaultMinifyOptions: NormalizedMinifyOptions = { whitespace: false, identifiers: "none" };

export function normalizeMinifyOption(option: MinifyOption | undefined): NormalizedMinifyOptions {
  if (option === undefined || option === false) return defaultMinifyOptions;
  if (option === true) return { whitespace: true, identifiers: "safe" };
  const identifiers = option.identifiers ?? "none";
  if (identifiers !== "none" && identifiers !== "safe") {
    throw wgslError("VGPU-WGSL-MINIFY-IDENTIFIERS", `Unknown WGSL minify identifiers mode: ${String(identifiers)}`);
  }
  return { whitespace: option.whitespace ?? true, identifiers };
}

export function applyMinifyWgsl(source: string, option: MinifyOption | undefined): string {
  const minify = normalizeMinifyOption(option);
  if (minify.identifiers === "safe") return applyIdentifierMinifyWgsl(source, { whitespace: minify.whitespace }).wgsl;
  if (minify.whitespace) return minifyWgsl(source);
  return source;
}

export function minifyWgsl(source: string, options: MinifyWgslOptions = {}): string {
  try {
    return printWgslTokens(scan(source), options);
  } catch (error) {
    if (isWgslError(error) && error.code === "VGPU-WGSL-LEX-UNTERM-COMMENT") {
      throw wgslError("VGPU-WGSL-MINIFY-BLOCK", "Unterminated WGSL block comment", error.line, error.column);
    }
    throw error;
  }
}

function isWgslError(error: unknown): error is VGPUError {
  return typeof error === "object" && error !== null && "code" in error && "line" in error && "column" in error;
}
