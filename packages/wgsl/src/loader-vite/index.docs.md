# wgslVitePlugin

`wgslVitePlugin` lets Vite import `.wgsl` files as JavaScript string modules. Plain WGSL files are returned as raw source strings, while files with top-level vgpu-wgsl imports are resolved into one plain WGSL string during Vite transform.

`transformWgsl(source, id)` is the testable transform primitive. It accepts the WGSL source and file id, and returns `ViteLoadResult` with JavaScript code plus `map: null`; the code default-exports the original or resolved WGSL string. The default plugin wraps that primitive with `{ name, transform }` and only handles paths ending in `.wgsl`.

Options are optional. `wgslVitePlugin()` and `transformWgsl(source, id)` preserve previous behavior, including byte-for-byte output for leaf shaders. `minify` accepts `boolean | { whitespace?: boolean; identifiers?: "none" | "safe" }`:

```ts
import wgslVitePlugin, { transformWgsl } from "@vgpu/wgsl/loader-vite";

export default {
  plugins: [wgslVitePlugin({ minify: true })],
};

const whitespaceOnly = await transformWgsl(source, "/shader.wgsl", { minify: { whitespace: true } });
const safeIdentifiers = await transformWgsl(source, "/shader.wgsl", { minify: { identifiers: "safe" } });
```

`minify: true` is the production preset, equivalent to `{ whitespace: true, identifiers: "safe" }`. Object form defaults to whitespace on and identifiers off, so `{ minify: { whitespace: true } }` is whitespace-only and `{ minify: { identifiers: "safe" } }` enables whitespace plus safe identifier shortening.

Safe identifier shortening is AST/scope-aware and limited in this release to function-local `let`/`var`/`const`, function parameters, `for`-initializer locals, and resolver-generated private helper functions named like `_vgsl_<hash>__name` when analysis proves they are safe. It never renames entry points, resources/bindings/uniforms/storage/texture/samplers, overrides or references, struct/type names, struct fields, import/export/reflection-visible names, attributes, builtins, or WGSL predeclared names. If analysis is unsure, names are preserved. The minifier adds no dependency and does not produce compact-output source maps or struct-field renames yet.

Existing import flattening and collision-avoidance mangling for imported shader graphs is unchanged. The transform calls the resolver with validation disabled; `resolveShader()` itself validates unminified output before diagnostics and validates the final output when identifiers are enabled.

Resolution failures, package export problems, invalid imports, and validation-disabled resolver errors surface as structured `VGPU-WGSL-*` exceptions from the transform. Vite catches those exceptions and presents them as transform failures. Module layout is configured through normal file paths, package `exports`, and resolver-compatible source files.
