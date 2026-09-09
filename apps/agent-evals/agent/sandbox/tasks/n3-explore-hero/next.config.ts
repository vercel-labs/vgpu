import type { NextConfig } from "next";

// `.wgsl` files import as `{ version: 1, wgsl: string }` through @vgpu/wgsl's
// loader. Both bundlers are registered: `next build` uses webpack, `next dev`
// uses Turbopack.
const config: NextConfig = {
  turbopack: {
    rules: {
      "*.wgsl": {
        loaders: ["@vgpu/wgsl/loader-webpack"],
        as: "*.js",
      },
    },
  },
  webpack(webpackConfig) {
    webpackConfig.module ??= {};
    webpackConfig.module.rules ??= [];
    webpackConfig.module.rules.push({
      test: /\.wgsl$/,
      loader: "@vgpu/wgsl/loader-webpack",
    });
    return webpackConfig;
  },
};

export default config;
