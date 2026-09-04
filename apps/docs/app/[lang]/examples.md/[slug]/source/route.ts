import { applyMarkdownHeaders, createNotFoundResponse } from "@vercel/agent-readability";
import { translations } from "../../../../../geistdocs";
import { buildExampleSourceMarkdown } from "../../../../../lib/example-readme";
import { examples, getExample } from "../../../../../lib/examples-registry";
import { localizedSitePath, siteUrl } from "../../../../../lib/site";

interface ExampleSourceMarkdownRouteContext {
  params: Promise<{ lang: string; slug: string }>;
}

export const revalidate = false;

export function generateStaticParams() {
  return Object.keys(translations).flatMap((lang) =>
    examples.map((example) => ({ lang, slug: example.meta.slug })),
  );
}

export async function GET(
  _request: Request,
  { params }: ExampleSourceMarkdownRouteContext,
): Promise<Response> {
  const { lang, slug } = await params;
  const example = getExample(slug);

  if (!example) {
    return createNotFoundResponse(
      localizedSitePath(`/examples/${slug}/source.md`, lang),
      {
        sitemapUrl: localizedSitePath("/sitemap.md", lang),
        indexUrl: localizedSitePath("/llms.txt", lang),
        fullContentUrl: localizedSitePath("/llms-full.txt", lang),
        exampleUrl: localizedSitePath(
          "/examples/gradient/source.md",
          lang,
        ),
      },
    );
  }

  const headers = applyMarkdownHeaders(
    new Headers({
      "Cache-Control": "public, max-age=300, must-revalidate",
      "Content-Type": "text/markdown; charset=utf-8",
    }),
    { canonicalUrl: siteUrl(`/examples/${slug}`) },
  );

  return new Response(buildExampleSourceMarkdown(example), { headers });
}
