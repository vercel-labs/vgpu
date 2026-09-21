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
| source | string | ✔ | — | WGSL contents supplied by webpack. This value is authoritative for the entry module, including exported leaves and import graphs; imported modules still use normal file/package resolution. Ordinary leaves without top-level imports or direct `export fn` declarations are emitted directly, optionally minified. |
| this.resourcePath | string | ✖ | `"<webpack>"` for resolver entry fallback | Absolute path to the `.wgsl` entry. Anchors relative import resolution and dependency reporting; the loader does not reread the entry from this path. |
| this.async | `() => callback` | ✖ | synchronous mode | Required when the WGSL source has top-level imports or a direct `export fn`. Without async mode, those resolver paths throw `VGPU-WGSL-RUNTIME-IMPORT`. |
| this.addDependency | `(file: string) => void` | ✖ | no explicit extra dependencies | Called as each transitive dependency is discovered, before it is loaded, so webpack invalidates on imported `.wgsl` changes even when the current resolution fails. |
| this.getOptions | `() => unknown` | ✖ | `{}` | Reads `options.minify` when present. Unknown options are ignored. |
| options.minify | `boolean | MinifyOptions` | ✖ | `false` | `true` means `{ whitespace: true, identifiers: "safe" }`; object form defaults to `{ whitespace: true, identifiers: "none" }`. |

**Returns:** `string | void` — for ordinary leaf shaders, returns JavaScript module source synchronously. For direct-export leaves and import graphs, returns `void` and passes JavaScript module source to webpack's async callback.

**Throws:** `VGPU-WGSL-RUNTIME-IMPORT` when a WGSL file contains imports or direct exports but the loader context does not provide async mode — enable webpack asynchronous loader execution.
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
  functionExports: [],
};

console.log(shader.version);
```

## Notes

- **Framework setup lives in a guide, not here.** For `next.config.ts` (Turbopack rules or the `webpack()` hook), the ambient `.d.ts` that types `import shader from "./x.wgsl"`, and the client component that owns the canvas, read `npx vgpu docs cat nextjs.md`.
- TypeScript needs an ambient declaration before it accepts a `.wgsl` import. `@vgpu/wgsl` ships one: add `/// <reference types="@vgpu/wgsl/wgsl-types" />` to any `.d.ts` in your project.
- Loader output is `ShaderSource` v1: default export `{ version: 1, wgsl: "...", functionExports: [...] }`, not a bare string and not a reflection/binding map. Every new artifact includes `functionExports`, including `[]`; property presence is authoritative.
- For resolver-backed transforms, webpack's `source` argument remains the entry module instead of being reread from `resourcePath`. This preserves changes made by earlier loaders while imports continue to resolve relative to `resourcePath`.
- Imported files are registered with webpack before they are loaded. If a transient edit causes resolution to fail, a later valid save can therefore invalidate and rebuild the failed importer without restarting the dev server.
- A leaf WGSL file may declare entry resources. The imported-module purity rule is enforced when `resolveShader()` sees an import graph. A leaf with direct `export fn` declarations also goes through resolution so the loader removes the author-only marker and emits authored-to-final metadata; ordinary leaves keep the fast path with `functionExports: []`.
- **The loader never validates WGSL, in any mode, for either leaf files or import graphs.** It calls `resolveShader({ validate: false })` for imported graphs and direct-export leaves — parsing, purity checks, DCE, mangling, and optional minification still run, but the device-backed `createShaderModule` check does not. Ordinary leaves with no imports or direct exports are emitted directly, so they receive no semantic processing beyond optional minification and reserved-identifier diagnostics. There is no loader option to opt into validation; a `validate` key in the loader options is silently ignored. `npx next build`/`next dev` (webpack or Turbopack) will happily compile and ship invalid WGSL. The validation gate is `npx vgpu check --require-validation <file>` — run it in CI or as a pre-commit hook; see `npx vgpu docs cat cli.docs.md`.
- Do not put `@group/@binding` declarations in shared WGSL modules. Put resources in the entry file and export shared structs/functions from modules.
- **See also:** `ShaderSource`, `resolveShader`, `wgslVitePlugin`, and the `nextjs` guide (`npx vgpu docs cat nextjs.md`).
