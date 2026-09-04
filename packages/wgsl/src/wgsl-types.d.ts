declare module "*.wgsl" {
  const source: {
    readonly version: 1;
    readonly wgsl: string;
    readonly functionExports?: readonly {
      readonly name: string;
      readonly resolvedName: string;
      readonly parameterNames: readonly string[];
    }[];
  };
  export default source;
}
