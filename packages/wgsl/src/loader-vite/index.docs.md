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
| source | string | ✔ | — | Raw WGSL file contents. Leaf files without top-level imports are emitted directly, optionally minified. |
| id | string | ✔ | — | WGSL file id/path. Used as resolver entry for import graphs. Plugin transform ignores ids that do not end with `.wgsl`. |
| opts.source | string | ✔ | — | Object-overload source field. |
| opts.id | string | ✔ | — | Object-overload id field. |
| opts.onDependency | `(absPath: string) => void` | ✖ | no callback | Called for transitive dependencies other than the entry when imports are resolved. Leaf files intentionally do not call it. |

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

- Transform output default-exports `ShaderSource` v1: `{ version: 1, wgsl: "..." }`.
- `wgslVitePlugin()` only handles ids ending with `.wgsl`; use `transformWgsl()` directly for tests and non-Vite tooling.
- Leaf shader transforms do not call `onDependency` because Vite already tracks the entry file. Imported graph transforms call it for transitive deps.
- A leaf WGSL file may declare entry resources. Shared/imported modules must be pure: no `@group/@binding` outside the entry.
- The transform calls `resolveShader({ validate: false })` for imported graphs; parsing, purity checks, DCE, mangling, and optional minification still apply.
- **See also:** `ShaderSource`, `resolveShader`, `wgslWebpackLoader`.
