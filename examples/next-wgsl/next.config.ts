import { wgslTurbopackRule } from "@vgpu/wgsl/next";
import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: {
    rules: {
      "*.wgsl": wgslTurbopackRule(),
    },
  },
};

export default config;
