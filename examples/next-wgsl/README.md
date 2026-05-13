# Next.js Turbopack WGSL example

This minimal App Router app dogfoods `@vgpu/wgsl/loader-webpack` through Next.js Turbopack. The page imports `app/shader.wgsl`, which transitively imports `app/helper.wgsl`, and renders the resolved WGSL text so the build proves the loader path works end-to-end without running WebGPU.

```ts
import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: {
    rules: {
      "*.wgsl": {
        loaders: ["@vgpu/wgsl/loader-webpack"],
        as: "*.js",
      },
    },
  },
};

export default config;
```

Requires Next.js 15.5 or newer for the top-level `turbopack` config key used here. Legacy Next 15.0 through 15.2 projects used `experimental.turbo.rules`, which is deprecated in newer Next versions.

Turbopack runs webpack-compatible loaders through a bridge, not through a native public plugin API. The bridge supports a subset of the webpack loader API such as `getOptions`, `getResolve`, `emitWarning`, `emitError`, and `importModule`; `this.addDependency()` is not honored for Turbopack invalidation. Transitive `.wgsl` updates are tracked through Turbopack's patched async `fs.readFile` interception, which `@vgpu/wgsl` uses as of PR3a. The `as: "*.js"` rule field is required so Turbopack treats the loader output as JavaScript. `next build --turbopack` is stable enough for this smoke in Next 15.5+, but still worth validating for production apps.
