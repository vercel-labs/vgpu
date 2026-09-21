import type { ShaderFunctionExport } from "../types.ts";

/** Emits the JavaScript module shape produced by WGSL bundler loaders. */
export function shaderSourceModule(
  wgsl: string,
  functionExports: readonly ShaderFunctionExport[] = [],
): string {
  return `export default { version: 1, wgsl: ${JSON.stringify(wgsl)}, functionExports: ${JSON.stringify(functionExports)} };`;
}
