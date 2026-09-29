---
title: Using vgpu with Next.js and other bundlers
summary: Wire the WGSL loader into Next.js (Turbopack or webpack) or Vite, type `.wgsl` imports for TypeScript, and render a shader from a client component with a canvas.
keywords: nextjs, next.js, next config, next.config.ts, app router, webpack, webpack loader, turbopack, vite, bundler, loader, wgsl loader, wgsl import, import wgsl, .wgsl, typescript wgsl, wgsl types, declare module, d.ts, ambient declaration, client component, canvas, react
---

# Using vgpu with Next.js and other bundlers

`effect(gpu, source)`, `draw(gpu, { shader })`, and `compute(gpu, source)` take a prepared `ShaderSource`: the final WGSL plus the reflection the renderer reads instead of parsing WGSL in the browser. The loader is the default way to get one. It prepares every `.wgsl` import at build time — resolving any `import` graph first — so the browser bundle carries data, not the WGSL parser. Without a bundler, see [Use vgpu without a bundler](/guides/no-bundler); for WGSL you generate at runtime, call `prepareShader()` from `@vgpu/wgsl/prepare`.

This guide is the bundler half of [Getting started](getting-started.docs.md): install, loader config, TypeScript types for `.wgsl` imports, and the client component that owns the canvas.

New to shader imports? Read [WGSL modules](/concepts/wgsl-modules) first for the `import`/`export` syntax, pure-module rule, and what vgpu emits. This page focuses on wiring that model into a bundler.

## Install

```sh
npm install vgpu
```

That is the whole install. `@vgpu/wgsl` (the loaders) and `@vgpu/wgsl-std` (the pure-WGSL standard modules) are dependencies of `vgpu`, so WGSL package imports such as `import { voronoi3d } from "@vgpu/wgsl-std/noise";` resolve with no second install step — under npm, pnpm, and Yarn alike, including pnpm's isolated `node_modules` and Yarn PnP, where transitive packages never appear in your project's `node_modules` tree.

A WGSL package import resolves from your project's own `node_modules` first, so a copy you installed yourself always wins, and then next to `@vgpu/wgsl` itself, which is what makes a transitive install of `@vgpu/wgsl-std` work. `VGPU-WGSL-PKG-NOTFOUND` therefore means the package is reachable from neither — install it (`npm install <pkg>`) and check the specifier spelling. Third-party and workspace packages work the same way, including `import { customNoise } from "@packages/shaders";` for a `workspace:*` package in a monorepo: see [Publishing WGSL module packages](publishing-wgsl-packages.docs.md) for the full resolution order and the `exports` map a package needs.

## Next.js with Turbopack

Turbopack is the default dev bundler in current Next.js versions. Register the loader with a top-level `turbopack.rules` entry; `as: "*.js"` is required so Turbopack treats the loader output as a JavaScript module:

```ts
// next.config.ts
const nextConfig = {
  turbopack: {
    rules: {
      "*.wgsl": {
        loaders: ["@vgpu/wgsl/loader-webpack"],
        as: "*.js",
      },
    },
  },
};

export default nextConfig;
```

Requires Next.js 15.5 or newer for the top-level `turbopack` key. Next 15.0–15.2 used `experimental.turbo.rules`, deprecated since. Turbopack runs webpack-compatible loaders through a bridge: `this.addDependency()` is not honored there, but `@vgpu/wgsl` also tracks transitive `.wgsl` reads through Turbopack's patched `fs.readFile`, so editing an imported module still invalidates.

The same shape is exercised end to end by `examples/next-wgsl` in the vgpu repository.

## Next.js with webpack

`next dev` / `next build` without `--turbopack` use webpack. Push a rule from the `webpack` hook — the loader registers itself for `test: /\.wgsl$/`:

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

Keep both blocks when your app runs webpack in one command and Turbopack in another: Next reads `turbopack` only under `--turbopack` and calls `webpack()` only without it, so the two configurations coexist. In a project that has Next's own types available, annotate with `NextConfig` (`import type { NextConfig } from "next";`) instead of the local `WebpackConfig` alias; the alias above only exists so this snippet compiles on its own.

Add `options: { minify: true }` to the rule for production builds. Full option reference: `npx vgpu docs cat /@vgpu/wgsl/loader-webpack/index.docs.md`.

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

Either way the default export is a prepared `ShaderSource` object (`{ version: 2, wgsl, reflection, sourceChecksum, producer, functionExports }`), **not** a plain string. Pass it straight to `effect(gpu, source)` or `draw(gpu, { shader: source })` — do not reach into `.wgsl` yourself: a string throws `VGPU-SHADER-SOURCE-UNPREPARED`. Loader artifacts always include `functionExports`, even when the array is empty; integrations such as `vgpu/three` use that metadata to preserve authored function identity through identifier minification. The emitted module is plain data and imports nothing from the parser.

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
| `VGPU-SHADER-SOURCE-UNPREPARED` | Passing a raw string — often `source.wgsl` instead of the imported object — or a `version: 1` artifact from an older loader | Pass the imported object to `effect(gpu, source)`; rebuild with the current loader, or wrap runtime WGSL in `prepareShader()` |
| `VGPU-SHADER-SOURCE-VERSION` | The loader or a prebuilt asset comes from a `@vgpu/wgsl` release with a different artifact format than your `vgpu` | Align the two package versions and rebuild |
| Build fails with a `VGPU-WGSL-*` reflection error in a leaf `.wgsl` | The loader now reflects every module at build time | Fix the WGSL the diagnostic reports, as you would for a runtime error |
| Shader creates but nothing draws | No `frame.pass`, or the pass targets something that is never presented | Render inside `frame`/`frameLoop` with the surface as the pass target |

## See also

- [Use WGSL modules in three.js TSL](/guides/threejs) — connect loader-resolved pure WGSL functions to Three TSL node materials with `vgpu/three`
- `npx vgpu docs cat /@vgpu/wgsl/loader-webpack/index.docs.md` — every loader option
- `npx vgpu docs cat /@vgpu/wgsl/loader-vite/index.docs.md` — the Vite plugin
- `npx vgpu docs cat /@vgpu/wgsl/runtime/resolve-shader.docs.md` — resolving import graphs without a bundler
- `npx vgpu docs cat /@vgpu/wgsl-std/noise/index.docs.md` — WGSL modules you can import by package name
- [Publishing WGSL module packages](publishing-wgsl-packages.docs.md) — ship your own `.wgsl` modules as a package, or share them across a monorepo
- [Shipping to production](shipping-to-production.docs.md) — the pre-PR checklist: correctness gates, measurements, free performance defaults, and cheaper alternatives to propose
