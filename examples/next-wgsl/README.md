# Next.js Turbopack WGSL example

This minimal App Router app dogfoods `wgslTurbopackRule()` from `@vgpu/wgsl/next` through Next.js Turbopack. The page imports `app/shader.wgsl`, which transitively imports `app/helper.wgsl`, and renders the resolved WGSL text so the build proves the loader path works end-to-end without running WebGPU.

```ts
import type { NextConfig } from "next";
import { wgslTurbopackRule } from "@vgpu/wgsl/next";

const config: NextConfig = {
  turbopack: {
    rules: {
      "*.wgsl": wgslTurbopackRule(),
    },
  },
};

export default config;
```

The app declares `@vgpu/wgsl` directly in its own `package.json` because `next.config.ts` imports `@vgpu/wgsl/next`; a copy installed only through `vgpu` is not importable under pnpm's isolated layout or Yarn PnP. In an app outside this repository, use the `@vgpu/wgsl` release your `vgpu` version depends on.

`wgslTurbopackRule()` runs in Node while Next loads the config. It returns the absolute loader path from the same `@vgpu/wgsl` installation, the required `as: "*.js"`, and a content hash of the installed compiler files, so supported Next 16 restored caches rebuild shader output after the compiler changes. Insert the rule unchanged, and pass `{ minify: ... }` to the helper rather than editing the rule. Restart `next dev` after rebuilding or upgrading `@vgpu/wgsl`.

Requires Next.js 15.5 or newer for the top-level `turbopack` config key used here. Legacy Next 15.0 through 15.2 projects used `experimental.turbo.rules`, which is deprecated in newer Next versions. This example uses Next 15.5, where Turbopack runs under `next dev --turbopack` and `next build --turbopack`. Stable Next 15.5 cannot enable Turbopack's persistent cache — Next 15.5.25 rejects `experimental.turbopackPersistentCaching: true` with `CanaryOnlyError` — so this example demonstrates the build, TypeScript config types, and dev reloads, not restored-cache reuse. Restored-cache protection applies to Next 16 (checked against 16.3.3).

In Turbopack, the loader registers each imported `.wgsl` file and its own compiler files through `this.addDependency()`. Editing `app/helper.wgsl` while `next dev --turbopack` runs updates the page without a restart; CI checks this with a dev HMR smoke on this example. Next's webpack mode ignores `turbopack.rules`; it needs a `webpack()` hook with `@vgpu/wgsl/loader-webpack`, as shown in the vgpu Next.js guide (`npx vgpu docs cat nextjs.md`).
