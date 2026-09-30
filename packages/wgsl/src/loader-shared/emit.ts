import type { ShaderFunctionExport } from "../types.ts";
import { prepareShader } from "../prepare.ts";
import { packedModuleAssets } from "./packed-query.ts";
import { selectInlinePackedReflection, selectPackedReflection } from "./packed-selection.ts";

export type PackedImportMode =
  | { readonly kind: "standard" }
  | { readonly kind: "inline"; readonly decoder?: string }
  | { readonly kind: "webpack"; readonly webpackLoader: string }
  | { readonly kind: "plain" };

/** Emits the JavaScript module shape produced by WGSL bundler loaders. */
export function shaderSourceModule(
  wgsl: string,
  path: string,
  functionExports: readonly ShaderFunctionExport[] = [],
): string {
  return shaderSourceModuleWithPackedImports(wgsl, path, functionExports, { kind: "standard" });
}

export function shaderSourceModuleWithPackedImports(
  wgsl: string,
  path: string,
  functionExports: readonly ShaderFunctionExport[],
  mode: PackedImportMode,
): string {
  const prepared = prepareShader({ wgsl, functionExports }, path);
  const plan = mode.kind === "plain"
    ? null
    : mode.kind === "inline"
      ? selectInlinePackedReflection(prepared.reflection)
      : selectPackedReflection(prepared.reflection);
  if (plan === null) return `export default ${javascriptLiteral(prepared)};`;

  const { decoder, anchor } = packedModuleAssets();
  const sharedNames = plan.shared.map((_, index) => `_vgpuPackedBlock${index}`);
  const imports = [
    `import { decodePackedMetadata } from ${JSON.stringify(mode.kind === "inline" && mode.decoder !== undefined ? mode.decoder : decoder)};`,
    ...plan.shared.map((block, index) => {
      const request = mode.kind === "webpack"
        ? `!!${mode.webpackLoader}!${anchor}${block.query}`
        : `${anchor}${block.query}`;
      return `import ${sharedNames[index]} from ${JSON.stringify(request)};`;
    }),
  ];
  const reflection = `/* @__PURE__ */ decodePackedMetadata(${javascriptLiteral(plan.table)}, [${sharedNames.join(",")}])`;
  const fields = Object.keys(prepared).map((key) => {
    const value = key === "reflection"
      ? reflection
      : javascriptLiteral((prepared as unknown as Record<string, unknown>)[key]);
    return `${javascriptKey(key)}:${value}`;
  });
  return `${imports.join("\n")}\nexport default {${fields.join(",")}};`;
}

function javascriptLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? "undefined" : parsedJsonLiteral(JSON.parse(json));
}

function parsedJsonLiteral(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(parsedJsonLiteral).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).map((key) =>
      `${javascriptKey(key)}:${parsedJsonLiteral((value as Record<string, unknown>)[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function javascriptKey(key: string): string {
  return key === "__proto__" ? '["__proto__"]' : JSON.stringify(key);
}
