---
title: "wgslVitePlugin and transformWgsl"
description: "Vite/Rollup transform that turns `.wgsl` files into JavaScript modules whose default export is a prepared `ShaderSource` v2 artifact. Use the plugin in Vite apps and `transformWgsl()` in tests or custom tooling; both reflect the final shader at build time so the browser never loads the WGSL parser."
---

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
| options.minify | `boolean | MinifyOptions` | ✖ | `false` | Shared plugin/transform minify option. `true` means `{ whitespace: true, identifiers: "safe" }`; object form defaults to `{ whitespace: true, identifiers: "none" }`. Reflection and the checksum always describe the minified output. |
| source | string | ✔ | — | WGSL contents supplied to the transform. This value is authoritative for the entry module in every branch — ordinary leaves, direct-export leaves, and import graphs; the entry is never reread from `id`. Imported modules still use normal file/package resolution. |
| id | string | ✔ | — | WGSL file id/path. Anchors relative import resolution, dependency reporting, and the path named in reflection diagnostics; direct `transformWgsl()` calls may use an entry path that does not exist on disk. The plugin transforms ids ending with `.wgsl` plus the private metadata requests that its own generated modules make; it returns `null` for every other id, including a `.wgsl` import with an unrelated query such as `?raw`. |
| opts.source | string | ✔ | — | Object-overload source field. |
| opts.id | string | ✔ | — | Object-overload id field. |
| opts.onDependency | `(absPath: string) => void` | ✖ | no callback | Called for each transitive dependency as soon as its path resolves, before it is loaded. Discovered dependencies are still reported when a later resolution step throws. When a relative, `@/`, or mapped import — or the target of an installed package's `exports` entry — names a file that does not exist, it also receives the missing candidate paths (the path itself when it has an extension, otherwise `<path>.wgsl` then `<path>/index.wgsl`) before `VGPU-WGSL-RES-NOTFOUND` is thrown. Successful resolution reports only the selected file, in the same order as before. Leaf files intentionally do not call it. The plugin forwards it to Vite's `addWatchFile`. |

**Returns:** `Promise<ViteLoadResult>` from `transformWgsl()` with JavaScript module `code` and `map: null`; plugin `transform` returns that result for `.wgsl` ids and its own private metadata requests, or `null` for other ids. The `code` is ESM source whose default export evaluates to the plain object `{ version: 2, wgsl, reflection, sourceChecksum, producer: "@vgpu/wgsl/prepare-v2", functionExports }`. It can contain `import` statements (see Notes), so evaluate it as a module; do not parse it as a lone JSON literal.

**Throws:**

- Any `resolveShader()` `VGPU-WGSL-*` or `VGPU-RESOLVE-MODULE-BINDING` error when import graph resolution fails — fix imports, module purity, package resolution, duplicates, or minification.
- `VGPU-WGSL-MINIFY-IDENTIFIERS` or `VGPU-WGSL-MINIFY-BLOCK` when minification options/source are invalid for a leaf file — pass a valid minify mode or fix unterminated comments.
- The `prepareShader()` lexer, parser, and reflection diagnostics (`VGPU-WGSL-LEX-*`, `VGPU-WGSL-REFLECT-*`) when the final WGSL cannot be reflected — fix the WGSL the diagnostic reports. The transform supplies `id` as diagnostic context, although individual layout errors may omit it from their message. For ordinary leaves these now fail the build; see Notes.
- `VGPU-WGSL-PACKED-METADATA-INVALID` when loader-generated shader metadata is malformed or was produced by incompatible `@vgpu/wgsl` loader assets — during the build, for a generated metadata request, or when a generated shader module is evaluated. It is an ordinary `Error` with `code` and `fix` (`"Rebuild with compatible @vgpu/wgsl loader assets."`), not a `ShaderSource` error — rebuild the affected bundle with compatible loader assets, and never import or edit generated metadata requests by hand.

## Examples

```ts
import wgslVitePlugin from "@vgpu/wgsl/loader-vite";

const viteConfig = {
  plugins: [wgslVitePlugin({ minify: true })],
};

export default viteConfig;
```

Call `transformWgsl()` directly to inspect the emitted artifact. The entry path does not need to exist on disk:

```ts
import { transformWgsl } from "@vgpu/wgsl/loader-vite";

const result = await transformWgsl(
  "@compute @workgroup_size(64) fn main() {}",
  "/src/shaders/particles.wgsl",
  { minify: { whitespace: true } },
);

console.log(typeof result.code); // "string" — ESM module source
console.log(result.map); // null
console.log(result.code.includes('"producer":"@vgpu/wgsl/prepare-v2"')); // true
```

The module's default export carries the minified `wgsl`, a `reflection` of that exact text (here one compute entry with workgroup size `[64, 1, 1]`), its `sourceChecksum`, and `functionExports: []`. Nothing in it imports or calls the WGSL parser, resolver, reflection, or `prepareShader()`.

## Notes

- **Output is a prepared `ShaderSource` v2 artifact.** The default export is `{ version: 2, wgsl, reflection, sourceChecksum, producer, functionExports }` — the same shape `prepareShader()` returns, with `producer: "@vgpu/wgsl/prepare-v2"`. The evaluated default export is always that full plain object with own data properties. The exported object is deeply frozen in every form (literal and compact), so the renderer validates it once and reuses the result; no new imports, options, or syntax are involved. The module contains no `prepareShader()` call and no parser, resolver, or reflection import, so `draw`, `effect`, and `compute` consume it without bundling the WGSL parser. Rebuild with matching `@vgpu/wgsl` and `vgpu` versions; the renderer rejects older v1 artifacts.
- **Eligible reflection metadata may be emitted compactly.** When bounded packing and module-extraction estimates predict a smaller representation, the generated module imports a small parser-free decoder and independently reachable metadata modules that the plugin itself generates, and rebuilds the full `reflection` when the module is evaluated. Rollup's normal graph decides which chunks include them, so final chunking and compression can change the result; compact selection estimates savings rather than guaranteeing a smaller compressed bundle. Both compact and literal forms export identical prepared data, and each artifact gets its own freshly built, frozen objects, so one artifact never shares mutable state with another even when encoded metadata is shared. Inputs that are small, exceed a bound, or do not beat the estimate stay in a plain object literal. None of this needs configuration or an extra dependency — the generated imports point at the `@vgpu/wgsl` installation that ran the transform — and the decoder, encoded format, and generated requests are private implementation details, not author APIs.
- **Reflection describes the final WGSL.** The transform prepares the text it actually emits — after identifier and whitespace minification, import resolution, and dead-code elimination. For import graphs and direct-export leaves it reflects `resolved.wgsl` again instead of reusing `resolved.reflection`, which can describe the source before identifier minification. `sourceChecksum` is computed over that same final string.
- **`functionExports` is authoritative.** Every artifact includes the property. Ordinary leaves emit `functionExports: []`. Direct-export leaves and import graphs emit one record per surviving `export fn`: `name` is the authored export name, `resolvedName` is the declaration's final name in the emitted WGSL (after minification), and `parameterNames` keeps the authored parameter names.
- Author imports stay ordinary `.wgsl` files. Besides those, `wgslVitePlugin()` handles only the private metadata requests its own generated modules make; ids with other queries or extensions keep their previous behavior. Use `transformWgsl()` directly for tests and non-Vite tooling.
- For resolver-backed transforms, `source` remains the entry module instead of being reread from `id`. This preserves changes made by earlier Vite plugins and supports virtual entry modules while imports continue to resolve relative to `id`.
- Leaf shader transforms do not call `onDependency` because Vite already tracks the entry file. Imported graph transforms call it for transitive dependencies before loading them, including on resolution paths that later fail, so a later valid save of the broken import triggers a rebuild. A deleted import works the same way: its missing candidate paths are reported before `VGPU-WGSL-RES-NOTFOUND` fails the transform, so restoring the file triggers a rebuild.
- A leaf with a direct `export fn` goes through resolution even without imports: the author-only `export` marker is removed and the surviving function receives authored-to-final identity metadata. Ordinary leaves skip resolution — reserved-identifier diagnostics, optional minification, then preparation — and emit `functionExports: []`.
- **Reflection-detectable parse and layout errors in ordinary leaves now fail the build.** Ordinary leaves used to be emitted with no parsing beyond optional minification. They are now reflected at build time, so malformed reflected declarations and invalid host-shareable layouts (for example a `bool` in a uniform struct) may throw `VGPU-WGSL-LEX-*` or `VGPU-WGSL-REFLECT-*` during `vite build`/`vite dev` instead of surfacing at runtime. Reflection is not device validation: type errors, undefined identifiers inside function bodies, and other errors only the native WGSL compiler detects still ship.
- **The plugin never validates WGSL on a device, in any mode.** It calls `resolveShader({ validate: false })` for import graphs and direct-export leaves; that explicit value wins over `VGPU_VALIDATE`, so setting that environment variable never makes the plugin acquire a device. Preparation itself is GPU-free. There is no plugin option to opt into validation. The validation gate is `npx vgpu check --require-validation <file>` — run it in CI or as a pre-commit hook; see `npx vgpu docs cat cli.docs.md`.
- A leaf WGSL file may declare entry resources. Shared/imported modules must be pure: no `@group/@binding` outside the entry.
- **See also:** `ShaderSource`, `prepareShader` (`@vgpu/wgsl/prepare`), `resolveShader`, `wgslWebpackLoader`, and the `nextjs` guide (`npx vgpu docs cat nextjs.md`) for the ambient `.d.ts` that types `.wgsl` imports.
