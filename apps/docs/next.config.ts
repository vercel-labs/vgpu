import { createRequire } from "node:module";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";
// Plain .mjs helper, shared with scripts/check-url-anchor-parity.mjs (which must
// run on bare node, with no TS toolchain), so the gate and the app can never
// disagree about what the redirect table is.
import { loadDocsRedirects } from "./lib/docs-redirects.mjs";
import { homepageLinkHeader } from "./lib/site";

const withMDX = createMDX();
const require = createRequire(import.meta.url);
// TGEIST-07: examples/** import `vgpu` and `@vgpu/*` workspace packages
// straight from source (no build step) and `.wgsl` shader files directly.
const wgslLoader = require.resolve("@vgpu/wgsl/loader-webpack");

const config: NextConfig = {
  // TGEIST-07 begin: examples cluster support (transpile + wgsl loader).
  // Keep this region distinct from `outputFileTracingIncludes` below, which
  // is owned by TGEIST-06 (examples API, Grupo A).
  transpilePackages: [
    "vgpu",
    "@vgpu/core",
    "@vgpu/wgsl",
    "@vgpu/wgsl-std",
    "@vgpu/adapter-mock",
    "@vgpu/adapter-node",
  ],

  turbopack: {
    rules: {
      "*.wgsl": {
        loaders: [wgslLoader],
        as: "*.js",
      },
    },
  },
  // TGEIST-07 end.

  experimental: {
    turbopackFileSystemCacheForDev: true,
  },

  // ANCHOR TGEIST-06 (examples API transplant) -- this key is owned by that ticket alone; copied
  // literally, globs included, from the old app's next.config.mjs.
  // The examples API serves the generated tree straight from the deployment, reading it with fs at
  // request time. Static tracing cannot see a path built at runtime, so these routes must be told
  // to bundle the tree explicitly or every artifact 404s in production.
  // Keys are picomatch globs, not literal route paths, so a dynamic segment cannot be written
  // out: `[revision]` and `[...artifact]` would parse as character classes and match nothing.
  // `check:examples-api-tracing` fails the build if any artifact-backed route loses the tree.
  outputFileTracingIncludes: {
    "/.well-known/vgpu-examples.json": ["./generated/examples-api/**/*"],
    "/api/examples/v1/latest.json": ["./generated/examples-api/**/*"],
    "/api/examples/v1/revisions/**": ["./generated/examples-api/**/*"],
    "/api/mcp": ["./generated/examples-api/**/*"],
  },
  // The artifact reader probes from process.cwd() so it works in both monorepo and deployed
  // layouts. Next's static tracer consequently treats the whole app root as reachable unless the
  // routes exclude unrelated CDN assets. Keep the generated tree above and prevent large models,
  // videos, and images under public/ from being copied into every artifact-backed function.
  outputFileTracingExcludes: {
    "/.well-known/vgpu-examples.json": ["./public/**/*"],
    "/api/examples/v1/latest.json": ["./public/**/*"],
    "/api/examples/v1/revisions/**": ["./public/**/*"],
    "/api/mcp": ["./public/**/*"],
  },

  // ANCHOR TGEIST-12 (gate (d) of Decision 4). The table lives in
  // `lib/docs-redirects.mjs` — see the file header for why each family exists.
  // Short version: 7 live `/docs/guides/concepts-*` URLs that the new tree
  // consolidates under `/docs/concepts/*`, 4 section roots that prod serves and
  // the generated tree has no `index.md` for, and the whole pre-`/docs` URL
  // space (including the manifest-derived `/packages/<pkg>/<Symbol>` deep
  // links) ported from the app this one replaces. `next build` would happily
  // ship without any of them; `scripts/check-url-anchor-parity.mjs` will not.
  async redirects() {
    return loadDocsRedirects();
  },

  async headers() {
    return [
      {
        source: "/",
        headers: [
          {
            key: "Link",
            value: homepageLinkHeader,
          },
        ],
      },
    ];
  },

  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "placehold.co",
      },
    ],
  },
};

export default withMDX(config);
