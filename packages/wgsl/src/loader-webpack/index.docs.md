# wgslWebpackLoader

Webpack loader that turns `.wgsl` files into JavaScript modules exporting `ShaderSource` v1 objects. Use it when webpack should inline WGSL and resolve vgpu WGSL imports during bundling.

## Import

```ts
import wgslWebpackLoader from "@vgpu/wgsl/loader-webpack";
```

## Signature

```ts
interface WgslWebpackLoaderOptions {
  readonly minify?: boolean | { readonly whitespace?: boolean; readonly identifiers?: "none" | "safe" };
}

type LoaderContext = {
  resourcePath?: string;
  async?: () => (error: Error | null, result?: string) => void;
  addDependency?: (file: string) => void;
  getOptions?: () => unknown;
};

type WgslWebpackLoader = (this: LoaderContext, source: string) => string | void;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| source | string | ✔ | — | Raw WGSL file contents supplied by webpack. Leaf files without top-level imports are emitted directly, optionally minified. Files with top-level imports are resolved from `this.resourcePath`. |
| this.resourcePath | string | ✖ | `"<webpack>"` for resolver entry fallback | Absolute path to the `.wgsl` file. Needed for relative import resolution and dependency reporting. |
| this.async | `() => callback` | ✖ | synchronous mode | Required only when the WGSL source has top-level imports. Without async mode, imports throw `VGPU-WGSL-RUNTIME-IMPORT`. |
| this.addDependency | `(file: string) => void` | ✖ | no explicit extra dependencies | Called for transitive dependencies other than `resourcePath` so webpack invalidates on imported `.wgsl` changes. |
| this.getOptions | `() => unknown` | ✖ | `{}` | Reads `options.minify` when present. Unknown options are ignored. |
| options.minify | `boolean | MinifyOptions` | ✖ | `false` | `true` means `{ whitespace: true, identifiers: "safe" }`; object form defaults to `{ whitespace: true, identifiers: "none" }`. |

**Returns:** `string | void` — for leaf shaders, returns JavaScript module source synchronously. For import graphs, returns `void` and passes JavaScript module source to webpack's async callback.

**Throws:** `VGPU-WGSL-RUNTIME-IMPORT` when a WGSL file contains imports but the loader context does not provide async mode — enable webpack asynchronous loader execution.
**Throws:** Any `resolveShader()` `VGPU-WGSL-*` or `VGPU-RESOLVE-MODULE-BINDING` error when import graph resolution fails — fix the WGSL import graph, module purity, or minify options.
**Throws:** `VGPU-WGSL-MINIFY-IDENTIFIERS` or `VGPU-WGSL-MINIFY-BLOCK` when minification options/source are invalid for a leaf file — pass a valid minify mode or fix unterminated comments.

## Examples

```ts
const config = {
  module: {
    rules: [
      {
        test: /\.wgsl$/,
        loader: "@vgpu/wgsl/loader-webpack",
        options: { minify: true },
      },
    ],
  },
};

export default config;
```

```ts
import type { ShaderSource } from "@vgpu/wgsl";

const shader: ShaderSource = {
  version: 1,
  wgsl: "@compute @workgroup_size(1) fn main() {}",
};

console.log(shader.version);
```

## Notes

- Loader output is `ShaderSource` v1: default export `{ version: 1, wgsl: "..." }`, not a bare string and not a reflection/binding map.
- A leaf WGSL file may declare entry resources. The imported-module purity rule is enforced only when the file imports other modules and `resolveShader()` sees a graph.
- The loader calls `resolveShader({ validate: false })` for imported graphs; it still performs parsing, purity checks, DCE, mangling, and optional minification.
- Do not put `@group/@binding` declarations in shared WGSL modules. Put resources in the entry file and export shared structs/functions from modules.
- **See also:** `ShaderSource`, `resolveShader`, `wgslVitePlugin`.
