import type { ShaderFunctionExport } from "../types.ts";
import { prepareShader } from "../prepare.ts";

/** Emits the JavaScript module shape produced by WGSL bundler loaders. */
export function shaderSourceModule(
  wgsl: string,
  path: string,
  functionExports: readonly ShaderFunctionExport[] = [],
): string {
  return `export default ${JSON.stringify(prepareShader({ wgsl, functionExports }, path))};`;
}
