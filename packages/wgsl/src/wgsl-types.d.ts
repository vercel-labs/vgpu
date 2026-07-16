declare module "*.wgsl" {
  const source: { readonly version: 1; readonly wgsl: string };
  export default source;
}
