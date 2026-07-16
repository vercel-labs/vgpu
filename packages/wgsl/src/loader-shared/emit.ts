/** Emits the JavaScript module shape produced by WGSL bundler loaders. */
export function shaderSourceModule(wgsl: string): string {
  return `export default { version: 1, wgsl: ${JSON.stringify(wgsl)} };`;
}
