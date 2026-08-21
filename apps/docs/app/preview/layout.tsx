import type { Metadata } from "next";
import "../global.css";
import { mono, sans } from "@/lib/geistdocs/fonts";
import { cn } from "@/lib/utils";
import { SITE_ORIGIN } from "@/lib/site";

/*
 * ANCHOR TGEIST-08 (previews verbatim, headless render targets).
 *
 * This is the ONLY file this ticket adds around `/preview/[slug]`, and it is deliberately NOT the
 * geistdocs shell: no Navbar, no Footer, no GeistdocsProvider, no fumadocs-ui layout. Decision 1'
 * ("Qué se trasplanta vs qué se rehace") requires the preview routes to stay verbatim and
 * unwrapped, because they are headless render destinations with a PIXEL contract -- the PNG
 * baselines of `thumbs:check` (gate G6) are captured from these URLs, so any chrome around the
 * canvas changes the canvas box and produces diffs that mean nothing.
 *
 * Why a layout is needed at all: in the old app these pages inherited `app/layout.tsx`, which
 * imported `globals.css` and painted `<body class="bg-black ...">`. This scaffold has no root
 * `app/layout.tsx` -- its only root layout is `app/[lang]/layout.tsx` (the localized docs shell),
 * which `/preview/**` must not go through. Without this file the route still builds (Next 16
 * tolerates the missing root layout and emits an HTML fragment), but the prerendered document
 * carries no stylesheet at all: verified on this build, `.next/server/app/preview/gradient.html`
 * had zero `<link rel="stylesheet">`, so `h-screen w-screen`, `h-full w-full` and `bg-black` would
 * not exist and the canvas would collapse to its 300x150 intrinsic size. That is a silent pixel
 * regression, not a styling nicety.
 *
 * So this layout reproduces the old root layout's contribution to the preview document and nothing
 * else: the app stylesheet, the font variables, `antialiased`, and the old `bg-black text-gray-12
 * font-sans` body (`gray-12` comes from `app/styles/legacy-vgpu-tokens.css`, the Tailwind v4 port
 * of the old palette). Multiple root layouts are legal here because `app/preview` and `app/[lang]`
 * are sibling branches with no shared root layout. At cutover (TGEIST-15) this file stays; it is
 * what keeps `/preview/**` out of the docs shell for good.
 *
 * The complete list of knowing deltas from the old app's root layout, none of which reaches the
 * canvas (i.e. none can move a thumb pixel):
 *
 * 1. Fonts come from `next/font/google` Geist (this app's `lib/geistdocs/fonts`) instead of the
 *    `geist` package's self-hosted Geist -- same typeface, and no new dependency for a route whose
 *    only job is to paint a canvas.
 * 2. `components/dev-instrumentation` is not mounted (a dev-only overlay of the old app that was
 *    never transplanted).
 * 3. `title` is "vgpu example preview" instead of the old root layout's site-wide title, and its
 *    `description` / OpenGraph metadata are dropped: this document is never a share target, it is
 *    loaded by a headless renderer and by the gallery's iframes.
 * 4. `robots: noindex, nofollow` is added, which the old app did not set. The previews are chromeless
 *    canvases with no content of their own, so keeping 19 of them out of the index is strictly
 *    better than inheriting the site default; it also cannot affect `/preview/**` rendering, only
 *    what crawlers do with it.
 */

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: "vgpu example preview",
  robots: { index: false, follow: false },
};

const PreviewLayout = ({ children }: { children: React.ReactNode }) => (
  <html className={cn(sans.variable, mono.variable, "antialiased")} lang="en">
    <body className="bg-black font-sans text-gray-12">{children}</body>
  </html>
);

export default PreviewLayout;
