import { createRequire } from "node:module";
import type { NextConfig } from "next";
import { wgslLoaderFingerprint } from "../../scripts/lib/wgsl-loader-fingerprint.mjs";

const require = createRequire(import.meta.url);
const wgslLoader = require.resolve("@vgpu/wgsl/loader-webpack");
const wgslLoaderCacheKey = wgslLoaderFingerprint(wgslLoader);

const config: NextConfig = {
  turbopack: {
    rules: {
      "*.wgsl": {
        loaders: [
          {
            loader: wgslLoader,
            options: { vgpuImplementationFingerprint: wgslLoaderCacheKey },
          },
        ],
        as: "*.js",
      },
    },
  },
};

export default config;
