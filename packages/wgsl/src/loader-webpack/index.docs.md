# wgslWebpackLoader

`wgslWebpackLoader` lets webpack-compatible bundlers import `.wgsl` files as JavaScript string modules. Plain WGSL files are emitted as `export default "..."`; files with top-level vgpu-wgsl imports are resolved to one plain WGSL string before webpack receives the module.

The loader input is the WGSL source and the webpack loader context, including `resourcePath`. It outputs JavaScript module source whose default export is the resolved WGSL string. Imported files are read relative to `resourcePath`, so normal webpack file watching should include the entry file while resolver errors identify missing or invalid imported modules.

Options are optional. By default `{ minify: false }` preserves previous behavior and emits leaf shaders byte-for-byte unchanged. `minify` accepts `boolean | { whitespace?: boolean; identifiers?: "none" | "safe" }`:

```js
module.exports = {
  module: {
    rules: [{ test: /\.wgsl$/, loader: "@vgpu/wgsl/loader-webpack", options: { minify: true } }],
  },
};
```

`minify: true` is the production preset, equivalent to `{ whitespace: true, identifiers: "safe" }`. Object form defaults to whitespace on and identifiers off, so `{ minify: { whitespace: true } }` is whitespace-only and `{ minify: { identifiers: "safe" } }` enables whitespace plus safe identifier shortening.

Safe identifier shortening is AST/scope-aware and limited in this release to function-local `let`/`var`/`const`, function parameters, `for`-initializer locals, and resolver-generated private helper functions named like `_vgsl_<hash>__name` when analysis proves they are safe. It never renames entry points, resources/bindings/uniforms/storage/texture/samplers, overrides or references, struct/type names, struct fields, import/export/reflection-visible names, attributes, builtins, or WGSL predeclared names. If analysis is unsure, names are preserved. The minifier adds no dependency and does not produce compact-output source maps or struct-field renames yet.

Existing import flattening and collision-avoidance mangling for imported shader graphs is unchanged. The loader calls the resolver with validation disabled; `resolveShader()` itself validates unminified output before diagnostics and validates the final output when identifiers are enabled.

The loader must run in asynchronous loader mode when imports are present. If async mode is unavailable, or if resolution fails, it reports a structured `VGPU-WGSL-*` error through webpack's callback. Package resolution is controlled by filesystem/package metadata rather than loader-specific syntax.
