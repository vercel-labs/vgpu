# wgslWebpackLoader

Webpack loader that turns `.wgsl` files into JavaScript modules whose default export is a prepared `ShaderSource` v2 artifact. Use it when webpack should inline WGSL, resolve vgpu WGSL imports, and reflect the final shader at build time so the browser never loads the WGSL parser.

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
  resourceQuery?: string;
  async?: () => (error: Error | null, result?: string) => void;
  addBuildDependency?: (file: string) => void;
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
| this.resourceQuery | string | ✖ | `""` | Supplied by webpack or Turbopack for the current request — never an author option. The loader reads it only to recognize the private metadata requests that its own generated modules make; any other query, or none, takes the ordinary shader path unchanged. |
| this.async | `() => callback` | ✖ | synchronous mode | Required when the WGSL source has top-level imports or a direct `export fn`. Without async mode, those resolver paths throw `VGPU-WGSL-RUNTIME-IMPORT`. Ordinary leaves never call it. |
| this.addBuildDependency | `(file: string) => void` | ✖ | compiler files go to `this.addDependency` | Receives the loader's own compiler files — the installed `@vgpu/wgsl` `package.json`, its shipped metadata anchor, and every published `dist` JavaScript file — first, on every call: before private metadata requests and ordinary leaves return, and before any shader error. Webpack records them as build dependencies of the module; its default managed-package snapshot still treats an installed package's unchanged `name@version` as immutable (see Notes). Turbopack contexts never use this hook, even when one is present. |
| this.addDependency | `(file: string) => void` | ✖ | no explicit extra dependencies | Receives the compiler files when the context is Turbopack's or has no `addBuildDependency`; a context with neither hook skips compiler registration and still transforms. Separately, it is called as each transitive shader dependency is discovered, before it is loaded, so the bundler invalidates on imported `.wgsl` changes even when the current resolution fails. When a relative, `@/`, or mapped import — or the target of an installed package's `exports` entry — names a file that does not exist, the loader also registers the missing candidate paths (the path itself when it has an extension, otherwise `<path>.wgsl` then `<path>/index.wgsl`) before throwing `VGPU-WGSL-RES-NOTFOUND`, so recreating the file invalidates the build. Successful resolution registers only the selected shader file; shader dependencies keep their previous order, after any compiler files. |
| this.getOptions | `() => unknown` | ✖ | `{}` | Reads `options.minify` when present. Unknown options, including `validate` and the private compiler identity that `wgslTurbopackRule()` adds, are ignored. |
| options.minify | `boolean | MinifyOptions` | ✖ | `false` | `true` means `{ whitespace: true, identifiers: "safe" }`; object form defaults to `{ whitespace: true, identifiers: "none" }`. Reflection and the checksum always describe the minified output. |

**Returns:** `string | void` — for ordinary leaf shaders, returns the JavaScript module source synchronously. For direct-export leaves and import graphs, returns `void` and passes the JavaScript module source to webpack's async callback. Either way the module's default export evaluates to the plain object `{ version: 2, wgsl, reflection, sourceChecksum, producer: "@vgpu/wgsl/prepare-v2", functionExports }`; the module may also import a small parser-free decoder and loader-generated metadata modules (see Notes). The loader answers those private metadata requests synchronously.

**Throws:**

- `VGPU-WGSL-CACHE-IDENTITY` (`where: "wgslWebpackLoader"`) when the loader cannot list its compiler files — a missing, unreadable, or inconsistent `package.json`, `./loader-webpack` export, metadata anchor, or `dist` directory, a file resolving outside the package, or a symbolic directory inside `dist` — or when a dependency hook throws while registering one. `metadata.path` names the file — reinstall the matching `@vgpu/wgsl` release; for a workspace package, build `@vgpu/wgsl` first. Ordinary leaves and private metadata requests throw synchronously; import graphs and direct-export leaves report it through the async callback.
- `VGPU-WGSL-RUNTIME-IMPORT` when a WGSL file contains imports or direct exports but the loader context does not provide async mode — enable webpack asynchronous loader execution.
- Any `resolveShader()` `VGPU-WGSL-*` or `VGPU-RESOLVE-MODULE-BINDING` error when import graph resolution fails — fix the WGSL import graph, module purity, or minify options.
- `VGPU-WGSL-MINIFY-IDENTIFIERS` or `VGPU-WGSL-MINIFY-BLOCK` when minification options/source are invalid for a leaf file — pass a valid minify mode or fix unterminated comments.
- The `prepareShader()` lexer, parser, and reflection diagnostics (`VGPU-WGSL-LEX-*`, `VGPU-WGSL-REFLECT-*`) when the final WGSL cannot be reflected — fix the WGSL the diagnostic reports. The loader supplies `resourcePath` as diagnostic context, although individual layout errors may omit it from their message. For ordinary leaves these now fail the build; see Notes.
- `VGPU-WGSL-PACKED-METADATA-INVALID` when loader-generated shader metadata is malformed or was produced by incompatible `@vgpu/wgsl` loader assets — during the build, for a generated metadata request, or when a generated shader module is evaluated. It is an ordinary `Error` with `code` and `fix` (`"Rebuild with compatible @vgpu/wgsl loader assets."`), not a `ShaderSource` error — rebuild the affected bundle with compatible loader assets, and never import or edit generated metadata requests by hand.

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
console.log(moduleSource?.includes("prepareShader")); // false — the emitted module never calls it
```

The module's default export carries `version: 2`, the exact `wgsl`, its `reflection`, `sourceChecksum`, `producer`, and `functionExports: []`. Nothing in it imports or calls the WGSL parser, resolver, reflection, or `prepareShader()`.

## Notes

- **Framework setup lives in a guide, not here.** For `next.config.ts` (Turbopack rules or the `webpack()` hook), the ambient `.d.ts` that types `import shader from "./x.wgsl"`, and the client component that owns the canvas, read `npx vgpu docs cat nextjs.md`.
- **For Next.js Turbopack, use `wgslTurbopackRule()` from `@vgpu/wgsl/next` instead of this loader's specifier.** It returns a rule pointing at this loader, plus a compiler identity that changes Turbopack's cache key whenever the installed compiler changes. Use the raw loader directly for webpack — including Next's webpack mode — and custom bundlers.
- **Compiler files are registered on every call.** The installed `@vgpu/wgsl` `package.json`, metadata anchor, and published `dist` JavaScript go to `addBuildDependency` (webpack) or `addDependency` (Turbopack, or contexts without build dependencies). Registration takes effect only when the loader runs: a Turbopack cache hit can skip the loader, so a cache written by `@vgpu/wgsl` 0.5.0's bare-string rule needs the `wgslTurbopackRule()` migration or a one-time clear.
- **Webpack's default managed-package snapshot is version-based.** For packages installed under managed `node_modules`, webpack trusts an unchanged package `name@version` instead of hashing internal files; `addBuildDependency()` does not override that assumption. The retained-cache matrix rebuilt exact v2 for an authentic 0.5.0 `require.resolve()` upgrade whose public target changed, and in a separate disposable replay after the candidate manifest version changed. A bare same-version replacement stayed on v1. Workspace symlinks did observe same-version compiler edits and recovery. Clear webpack's cache only for a same-version in-place replacement or observed stale v1 output — not for every package upgrade.
- Do not add compiler files, a version string, or a cache key to the rule yourself, and do not disable caching to work around stale output. Use `wgslTurbopackRule()` for Turbopack; for webpack, preserve normal package versions and verify the rebuilt artifact is v2.
- TypeScript needs an ambient declaration before it accepts a `.wgsl` import. `@vgpu/wgsl` ships one: add `/// <reference types="@vgpu/wgsl/wgsl-types" />` to any `.d.ts` in your project.
- **Output is a prepared `ShaderSource` v2 artifact.** The default export is `{ version: 2, wgsl, reflection, sourceChecksum, producer, functionExports }` — the same shape `prepareShader()` returns, with `producer: "@vgpu/wgsl/prepare-v2"`. The evaluated default export is always that full plain object with own data properties. The exported object is deeply frozen in every form (literal and compact), so the renderer validates it once and reuses the result; no new imports, options, or syntax are involved. The module contains no `prepareShader()` call and no parser, resolver, or reflection import, so `draw`, `effect`, and `compute` consume it without bundling the WGSL parser. Rebuild with matching `@vgpu/wgsl` and `vgpu` versions; the renderer rejects older v1 artifacts.
- **Eligible reflection metadata may be emitted compactly.** When the bounded packing estimate predicts a smaller representation, the generated module imports a small parser-free decoder and rebuilds the full `reflection` when evaluated. Real webpack builds can additionally share independently reachable encoded metadata modules through the normal module graph. Turbopack and loader bridges that cannot guarantee a separate anchor rule keep the encoded table inline and resolve the decoder relative to the loader's own installed package. Final chunking and compression can change the result, so compact selection estimates savings rather than guaranteeing a smaller compressed bundle. Compact and literal forms export identical prepared data, and in either form each artifact gets its own freshly built, frozen objects, so one never shares mutable state with another. Inputs that are small, exceed a bound, or do not beat the estimate stay in a plain object literal. No author configuration or extra dependency is required, and the decoder, encoded format, generated anchor, and metadata requests are private implementation details, not author APIs.
- **Reflection describes the final WGSL.** The loader prepares the text it actually emits — after identifier and whitespace minification, import resolution, and dead-code elimination. For import graphs and direct-export leaves it reflects `resolved.wgsl` again instead of reusing `resolved.reflection`, which can describe the source before identifier minification. `sourceChecksum` is computed over that same final string.
- **`functionExports` is authoritative.** Every artifact includes the property. Ordinary leaves emit `functionExports: []`. Direct-export leaves and import graphs emit one record per surviving `export fn`: `name` is the authored export name, `resolvedName` is the declaration's final name in the emitted WGSL (after minification), and `parameterNames` keeps the authored parameter names.
- **Synchronous and asynchronous branches are unchanged.** An ordinary leaf — no top-level imports and no direct `export fn` — runs reserved-identifier diagnostics, optional minification, and preparation synchronously. A leaf with a direct `export fn` or any top-level import goes through `resolveShader()` asynchronously, which removes the author-only `export` marker and records authored-to-final identities.
- For resolver-backed transforms, webpack's `source` argument remains the entry module instead of being reread from `resourcePath`. This preserves changes made by earlier loaders while imports continue to resolve relative to `resourcePath`.
- Imported files are registered with webpack before they are loaded. If a transient edit causes resolution to fail, a later valid save can therefore invalidate and rebuild the failed importer without restarting the dev server. A deleted import works the same way: its missing candidate paths are registered before `VGPU-WGSL-RES-NOTFOUND` fails the build, so restoring the file lets webpack rebuild the importer.
- **Reflection-detectable parse and layout errors in ordinary leaves now fail the build.** Ordinary leaves used to be emitted with no parsing beyond optional minification. They are now reflected at build time, so malformed reflected declarations and invalid host-shareable layouts (for example a `bool` in a uniform struct) may throw `VGPU-WGSL-LEX-*` or `VGPU-WGSL-REFLECT-*` during `next build`/`next dev` instead of surfacing at runtime. Reflection is not device validation: type errors, undefined identifiers inside function bodies, and other errors only the native WGSL compiler detects still ship.
- **The loader never validates WGSL on a device, in any mode.** It calls `resolveShader({ validate: false })` for import graphs and direct-export leaves; that explicit value wins over `VGPU_VALIDATE`, so setting that environment variable never makes the loader acquire a device. Preparation itself is GPU-free. There is no loader option to opt into validation. The validation gate is `npx vgpu check --require-validation <file>` — run it in CI or as a pre-commit hook; see `npx vgpu docs cat cli.docs.md`.
- A leaf WGSL file may declare entry resources. The imported-module purity rule is enforced when `resolveShader()` sees an import graph. Do not put `@group/@binding` declarations in shared WGSL modules; put resources in the entry file and export shared structs/functions from modules.
- **See also:** `wgslTurbopackRule` (`@vgpu/wgsl/next`), `ShaderSource`, `prepareShader` (`@vgpu/wgsl/prepare`), `resolveShader`, `wgslVitePlugin`, and the `nextjs` guide (`npx vgpu docs cat nextjs.md`).
