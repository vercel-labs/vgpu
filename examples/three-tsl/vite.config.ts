import { defineConfig } from "vite";
import { wgslVitePlugin } from "vgpu/client";

export default defineConfig({
  plugins: [wgslVitePlugin({ minify: true })],
});
