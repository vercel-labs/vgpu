import { MobileDocsBar } from "@vercel/geistdocs/mobile-docs-bar";
import { createDocsPage } from "@vercel/geistdocs/pages/docs";
import { getMDXComponents } from "@/components/geistdocs/mdx-components";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { titleAnchorId } from "@/lib/title-anchor.mjs";
import { SITE_OG_IMAGE_PATH, siteUrl } from "@/lib/site";

const docsPage = createDocsPage({
  config,
  // `link` can be `undefined`; only pass an `a` override when the package
  // actually provides one, otherwise `{ a: undefined }` fails MDXComponents'
  // type (it disallows `undefined` values, only `NestedMDXComponents |
  // Component<any>`). Real bug in the vanilla 1.15.2 template, fixed here in
  // this user-owned adapter file rather than patched in the package.
  mdx: ({ link }) => getMDXComponents(link ? { a: link } : undefined),
  openGraph: {
    images: true,
  },
  metadata: ({ metadata, page }) => {
    const data = page.data as typeof page.data & { canonical?: string };
    const canonical = siteUrl(data.canonical ?? page.url);
    return {
      ...metadata,
      alternates: {
        ...metadata.alternates,
        canonical,
        types: {
          ...metadata.alternates?.types,
          "text/markdown": siteUrl(`${page.url}.md`),
        },
      },
      openGraph: {
        type: "article",
        title: data.title,
        description: data.description,
        url: canonical,
        images: [siteUrl(SITE_OG_IMAGE_PATH)],
      },
    };
  },
  source: geistdocsSource,
  tableOfContentPopover: {
    enabled: false,
  },
  // ANCHOR TGEIST-12 / Decision 2.3 — the page-title anchor.
  //
  // The old site's `<h1>` came from the markdown body, so `/docs/cli#cli` had a
  // real target: 97 anchors frozen from prod are exactly that, and so are most of
  // the `#anchor` destinations of the API reference redirects (a single-symbol
  // topic's heading *is* the page title). `createDocsPage` renders the title
  // itself and takes no props for it, so the id goes on a zero-height element
  // here — `renderTop`'s output is the page's first child and the title div the
  // second, so this is the same scroll target the `<h1>` would have been.
  // `titleAnchorId` returns null when a body heading already owns that id (the
  // reference pages open every symbol with an `<h1>`), because two identical ids
  // in one document would shadow the real heading.
  //
  // Two things the classes are load-bearing for, both found by measuring the
  // rendered page rather than by reading it:
  //   - `absolute` keeps the element out of flow. `article#nd-page` is a flex
  //     column with `gap-4`, and a `block h-0` span is still a **flex item**, so
  //     the gap above the title was applied to it and every page's title moved
  //     down 16px (measured: `h1` top 136 instead of 120). An out-of-flow element
  //     contributes no flex item and no gap, and its static position — which is
  //     what `top: auto` resolves to — is still the top of the content box, so it
  //     is the same scroll target. `-mb-4` would also cancel it, by hardcoding
  //     the exact gap the package happens to use today.
  //   - `scroll-m-28` matches what the layout puts on every body heading
  //     (`h2.scroll-m-28`), so `/docs/cli#cli` lands the title in the same place
  //     under the sticky header that `#installation-and-usage` lands its heading.
  //     Without it the fragment scrolled the title *behind* the header.
  renderTop: ({ data }) => {
    const anchor = titleAnchorId({ title: data.title, toc: data.toc });
    return (
      <>
        {anchor ? <span aria-hidden="true" className="absolute h-0 scroll-m-28" id={anchor} /> : null}
        <MobileDocsBar toc={data.toc} />
      </>
    );
  },
});

export default docsPage.Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
