---
title: Using vgpu with Next.js and other bundlers
summary: Add `wgslTurbopackRule()` to Next.js Turbopack or the WGSL loader to webpack and Vite, type `.wgsl` imports for TypeScript, and render a shader from a client component with a canvas.
keywords: nextjs, next.js, next config, next.config.ts, app router, webpack, webpack loader, turbopack, turbopack rule, wgslTurbopackRule, @vgpu/wgsl/next, vite, bundler, loader, wgsl loader, wgsl import, import wgsl, .wgsl, persistent cache, .next/cache, build cache, stale shader, cache invalidation, upgrade, typescript wgsl, wgsl types, declare module, d.ts, ambient declaration, client component, canvas, react
---

# Using vgpu with Next.js and other bundlers

`effect(gpu, source)`, `draw(gpu, { shader })`, and `compute(gpu, source)` take a prepared `ShaderSource`: the final WGSL plus the reflection the renderer reads instead of parsing WGSL in the browser. The loader is the default way to get one. It prepares every `.wgsl` import at build time — resolving any `import` graph first — so the browser bundle carries prepared data, not the WGSL parser. Without a bundler, see [Use vgpu without a bundler](/guides/no-bundler); for WGSL you generate at runtime, call `prepareShader()` from `@vgpu/wgsl/prepare`.

This guide is the bundler half of [Getting started](getting-started.docs.md): install, loader config, TypeScript types for `.wgsl` imports, and the client component that owns the canvas.

New to shader imports? Read [WGSL modules](/concepts/wgsl-modules) first for the `import`/`export` syntax, pure-module rule, and what vgpu emits. This page focuses on wiring that model into a bundler.

## Install

```sh
npm install vgpu @vgpu/wgsl
```

Install `@vgpu/wgsl` at the release your `vgpu` version depends on (`npm ls @vgpu/wgsl` shows it), in the package that owns `next.config.ts`, `vite.config.ts`, or your webpack config. The bundler configs on this page and the `wgsl-types` reference below import or resolve `@vgpu/wgsl/*` subpaths from your app, and pnpm's isolated `node_modules` and Yarn PnP do not expose the copy that `vgpu` installs transitively. It is build tooling: `devDependencies` works when your build environment installs dev dependencies; otherwise use `dependencies`.

WGSL package imports are different. `@vgpu/wgsl-std` (the pure-WGSL standard modules) is a dependency of `vgpu`, so `import { voronoi3d } from "@vgpu/wgsl-std/noise";` inside a `.wgsl` file resolves with no extra install step — under npm, pnpm, and Yarn alike, including pnpm's isolated `node_modules` and Yarn PnP.

A WGSL package import resolves from your project's own `node_modules` first, so a copy you installed yourself always wins, and then next to `@vgpu/wgsl` itself, which is what makes a transitive install of `@vgpu/wgsl-std` work. `VGPU-WGSL-PKG-NOTFOUND` therefore means the package is reachable from neither — install it (`npm install <pkg>`) and check the specifier spelling. Third-party and workspace packages work the same way, including `import { customNoise } from "@packages/shaders";` for a `workspace:*` package in a monorepo: see [Publishing WGSL module packages](publishing-wgsl-packages.docs.md) for the full resolution order and the `exports` map a package needs.

## Next.js with Turbopack

Next 16 uses Turbopack for `next dev` and `next build` by default; on Next 15.5, pass `--turbopack` to either command. Add the rule that [`wgslTurbopackRule()`](/reference/wgsl/next) returns as the `"*.wgsl"` entry of the top-level `turbopack.rules`:

```ts
// next.config.ts
import { wgslTurbopackRule } from "@vgpu/wgsl/next";

const nextConfig = {
  turbopack: {
    rules: {
      "*.wgsl": wgslTurbopackRule(),
    },
  },
};

export default nextConfig;
```

`wgslTurbopackRule()` runs in Node while Next loads the config. It returns a complete rule — the absolute path of the loader from the same `@vgpu/wgsl` installation, `as: "*.js"` so Turbopack treats the output as JavaScript, and a hash of the installed compiler files that keeps restored caches correct (see [Persistent caches and upgrades](#persistent-caches-and-upgrades)). Insert it unchanged; do not edit its `loaders` or `options`.

Pass minification to the helper. `true` strips whitespace and safely shortens identifiers; `{ whitespace: true }` strips whitespace only:

```ts
// next.config.ts
import { wgslTurbopackRule } from "@vgpu/wgsl/next";

const nextConfig = {
  turbopack: {
    rules: {
      "*.wgsl": wgslTurbopackRule({ minify: true }),
    },
  },
};

export default nextConfig;
```

The helper owns one rule, not your config. Spread the levels you extend so existing rules, settings, and plugin wrappers such as `withMDX(nextConfig)` stay as they are:

```ts
// next.config.ts
import { wgslTurbopackRule } from "@vgpu/wgsl/next";

const existingConfig = {
  reactStrictMode: true,
  turbopack: {
    rules: {
      "*.svg": {
        loaders: [{ loader: "@svgr/webpack", options: { icon: true } }],
        as: "*.js",
      },
    },
  },
};

const nextConfig = {
  ...existingConfig,
  turbopack: {
    ...existingConfig.turbopack,
    rules: {
      ...existingConfig.turbopack.rules,
      "*.wgsl": wgslTurbopackRule({ minify: true }), // the only new entry
    },
  },
};

export default nextConfig;
```

For a phase-based or async config, call `wgslTurbopackRule()` inside the function you export. Invalid options fail while the config loads: `VGPU-WGSL-NEXT-OPTIONS` names an unknown or mistyped field, and `VGPU-WGSL-MINIFY-IDENTIFIERS` rejects an identifier mode other than `"none"` or `"safe"`.

Requires Next.js 15.5 or newer for the top-level `turbopack` key. Next 15.0–15.2 used `experimental.turbo.rules`, deprecated since. Turbopack runs webpack-compatible loaders through a bridge. On Next 16.3.3, that bridge records files passed to `this.addDependency()`, which is how the loader registers each imported `.wgsl` file — so editing an imported module invalidates its importer — and its own compiler files. The bridge does not implement `this.addBuildDependency()`, and it does not track files a loader merely reads without registering them.

The helper shape is exercised end to end by `examples/next-wgsl` in the vgpu repository.

> Good to know: Next types the rule for you. In a project with Next installed, annotate the config with `NextConfig` (`import type { NextConfig } from "next";`); the returned rule fits the `turbopack.rules` type of both Next 15.5 and Next 16. `@vgpu/wgsl` itself has no dependency on `next`.

## Next.js with webpack

Next 16 uses webpack under `next dev --webpack` / `next build --webpack`; Next 15.5 uses it whenever you omit `--turbopack`. `wgslTurbopackRule()` does not apply here — webpack mode ignores `turbopack.rules`. Push the raw loader from the `webpack` hook for `test: /\.wgsl$/`:

```ts
// next.config.ts
type WebpackConfig = { module?: { rules?: unknown[] } };

const nextConfig = {
  webpack(config: WebpackConfig) {
    config.module ??= {};
    config.module.rules ??= [];
    config.module.rules.push({
      test: /\.wgsl$/,
      loader: "@vgpu/wgsl/loader-webpack",
    });
    return config;
  },
};

export default nextConfig;
```

Keep both blocks when your app runs webpack in one command and Turbopack in another: Next reads `turbopack` only in Turbopack mode and calls `webpack()` only in webpack mode, so the `"*.wgsl"` rule and the hook coexist in one config. In a project that has Next's own types available, annotate with `NextConfig` (`import type { NextConfig } from "next";`) instead of the local `WebpackConfig` alias; the alias above only exists so this snippet compiles on its own.

Add `options: { minify: true }` to the rule for production builds. The loader registers its own compiler files with `this.addBuildDependency()` on every run, so webpack's persistent cache records them as build dependencies of each shader module. Full option reference: `npx vgpu docs cat /@vgpu/wgsl/loader-webpack/index.docs.md`.

## Persistent caches and upgrades

Turbopack and webpack can restore loader output from a persistent cache — `.next/cache` in Next.js, often kept between CI or deployment builds. A cache hit skips the loader entirely, so after you upgrade `@vgpu/wgsl` the cache, not the new loader, decides whether a shader is rebuilt. Old `version: 1` output served from a cache throws `VGPU-SHADER-SOURCE-UNPREPARED` in the renderer.

`wgslTurbopackRule()` handles this before Turbopack looks anything up. Each config evaluation hashes the installed compiler files — `package.json`, the shipped metadata anchor, and every published `dist` JavaScript file — into the rule's options. A changed or rebuilt compiler changes the rule, so Turbopack rebuilds every `.wgsl` module and keeps the rest of the cache; an unchanged installation produces the same rule, so warm builds keep reusing their cached output. Restart `next dev` after upgrading: the identity is computed when Next loads the config, and a running server keeps the compiler it already loaded.

The retained-cache matrix passes on Next 16.3.3. An authentic 0.5.0 build using unchanged `require.resolve("@vgpu/wgsl/loader-webpack")` rebuilt exact v2 because the public resolved target changed. The bare-string rule below stayed on v1, then switching that rule to the helper rebuilt exact v2 with the same cache retained. Stable Next 15.5 cannot enable Turbopack's persistent cache — Next 15.5.25 rejects `experimental.turbopackPersistentCaching: true` with `CanaryOnlyError` when it loads the config — while production builds, config types, and dev edit/delete/recreate recovery pass there.

> Warning: Upgrading from `@vgpu/wgsl` 0.5.0 with the bare-string rule `loaders: ["@vgpu/wgsl/loader-webpack"]` is not protected. Turbopack keys that rule by its unchanged string, so a cache restored from a 0.5.0 build can keep serving `version: 1` output. Replace the rule with `wgslTurbopackRule()` — the changed rule rebuilds every shader and you keep the cache — or, if you keep a hand-written rule, delete that app's `.next/cache` once after upgrading. Do not disable caching to work around it.

Webpack has a different boundary. Its default filesystem cache treats installed packages under managed `node_modules` as immutable while their package `name@version` is unchanged. The authentic 0.5.0 `require.resolve()` upgrade rebuilt exact v2 with its cache retained because the public resolved target changed, and a separate disposable bare-rule replay rebuilt after the candidate manifest version changed. A bare same-version replacement stayed on v1 even though the new loader registers its compiler files; `addBuildDependency()` does not override the managed-package snapshot. Same-version edits to a workspace symlink did rebuild and recover.

Do not clear webpack's cache for every upgrade. Keep normal package versions and rebuild first. Clear that cache once only when you replace a managed installed package in place without changing its version or resolved loader path, or when verification still shows stale v1 output.

Prebuilt shader assets are outside both mechanisms. JavaScript or JSON shader artifacts that a package or build step generated earlier are imported as ordinary modules, never run through the loader, so regenerate them with matching `@vgpu/wgsl` tooling instead.

To confirm a rebuild, log one imported shader's `version` and `producer`: they print `2` and `"@vgpu/wgsl/prepare-v2"`.

## Vite

```ts
// vite.config.ts — wrap in defineConfig() from "vite" if you want its typing
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";

export default { plugins: [wgslVitePlugin()] };
```

## Type `.wgsl` imports in TypeScript

TypeScript does not know what a `.wgsl` module is, so `import shader from "./plasma.wgsl"` fails with `TS2307: Cannot find module` until you add an ambient declaration. `@vgpu/wgsl` ships one — reference it from a `.d.ts` file anywhere in your project (`src/wgsl-env.d.ts` is a good spot):

```text
// src/wgsl-env.d.ts
/// <reference types="@vgpu/wgsl/wgsl-types" />
```

Prefer that one-liner: it stays correct if the emitted shape ever changes. If you would rather declare the module yourself — for example to reuse the exported `ShaderSource` type — put this in `src/wgsl-env.d.ts` instead. It must be the first statement in the file: a `declare module` that follows other code is read as a module augmentation and fails with `TS2664`.

```ts
declare module "*.wgsl" {
  import type { ShaderSource } from "@vgpu/wgsl";
  const source: ShaderSource;
  export default source;
}
```

Either way the default export is a prepared `ShaderSource` object (`{ version: 2, wgsl, reflection, sourceChecksum, producer, functionExports }`), **not** a plain string. Pass it straight to `effect(gpu, source)` or `draw(gpu, { shader: source })` — do not reach into `.wgsl` yourself: a string throws `VGPU-SHADER-SOURCE-UNPREPARED`. Loader artifacts always include `functionExports`, even when the array is empty; integrations such as `vgpu/three` use that metadata to preserve authored function identity through identifier minification. The emitted module never imports the parser. When the bounded compact-emission estimate selects packing, it uses a small parser-free decoder; Vite and webpack can also share independently reachable encoded metadata modules, while Turbopack keeps the encoded table in the shader module and resolves the decoder relative to the loader's own installed package. Final bundler chunking and compression can change the result, so this estimates savings rather than guaranteeing a smaller compressed bundle. Compact and literal forms evaluate to the same full plain object. The decoder and generated metadata assets are private implementation details, not author APIs, and the setup above needs no extra rule or dependency.

> Warning: Keep the `@vgpu/wgsl` loader and the `vgpu` runtime on matching releases. An artifact from a different format version throws `VGPU-SHADER-SOURCE-VERSION`, and older `version: 1` output throws `VGPU-SHADER-SOURCE-UNPREPARED` — rebuild the app and regenerate prebuilt shader assets after upgrading either package.

## Render it from a client component

WebGPU is browser-only, so the canvas lives in a `"use client"` component and `init()` runs in an effect after mount. Keep the vgpu work in a plain function: it is easier to read, and it is the part worth testing.

```ts
// src/app/plasma.ts
import { clock, effect, frameLoop, init, surface } from "vgpu";
import type { FrameLoopHandle } from "vgpu";
import plasmaShader from "./plasma.wgsl";

/** Starts the render loop on `canvas`; call the returned function to tear it down. */
export function startPlasma(canvas: HTMLCanvasElement): () => void {
  let disposed = false;
  let loop: FrameLoopHandle | undefined;
  let gpu: Awaited<ReturnType<typeof init>> | undefined;

  void (async () => {
    gpu = await init();
    if (disposed) return gpu.dispose();

    const canvasSurface = surface(gpu, canvas, { dpr: [1, 2] });
    const plasma = effect(gpu, plasmaShader, {
      label: "plasma",
      set: { params: { time: 0, texel: canvasSurface.texelSize } },
    });
    canvasSurface.onResize(() => plasma.set({ params: { texel: canvasSurface.texelSize } }));

    const time = clock(gpu);
    loop = frameLoop(gpu, (frame) => {
      plasma.set({ params: { time: time.time } });
      frame.pass(canvasSurface, plasma);
    });
  })();

  return () => {
    disposed = true;
    loop?.stop();
    gpu?.dispose();
  };
}
```

```tsx
// src/app/page.tsx
"use client";

import { useEffect, useRef } from "react";
import { startPlasma } from "./plasma";

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return startPlasma(canvas);
  }, []);

  return (
    <main style={{ margin: 0, height: "100vh", overflow: "hidden" }}>
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
    </main>
  );
}
```

The cleanup function matters in development: React's strict mode mounts effects twice, and without `stop()` plus `dispose()` you leak a device and a render loop per remount.

## Validate before you run the app

**`next build`/`next dev` reflect every `.wgsl` import but never validate it against a WebGPU
device — neither the webpack loader nor the Turbopack path.** The loader/plugin parse and reflect
each module to prepare it: import graphs go through `resolveShader({ validate: false })` (parsing,
purity checks, DCE, mangling, and minification run, but the device-backed check does not), and
leaf files without imports are reflected directly. Parse errors and reflection-detectable layout
errors — for example a `bool` in a uniform struct (`VGPU-WGSL-REFLECT-BOOL-HOST-SHAREABLE`) — fail
the build, including in leaf files that used to ship without reflection. Errors only the native
WGSL compiler or the device detects still pass: there is no
loader/plugin option to opt into device validation, so `next build --webpack` and `next build`
(Turbopack) exit `0` and ship that WGSL. Do not use `next dev`/`next build` as your shader compiler.

The validation gate is `vgpu check --require-validation`, run in CI or as a pre-commit hook. Check
every `.wgsl` file — including pure helper modules — with the CLI, which resolves the same import
graph the loader does, prints the reflection, and actually validates against a WebGPU device:

```sh
npx vgpu check src/app/plasma.wgsl --require-validation
```

Then prove the pixels in Node instead of squinting at a browser tab: [Getting started](getting-started.docs.md) shows the headless render-and-read-pixels loop, and [The default workflow for developing shaders with vgpu](shader-workflow.docs.md) is the full playbook.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `TS2307: Cannot find module './x.wgsl'` | No ambient declaration for `.wgsl` | Add the `wgsl-env.d.ts` above |
| `VGPU-WGSL-PKG-NOTFOUND: Package <pkg> was not found` | A WGSL package import is not installed in `node_modules` | `npm install <pkg>`, or fix the specifier |
| `VGPU-WGSL-RUNTIME-IMPORT` | The bundler ran the loader synchronously while the WGSL file has top-level imports or a direct `export fn` | Let the loader use async mode (webpack/Turbopack/Vite all do by default) |
| `VGPU-RESOLVE-MODULE-BINDING` | An imported `.wgsl` module declares `@group`/`@binding` | Keep resources in the entry shader; modules export only structs and functions |
| `Cannot find module '@vgpu/wgsl/next'` (or `ERR_MODULE_NOT_FOUND`) when Next loads the config | `@vgpu/wgsl` is installed only transitively through `vgpu` | Add `@vgpu/wgsl` to the app's own `package.json` at the release your `vgpu` depends on |
| `VGPU-WGSL-NEXT-OPTIONS` or `VGPU-WGSL-MINIFY-IDENTIFIERS` when Next loads the config | `wgslTurbopackRule()` received an unknown or mistyped option | Pass only `{ minify?: boolean \| { whitespace?: boolean; identifiers?: "none" \| "safe" } }` |
| `VGPU-WGSL-CACHE-IDENTITY` | The installed `@vgpu/wgsl` is missing, unbuilt, or inconsistent, so its compiler files cannot be listed | Reinstall the matching `@vgpu/wgsl` release; in a workspace, build `@vgpu/wgsl` before running Next. The error's `metadata.path` names the file |
| `CanaryOnlyError` for `experimental.turbopackPersistentCaching` | Stable Next 15.5 does not support Turbopack persistent caching | Remove the flag on Next 15.5, or use Next 16 for restored Turbopack caches |
| `VGPU-SHADER-SOURCE-UNPREPARED` right after upgrading `@vgpu/wgsl`, with a restored cache | The cache still serves `version: 1` loader output from 0.5.0 | For Turbopack, switch the bare rule to `wgslTurbopackRule()` or delete that app's `.next/cache` once. For webpack, clear only after confirming the upgrade kept the same managed package version and resolved loader path, or the rebuilt artifact is still v1 — see [Persistent caches and upgrades](#persistent-caches-and-upgrades) |
| `VGPU-SHADER-SOURCE-UNPREPARED` | Passing a raw string — often `source.wgsl` instead of the imported object — or a `version: 1` artifact from an older loader or prebuilt asset | Pass the imported object to `effect(gpu, source)`; rebuild with the current loader and regenerate prebuilt assets, or wrap runtime WGSL in `prepareShader()` |
| `VGPU-SHADER-SOURCE-VERSION` | The loader or a prebuilt asset comes from a `@vgpu/wgsl` release with a different artifact format than your `vgpu` | Align the two package versions and rebuild |
| `VGPU-WGSL-PACKED-METADATA-INVALID` during the build or when a shader module loads | Loader-generated shader metadata is malformed or came from incompatible `@vgpu/wgsl` loader assets | Rebuild the affected bundle with compatible `@vgpu/wgsl` loader assets, and never import or edit generated metadata requests yourself |
| Build fails with a `VGPU-WGSL-*` reflection error in a leaf `.wgsl` | The loader now reflects every module at build time | Fix the WGSL the diagnostic reports, as you would for a runtime error |
| Shader creates but nothing draws | No `frame.pass`, or the pass targets something that is never presented | Render inside `frame`/`frameLoop` with the surface as the pass target |

## See also

- [Use WGSL modules in three.js TSL](/guides/threejs) — connect loader-resolved pure WGSL functions to Three TSL node materials with `vgpu/three`
- `npx vgpu docs cat /@vgpu/wgsl/next/index.docs.md` — `wgslTurbopackRule()` options, returned rule, and errors
- `npx vgpu docs cat /@vgpu/wgsl/loader-webpack/index.docs.md` — every loader option
- `npx vgpu docs cat /@vgpu/wgsl/loader-vite/index.docs.md` — the Vite plugin
- `npx vgpu docs cat /@vgpu/wgsl/runtime/resolve-shader.docs.md` — resolving import graphs without a bundler
- `npx vgpu docs cat /@vgpu/wgsl-std/noise/index.docs.md` — WGSL modules you can import by package name
- [Publishing WGSL module packages](publishing-wgsl-packages.docs.md) — ship your own `.wgsl` modules as a package, or share them across a monorepo
- [Shipping to production](shipping-to-production.docs.md) — the pre-PR checklist: correctness gates, measurements, free performance defaults, and cheaper alternatives to propose
