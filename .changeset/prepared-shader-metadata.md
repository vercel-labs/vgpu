---
"vgpu": minor
"@vgpu/wgsl": minor
---

## Summary

Renderer shaders are now prepared ahead of time. `draw(gpu, { shader })`, `effect(gpu, source)`, and
`compute(gpu, source)` accept only a prepared `ShaderSource` (`version: 2`): the final WGSL plus its
`reflection`, a `sourceChecksum`, and a `producer`. The renderer validates that metadata when you
create the draw, effect, or compute and never parses WGSL, so prepared-only browser consumers that
import `.wgsl` files and do not call `prepareShader()` at runtime no longer ship the WGSL scanner,
parser, or reflection.

The `@vgpu/wgsl` Vite and webpack/Turbopack loaders emit prepared ESM modules for every `.wgsl`
import — ordinary leaf files included, with `functionExports: []`. Generated modules never import
the WGSL parser. For eligible reflections, a bounded conservative estimate that requires distinct
substantial uniform layouts can select compact metadata decoded by a small parser-free helper;
Vite and webpack can also share private,
independently reachable encoded metadata modules. Compact and literal forms export the same full
own-data `ShaderSource` v2 object, while small inputs, bounded-work cases, and estimates that do not
justify packing fall back to the literal form. Final bundler compression can vary, so compact
selection estimates savings rather than guaranteeing them. The decoder, generated metadata modules,
and requests are private implementation details, not author APIs, and require no extra configuration.

Because leaf files are now reflected at build time, reflection-detectable parse and layout errors
(for example a `bool` in a uniform struct, `VGPU-WGSL-REFLECT-BOOL-HOST-SHAREABLE`) fail the build
instead of surfacing at runtime. Loaders still do not run device validation; keep
`npx vgpu check --require-validation` as the WGSL gate. When an import names a missing WGSL file,
`resolveShader()` reports the missing candidate paths through its existing `onDependency` callback
before `VGPU-WGSL-RES-NOTFOUND`, allowing Vite and webpack watch builds to rebuild after the file is
restored; successful dependency reporting is unchanged.

The new `prepareShader(source, path?)` from `@vgpu/wgsl/prepare` builds a prepared artifact at
runtime from a WGSL string, a `resolveShader()` result, or a legacy v1 asset, preserving
`functionExports` from object input. `ShaderReflection`, the type of `ShaderSource.reflection`, is
now exported from `@vgpu/wgsl`, `vgpu`, `vgpu/node`, `vgpu/mock`, and `vgpu/client`.

Renderers report unprepared or incompatible input synchronously:

- `VGPU-SHADER-SOURCE-UNPREPARED` for a raw WGSL string or a `version: 1` artifact.
- `VGPU-SHADER-SOURCE-VERSION` for any other integer `version`; the message names the received and
  supported versions and, when present, the artifact's `producer`.
- `VGPU-SHADER-SOURCE-INVALID` for a missing or malformed field, inconsistent reflection, or a
  `sourceChecksum` that does not match `wgsl`.

The checksum detects accidental replacement of `wgsl`; it does not authenticate an artifact or prove
that its reflection matches the WGSL. Prepared metadata is trusted: produce it with the loaders or
`prepareShader()` and never hand-edit it.

Unchanged: `reflectSource()` and `compile()` keep their string contracts (`compile()` still returns
a `ResolvedShader`, which is not a renderer input), native `device.createShaderModule({ code })`
calls still take strings, and `vgpu/three` still accepts raw strings, structural
`{ wgsl, functionExports }` objects, and v1 artifacts.

## Migration

### Affected usage

Code using `vgpu` 0.5.0 or earlier (or a canary build before this change) that passes any of the
following to `draw(gpu, { shader })`, `effect(gpu, source)`, or `compute(gpu, source)`:

- a raw WGSL string, including template literals, `readFileSync()` text, `resolveShader().wgsl`, or
  `compile().wgsl`;
- a `{ version: 1, wgsl, functionExports? }` artifact from an older `@vgpu/wgsl` loader, a
  persistent bundler cache, a prebuilt or committed asset, or a third-party package;
- a `ResolvedShader` object from `resolveShader()` or `compile()`.

TypeScript reports these calls, because the parameters are now `ShaderSource` instead of
`string | ShaderSource`. At runtime they throw `VGPU-SHADER-SOURCE-UNPREPARED`,
`VGPU-SHADER-SOURCE-VERSION`, or `VGPU-SHADER-SOURCE-INVALID`. Builds that import `.wgsl` files can
also newly fail on reflection-detectable WGSL errors in leaf files.

### Steps

Although this is a minor release, raw WGSL renderer inputs and v1 artifacts require migration.
Choose the path that matches how your app obtains its shaders:

| Integration or shader source | What you need to change |
| --- | --- |
| Next.js with Turbopack | Use `wgslTurbopackRule()` from `@vgpu/wgsl/next` for the `"*.wgsl"` rule, then rebuild. The helper replaces the hand-written Turbopack rule; it runs in Node configuration, not in the browser. |
| Webpack, including Next.js in webpack mode | Keep `@vgpu/wgsl/loader-webpack` and its existing configuration. Upgrade the packages and rebuild; the same public loader now emits prepared v2 artifacts. |
| Vite | Keep `wgslVitePlugin` from `@vgpu/wgsl/loader-vite` and its existing configuration. Upgrade the packages and rebuild; the plugin now emits prepared v2 artifacts. |
| Prebuilt JavaScript/JSON shader assets, including assets from another package | Regenerate them with the upgraded tooling. Rebuilding the app does not prepare assets that bypass its WGSL loader. |
| WGSL strings generated or loaded at runtime | Call `prepareShader()` once per source revision before passing the result to the renderer. This explicit runtime import includes the parser in that consumer. |

Static `.wgsl` imports do not need a new `prepareShader()` import or a manually configured decoder.
Keep passing the imported shader object to the renderer; the loader prepares it during the build.

1. Upgrade `vgpu` and `@vgpu/wgsl` together. The loader and the runtime must agree on the artifact
   format, so rebuild the app after upgrading. For Turbopack, adopt `wgslTurbopackRule()` as shown
   in the loader cache migration notes; this migration supports keeping the restored cache. If you
   retain an old bare-string Turbopack rule instead, clear that app's `.next/cache` once after
   upgrading. Do not routinely clear webpack or Vite caches: clear the affected bundler cache only
   if stale v1 output persists, or for webpack when replacing a managed installed package in place
   at the same version and resolved loader path.
2. Keep static browser shaders as `.wgsl` imports through `@vgpu/wgsl/loader-vite` or
   `@vgpu/wgsl/loader-webpack`. Pass the imported object unchanged — never its `.wgsl` field.
3. Regenerate every prebuilt, committed, or third-party shader asset with the upgraded tooling.
   When you cannot rebuild an asset at its source, upgrade it once with
   `prepareShader(legacyAsset, assetPath)`; the object form copies its `functionExports`, so
   authored function identity survives.
4. Wrap WGSL you build or load at runtime in `prepareShader()` from `@vgpu/wgsl/prepare`, once per
   source revision and outside `frame(gpu)` / `frameLoop(gpu)` callbacks — every call reparses. For
   `resolveShader()` output, pass the whole result: `prepareShader(resolved, entry)`.
5. Under package managers that do not expose transitive dependencies (pnpm's default isolated
   layout, Yarn PnP), add `@vgpu/wgsl` to your own `package.json` at the version your `vgpu`
   release depends on before importing `@vgpu/wgsl/prepare`.
6. Fix any `VGPU-WGSL-*` reflection error the build now reports in a leaf `.wgsl` file, as you would
   the same error at runtime.

Browser code that imports `@vgpu/wgsl/prepare` bundles the WGSL parser into that consumer. Prefer
`.wgsl` imports or prepared build-time artifacts for static shaders, and reserve runtime preparation
for WGSL that is actually generated at runtime.

#### Before

```ts illustrative
import { draw, effect } from "vgpu";
import { resolveShader } from "@vgpu/wgsl/runtime";

const pulse = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }`);
const scene = draw(gpu, { shader: (await resolveShader({ entry })).wgsl });
const legacy = effect(gpu, legacyAsset); // { version: 1, wgsl, functionExports }
```

#### After

```ts illustrative
import { draw, effect } from "vgpu";
import { prepareShader } from "@vgpu/wgsl/prepare";
import { resolveShader } from "@vgpu/wgsl/runtime";
import postShader from "./post.wgsl"; // prepared by the @vgpu/wgsl loader at build time

const post = effect(gpu, postShader);
const pulse = effect(gpu, prepareShader(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }`));
const scene = draw(gpu, { shader: prepareShader(await resolveShader({ entry }), entry) });
const legacy = effect(gpu, prepareShader(legacyAsset, "shaders/legacy.wgsl"));
```

### Verification

- Run `tsc --noEmit`: no `string` or `ResolvedShader` values reach `draw`, `effect`, or `compute`.
- Run your production build and confirm it succeeds; fix any `VGPU-WGSL-*` reflection errors it
  reports.
- Log `shader.version` and `shader.producer` for one imported `.wgsl` file; they print `2` and
  `"@vgpu/wgsl/prepare-v2"`.
- Test the production build with the cache restored by your deployment provider, then open the
  deployed page and exercise its shaders. A successful build alone does not prove that a cached
  shader is compatible with the renderer.
- Render once and confirm no `VGPU-SHADER-SOURCE-UNPREPARED`, `VGPU-SHADER-SOURCE-VERSION`, or
  `VGPU-SHADER-SOURCE-INVALID` is thrown.
- In a Vite or webpack watch build, remove and restore an imported `.wgsl` dependency and confirm
  the importer rebuilds without restarting the build.
- Keep `npx vgpu check --require-validation <file>` in CI for device validation, which neither the
  loaders nor `prepareShader()` perform.
