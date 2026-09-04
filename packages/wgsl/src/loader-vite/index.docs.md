# wgslVitePlugin and transformWgsl

Vite/Rollup transform that turns `.wgsl` files into JavaScript modules exporting `ShaderSource` v1 objects. Use the plugin in Vite apps and `transformWgsl()` in tests or custom tooling.

## Import

```ts
import wgslVitePlugin, { transformWgsl } from "@vgpu/wgsl/loader-vite";
import type { ViteLoadResult } from "@vgpu/wgsl/loader-vite";
```

## Signature

```ts
interface ViteLoadResult { readonly code: string; readonly map: null }

interface WgslVitePluginOptions {
  readonly minify?: boolean | { readonly whitespace?: boolean; readonly identifiers?: "none" | "safe" };
}

interface TransformWgslOptions extends WgslVitePluginOptions {
  readonly source: string;
  readonly id: string;
  readonly onDependency?: (absPath: string) => void;
}

declare function transformWgsl(source: string, id: string, options?: WgslVitePluginOptions): Promise<ViteLoadResult>;
declare function transformWgsl(opts: TransformWgslOptions): Promise<ViteLoadResult>;
declare function wgslVitePlugin(options?: WgslVitePluginOptions): {
  readonly name: string;
  readonly transform: (this: { addWatchFile(fileName: string): void }, source: string, id: string) => Promise<ViteLoadResult | null>;
};
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| options.minify | `boolean | MinifyOptions` | ✖ | `false` | Shared plugin/transform minify option. `true` means `{ whitespace: true, identifiers: "safe" }`; object form defaults to `{ whitespace: true, identifiers: "none" }`. |
| source | string | ✔ | — | WGSL contents supplied to the transform. This value is authoritative for the entry module, including exported leaves and import graphs; imported modules still use normal file/package resolution. Ordinary leaves without top-level imports or direct `export fn` declarations are emitted directly, optionally minified. |
| id | string | ✔ | — | WGSL file id/path. Anchors relative import resolution and dependency reporting; direct `transformWgsl()` calls may use an entry path that does not exist on disk. Plugin transform ignores ids that do not end with `.wgsl`. |
| opts.source | string | ✔ | — | Object-overload source field. |
| opts.id | string | ✔ | — | Object-overload id field. |
| opts.onDependency | `(absPath: string) => void` | ✖ | no callback | Called for each transitive dependency as soon as its path resolves, before it is loaded. Discovered dependencies are still reported when a later resolution step throws. Leaf files intentionally do not call it. |

**Returns:** `Promise<ViteLoadResult>` from `transformWgsl()` with JavaScript module `code` and `map: null`; plugin `transform` returns that result for `.wgsl` ids or `null` for other ids.

**Throws:** Any `resolveShader()` `VGPU-WGSL-*` or `VGPU-RESOLVE-MODULE-BINDING` error when import graph resolution fails — fix imports, module purity, package resolution, duplicates, or WGSL validation/minification.
**Throws:** `VGPU-WGSL-MINIFY-IDENTIFIERS` or `VGPU-WGSL-MINIFY-BLOCK` when minification options/source are invalid for a leaf file — pass a valid minify mode or fix unterminated comments.

## Examples

```ts
import wgslVitePlugin from "@vgpu/wgsl/loader-vite";

const viteConfig = {
  plugins: [wgslVitePlugin({ minify: true })],
};

export default viteConfig;
```

```ts
import { transformWgsl } from "@vgpu/wgsl/loader-vite";

const result = await transformWgsl(
  "@compute @workgroup_size(1) fn main() {}",
  "/shader.wgsl",
  { minify: { whitespace: true } },
);

console.log(result.map === null, result.code.includes("version"));
```

## Notes

- Transform output default-exports `ShaderSource` v1: `{ version: 1, wgsl: "...", functionExports: [...] }`. Every new artifact includes `functionExports`, including `[]`; property presence is authoritative for integrations that address direct exports.
- `wgslVitePlugin()` only handles ids ending with `.wgsl`; use `transformWgsl()` directly for tests and non-Vite tooling.
- For resolver-backed transforms, `source` remains the entry module instead of being reread from `id`. This preserves changes made by earlier Vite plugins and supports virtual entry modules while imports continue to resolve relative to `id`.
- Leaf shader transforms do not call `onDependency` because Vite already tracks the entry file. Imported graph transforms call it for transitive dependencies before loading them, including on resolution paths that later fail.
- A leaf WGSL file may declare entry resources. Shared/imported modules must be pure: no `@group/@binding` outside the entry.
- A leaf with a direct `export fn` goes through resolution even without imports: the author-only `export` marker is removed and the surviving function receives authored-to-final identity metadata. Ordinary leaves keep the byte-preserving fast path and emit `functionExports: []`.
- **The plugin never validates WGSL, in any mode, for either leaf files or import graphs.** It calls `resolveShader({ validate: false })` for imported graphs and direct-export leaves — parsing, purity checks, DCE, mangling, and optional minification still apply, but the device-backed `createShaderModule` check does not run. Ordinary leaves with no imports or direct exports are emitted directly, so they receive no semantic processing beyond optional minification and reserved-identifier diagnostics. There is no plugin option to opt into validation; a `validate` key in the plugin options is silently ignored. `vite build`/`vite dev` will happily compile and ship invalid WGSL. The validation gate is `npx vgpu check --require-validation <file>` — run it in CI or as a pre-commit hook; see `npx vgpu docs cat cli.docs.md`.
- **See also:** `ShaderSource`, `resolveShader`, `wgslWebpackLoader`, and the `nextjs` guide (`npx vgpu docs cat nextjs.md`) for the ambient `.d.ts` that types `.wgsl` imports.
