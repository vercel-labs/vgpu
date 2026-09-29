---
title: "wgslWebpackLoader"
description: "Webpack loader that turns `.wgsl` files into data-only JavaScript modules exporting prepared `ShaderSource` v2 artifacts. Use it when webpack should inline WGSL, resolve vgpu WGSL imports, and reflect the final shader at build time so the browser never loads the WGSL parser."
---

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
| source | string | ✔ | — | WGSL contents supplied by webpack. This value is authoritative for the entry module in every branch — ordinary leaves, direct-export leaves, and import graphs; the loader never rereads the entry from disk. Imported modules still use normal file/package resolution. |
| this.resourcePath | string | ✖ | `"<webpack>"` | Absolute path to the `.wgsl` entry. Anchors relative import resolution, dependency reporting, and the path named in reflection diagnostics. |
| this.async | `() => callback` | ✖ | synchronous mode | Required when the WGSL source has top-level imports or a direct `export fn`. Without async mode, those resolver paths throw `VGPU-WGSL-RUNTIME-IMPORT`. Ordinary leaves never call it. |
| this.addDependency | `(file: string) => void` | ✖ | no explicit extra dependencies | Called as each transitive dependency is discovered, before it is loaded, so webpack invalidates on imported `.wgsl` changes even when the current resolution fails. |
| this.getOptions | `() => unknown` | ✖ | `{}` | Reads `options.minify` when present. Unknown options, including `validate`, are ignored. |
| options.minify | `boolean | MinifyOptions` | ✖ | `false` | `true` means `{ whitespace: true, identifiers: "safe" }`; object form defaults to `{ whitespace: true, identifiers: "none" }`. Reflection and the checksum always describe the minified output. |

**Returns:** `string | void` — for ordinary leaf shaders, returns the JavaScript module source synchronously. For direct-export leaves and import graphs, returns `void` and passes the JavaScript module source to webpack's async callback. Either way the module is `export default { version: 2, wgsl, reflection, sourceChecksum, producer: "@vgpu/wgsl/prepare-v2", functionExports }`.

**Throws:**

- `VGPU-WGSL-RUNTIME-IMPORT` when a WGSL file contains imports or direct exports but the loader context does not provide async mode — enable webpack asynchronous loader execution.
- Any `resolveShader()` `VGPU-WGSL-*` or `VGPU-RESOLVE-MODULE-BINDING` error when import graph resolution fails — fix the WGSL import graph, module purity, or minify options.
- `VGPU-WGSL-MINIFY-IDENTIFIERS` or `VGPU-WGSL-MINIFY-BLOCK` when minification options/source are invalid for a leaf file — pass a valid minify mode or fix unterminated comments.
- The `prepareShader()` lexer, parser, and reflection diagnostics (`VGPU-WGSL-LEX-*`, `VGPU-WGSL-REFLECT-*`) when the final WGSL cannot be reflected — fix the WGSL the diagnostic reports. The loader supplies `resourcePath` as diagnostic context, although individual layout errors may omit it from their message. For ordinary leaves these now fail the build; see Notes.

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

An ordinary leaf returns its module source synchronously, which makes the loader easy to exercise in a test:

```ts
import wgslWebpackLoader from "@vgpu/wgsl/loader-webpack";

const glowSource = `
@group(0) @binding(0) var<uniform> intensity: f32;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv * intensity, 0.0, 1.0);
}
`;

const moduleSource = wgslWebpackLoader.call({ resourcePath: "/src/shaders/glow.wgsl" }, glowSource);

console.log(typeof moduleSource); // "string" — no async callback for an ordinary leaf
console.log(moduleSource?.includes('"producer":"@vgpu/wgsl/prepare-v2"')); // true
console.log(moduleSource?.includes("prepareShader")); // false — the emitted module is data only
```

The emitted module carries `version: 2`, the exact `wgsl`, its `reflection`, `sourceChecksum`, `producer`, and `functionExports: []`. Nothing in it imports or calls WGSL tooling.

## Notes

- **Framework setup lives in a guide, not here.** For `next.config.ts` (Turbopack rules or the `webpack()` hook), the ambient `.d.ts` that types `import shader from "./x.wgsl"`, and the client component that owns the canvas, read `npx vgpu docs cat nextjs.md`.
- TypeScript needs an ambient declaration before it accepts a `.wgsl` import. `@vgpu/wgsl` ships one: add `/// <reference types="@vgpu/wgsl/wgsl-types" />` to any `.d.ts` in your project.
- **Output is a prepared `ShaderSource` v2 artifact.** The default export is `{ version: 2, wgsl, reflection, sourceChecksum, producer, functionExports }` — the same shape `prepareShader()` returns, with `producer: "@vgpu/wgsl/prepare-v2"`. It is plain data: the module contains no `prepareShader()` call and no parser, resolver, or reflection import, so `draw`, `effect`, and `compute` consume it without bundling the WGSL parser. Rebuild with matching `@vgpu/wgsl` and `vgpu` versions; the renderer rejects older v1 artifacts.
- **Reflection describes the final WGSL.** The loader prepares the text it actually emits — after identifier and whitespace minification, import resolution, and dead-code elimination. For import graphs and direct-export leaves it reflects `resolved.wgsl` again instead of reusing `resolved.reflection`, which can describe the source before identifier minification. `sourceChecksum` is computed over that same final string.
- **`functionExports` is authoritative.** Every artifact includes the property. Ordinary leaves emit `functionExports: []`. Direct-export leaves and import graphs emit one record per surviving `export fn`: `name` is the authored export name, `resolvedName` is the declaration's final name in the emitted WGSL (after minification), and `parameterNames` keeps the authored parameter names.
- **Synchronous and asynchronous branches are unchanged.** An ordinary leaf — no top-level imports and no direct `export fn` — runs reserved-identifier diagnostics, optional minification, and preparation synchronously. A leaf with a direct `export fn` or any top-level import goes through `resolveShader()` asynchronously, which removes the author-only `export` marker and records authored-to-final identities.
- For resolver-backed transforms, webpack's `source` argument remains the entry module instead of being reread from `resourcePath`. This preserves changes made by earlier loaders while imports continue to resolve relative to `resourcePath`.
- Imported files are registered with webpack before they are loaded. If a transient edit causes resolution to fail, a later valid save can therefore invalidate and rebuild the failed importer without restarting the dev server.
- **Reflection-detectable parse and layout errors in ordinary leaves now fail the build.** Ordinary leaves used to be emitted with no parsing beyond optional minification. They are now reflected at build time, so malformed reflected declarations and invalid host-shareable layouts (for example a `bool` in a uniform struct) may throw `VGPU-WGSL-LEX-*` or `VGPU-WGSL-REFLECT-*` during `next build`/`next dev` instead of surfacing at runtime. Reflection is not device validation: type errors, undefined identifiers inside function bodies, and other errors only the native WGSL compiler detects still ship.
- **The loader never validates WGSL on a device, in any mode.** It calls `resolveShader({ validate: false })` for import graphs and direct-export leaves; that explicit value wins over `VGPU_VALIDATE`, so setting that environment variable never makes the loader acquire a device. Preparation itself is GPU-free. There is no loader option to opt into validation. The validation gate is `npx vgpu check --require-validation <file>` — run it in CI or as a pre-commit hook; see `npx vgpu docs cat cli.docs.md`.
- A leaf WGSL file may declare entry resources. The imported-module purity rule is enforced when `resolveShader()` sees an import graph. Do not put `@group/@binding` declarations in shared WGSL modules; put resources in the entry file and export shared structs/functions from modules.
- **See also:** `ShaderSource`, `prepareShader` (`@vgpu/wgsl/prepare`), `resolveShader`, `wgslVitePlugin`, and the `nextjs` guide (`npx vgpu docs cat nextjs.md`).
