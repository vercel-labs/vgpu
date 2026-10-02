import type { WgslWebpackLoaderOptions } from "../loader-webpack/index.ts";
import { compilerInventoryForModule } from "../loader-shared/compiler-inventory.ts";
import { wgslErrorWithFix } from "../runtime/errors.ts";
import { normalizeMinifyOption } from "../runtime/minify.ts";

export type WgslTurbopackRuleOptions = WgslWebpackLoaderOptions;
type RuleValue = string | number | boolean | RuleValue[] | { [key: string]: RuleValue };
export interface WgslTurbopackRule {
  loaders: [{ loader: string; options: Record<string, RuleValue> }];
  as: "*.js";
}

const OPTIONS_FIX = "Pass only { minify?: boolean | { whitespace?: boolean; identifiers?: \"none\" | \"safe\" } }.";

export function wgslTurbopackRule(options?: WgslTurbopackRuleOptions): WgslTurbopackRule {
  validateOptions(options);
  const minify = { ...normalizeMinifyOption(options?.minify) };
  const inventory = compilerInventoryForModule(import.meta.url, "wgslTurbopackRule");
  return {
    loaders: [{
      loader: inventory.loader,
      options: { minify, vgpuImplementationFingerprint: inventory.fingerprint },
    }],
    as: "*.js",
  };
}

function validateOptions(options: WgslTurbopackRuleOptions | undefined): void {
  if (options === undefined) return;
  if (!isPlainObject(options)) throw optionsError("options");
  const unknown = Reflect.ownKeys(options).find((key) => key !== "minify");
  if (unknown !== undefined) throw optionsError(String(unknown));
  const minify = options.minify;
  if (minify === undefined || typeof minify === "boolean") return;
  if (!isPlainObject(minify)) throw optionsError("minify");
  const unknownMinify = Reflect.ownKeys(minify).find((key) => key !== "whitespace" && key !== "identifiers");
  if (unknownMinify !== undefined) throw optionsError(`minify.${String(unknownMinify)}`);
  if (minify.whitespace !== undefined && typeof minify.whitespace !== "boolean") throw optionsError("minify.whitespace");
  if (minify.identifiers !== undefined && minify.identifiers !== "none" && minify.identifiers !== "safe") {
    throw wgslErrorWithFix("VGPU-WGSL-MINIFY-IDENTIFIERS", `Unknown WGSL minify identifiers mode: ${String(minify.identifiers)}`, {
      where: "wgslTurbopackRule",
      fix: "Use identifiers: \"none\" or \"safe\".",
    });
  }
}

function optionsError(field: string) {
  return wgslErrorWithFix("VGPU-WGSL-NEXT-OPTIONS", `Invalid wgslTurbopackRule option: ${field}.`, {
    where: "wgslTurbopackRule",
    fix: OPTIONS_FIX,
    metadata: { field },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
