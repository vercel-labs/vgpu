/**
 * The page-title anchor — Decision 2.3. TGEIST-12.
 *
 * The old site's `<h1>` came from the markdown body, so it got an `id` like every
 * other heading and `/docs/cli#cli` had a real target. 92 anchors frozen from
 * prod in `docs/url-inventory.json` are exactly that, and so are 276 of the
 * `#anchor` destinations of the redirect table: the API reference deep links
 * (`/packages/vgpu/Pass` → `/docs/reference/vgpu/effect#effect`) point at a
 * symbol heading that, for single-symbol topics, *is* the page title. Decision 2.3
 * therefore prescribes giving the title `id={slugifyHeading(page.data.title)}`,
 * with the **old** slugger, because these are old URLs.
 *
 * Where the id lands: `@vercel/geistdocs`'s `createDocsPage` renders the title
 * itself (`DocsTitle`, `dist/pages/docs.js`) and exposes no hook to pass props to
 * it, so the id goes on a zero-height element that `renderTop` puts immediately
 * above that `<h1>` — `renderTop`'s output is the first child of the page, the
 * title div the second. Same scroll target, `getElementById` finds it, no patched
 * package. Every other option was worse: forking the package's page renderer into
 * this app to add one attribute, or leaving 97 live anchors dead.
 *
 * Consumed by `app/[lang]/docs/[[...slug]]/page.tsx` and by
 * `scripts/check-url-anchor-parity.mjs`, so the gate and the app cannot disagree
 * about what the title anchor is.
 */

/**
 * `apps/docs/lib/concepts.ts:185` (`slugifyHeading`), ported verbatim — the
 * slugger that produced the URLs in the wild. Deliberately NOT github-slugger:
 * it strips punctuation instead of transliterating it and it collapses `-+`.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugifyHeading(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/gu, "")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-");
}

/**
 * The id to give the page title, or `null` when it must not be emitted.
 *
 * `null` happens when a body heading already owns that id — the reference pages
 * open every symbol with a level-1 markdown heading, so on
 * `/docs/reference/vgpu/gpu` the title "gpu" and the body heading "gpu" slug to
 * the same string. Emitting it anyway would put two `id="gpu"` in one document:
 * invalid HTML, and it would silently shadow the body heading in
 * `getElementById`. Skipping it costs nothing — the anchor still resolves, to the
 * heading that was always its target.
 *
 * @param {{ title: string, toc?: ReadonlyArray<{ url?: string }> }} page
 * @returns {string | null}
 */
export function titleAnchorId({ title, toc }) {
  const slug = slugifyHeading(title ?? "");
  if (slug === "") return null;
  const taken = new Set((toc ?? []).map((item) => (item?.url ?? "").replace(/^#/u, "")));
  return taken.has(slug) ? null : slug;
}
