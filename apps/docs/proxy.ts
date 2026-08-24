import { createProxy } from "@vercel/geistdocs/proxy";
import { config as geistdocsConfig } from "@/lib/geistdocs/config";
import { trackMdRequest } from "@/lib/geistdocs/md-tracking";

const proxy = createProxy({
  config: geistdocsConfig,
  trackMarkdownRequest: trackMdRequest,
  before: () => null,
  // Keep negotiation deliberately narrow. `/` is the homepage representation;
  // docs retain their explicit catch-all. No root wildcard is allowed to capture
  // `/examples`, `/api`, or future application routes.
  markdownRoutes: [
    { from: "/", to: "/[lang]/index.md" },
    { from: "/docs/*path", to: "/[lang]/llms.mdx/*path" },
  ],
});

// ANCHOR TGEIST-06 (examples API transplant): `.well-known/vgpu-examples.json` is excluded from the
// proxy. It is the examples API discovery endpoint that published vgpu CLIs already request by
// absolute path, so it must resolve to app/.well-known/vgpu-examples.json/route.ts exactly as it
// does on the old app -- while the proxy is active on it, the i18n rewrite sends it to a localized
// path that has no route and it answers 404 (verified against this scaffold: 404 text/html before
// this entry, 200 application/json with the old app's exact bytes after). The exclusion is
// deliberately the single literal path and NOT all of `.well-known/`: `.well-known/mcp.json` is a
// localized geistdocs route under app/[lang]/, so excluding the whole directory would widen this
// ticket into that route's behaviour for no reason.
// ANCHOR TGEIST-08 (previews verbatim): `/preview/**` is excluded from the proxy, for the same
// reason and with the same evidence as the TGEIST-06 entry above. `app/preview/[slug]` is a
// non-localized route (transplanted byte-for-byte from apps/docs, where there is no i18n at all),
// so while the proxy is active on it the i18n rewrite sends `/preview/gradient` to
// `/en/preview/gradient`, which no route matches. Verified empirically against `next start` on this
// build: 404 with `x-middleware-rewrite: /en/preview/gradient` before this entry, 200 with the
// prerendered canvas after it. These URLs are the render targets of `render-example-thumbs.mjs`
// (`thumbs:check` / `render:proof`, gate G6) and of the gallery iframes, so they must keep
// resolving at exactly the path the old app serves -- a localized variant would change the URL
// contract those PNG baselines were captured against.
// The pattern is `preview/` and NOT `preview(?:/|$)` on purpose: there is no page at bare
// `/preview`, so excluding it from the proxy left it to the global not-found, which resolves inside
// `app/[lang]/` without a `lang` param and threw (500 instead of the old app's 404). Requiring the
// slash keeps the bare path on the proxy, where geistdocs answers its normal localized 404, and
// still cannot over-match a sibling like `/previewfoo`. Verified on this build: `/preview` 404,
// `/preview/gradient` 200, `/previewfoo` proxied.
// TGEIST-ML-ASSETS: `/models/**` and `/ort/**` are excluded from the proxy, for the same reason and
// with the same evidence as the TGEIST-06 and TGEIST-08 entries above. Both are same-origin static
// binaries the examples fetch by absolute path -- the committed `public/models/mnist/**` and
// `public/models/mediapipe-hands/**` ONNX graphs, and `public/models/depth/**` /
// `public/ort/**`, which `prepare-depth-models.mjs` / `prepare-ort-assets.mjs` stage from a pinned
// source and are gitignored on purpose (never committed). Neither directory has a route under
// `app/[lang]/`, so while the proxy is active on them the i18n rewrite sends e.g.
// `/models/mnist/mnist-12.onnx` to `/en/models/mnist/mnist-12.onnx`, which no route matches.
// Verified empirically against `next start` on this build: 404 with
// `x-middleware-rewrite: /en/models/mnist/mnist-12.onnx` before this entry, 200 with the old app's
// exact bytes after it -- and the same for `/ort/manifest.json`. Without this, `mnist-classifier` and
// `depth-estimation` fail to load their model (`OrtEnvironmentError`) and `air-painting` would fail
// the same way the moment it starts fetching its own models. The pattern is `models/` and `ort/`
// (not anchored to specific sub-paths) because every sub-path under either directory is a static
// asset with no localized counterpart, so there is nothing under those prefixes for the proxy to
// legitimately handle.
// ANCHOR TGEIST-EXAMPLES-STATIC (5th instance of this exact class -- TGEIST-06, TGEIST-08 and
// TGEIST-ML-ASSETS above are the first three): every media file committed under
// `public/examples/**` -- the gallery/sidebar thumbnails (`public/examples/<slug>.card.png`,
// `<slug>.hero.png`), videos, meshes, and `public/examples/depth-estimation/source.jpg` (the default input image
// `example-canvas` fetches for that demo) -- is excluded from the proxy. None of them has a route
// under `app/[lang]/`, so while the proxy is active on them the i18n rewrite sends e.g.
// `/examples/depth-estimation/source.jpg` to `/en/examples/depth-estimation/source.jpg`, which no
// route matches. Verified empirically against `next start` on this build: 404 with
// `x-middleware-rewrite: /en/examples/depth-estimation/source.jpg` before this entry, 200 with the
// old app's exact bytes after it -- and the same for every `*.card.png` / `*.hero.png`.
// The pattern is an extension match, NOT an `examples/` prefix like the `models/`/`ort/` entry
// above, on purpose: unlike those two, `examples/` is also a live, localized page route --
// `app/[lang]/examples/[slug]/page.tsx` -- and a bare prefix would swallow `/examples/<slug>`
// itself (no dot in any slug) into this exclusion, taking the example detail pages out of i18n
// entirely. Anchoring the extension list to the end of the path keeps it from matching a page path
// that merely starts with `examples/`. Verified on this build: `/examples/depth-estimation` (the
// page) still 200 via `x-middleware-rewrite: /en/examples/depth-estimation`, while every asset
// above is now unproxied. `check:example-static-asset-smoke` (sibling of `check:ml-asset-smoke`)
// pins this for every file actually committed under `public/examples/**`, the same way
// `check:ml-asset-smoke` pins `models/`/`ort/`, so this class of bug fails CI instead of shipping
// silently a fifth time.
// HERO-ASSETS: `/hero/**` contains the non-localized mesh and cubemap fetched by the homepage
// WebGPU renderer. There is no localized page route under this prefix, so keep these binaries out
// of the geistdocs rewrite just like `/models/**` and `/ort/**` above.
export const config = {
  matcher: [
    "/((?!api(?:/|$)|openapi.json$|opengraph-image(?:/|$)|\\.well-known/api-catalog(?:/|$)|.well-known/vgpu-examples.json(?:/|$)|preview/|models/|ort/|hero/|examples/.+\\.(?:png|jpe?g|webp|avif|gif|svg|ico|mp4|webm|mesh)$|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};

export default proxy;
