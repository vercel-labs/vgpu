import { applyMarkdownHeaders, createNotFoundResponse } from "@vercel/agent-readability";
import { translations } from "../../../../geistdocs";
import { buildExampleReadme } from "../../../../lib/example-readme";
import { examples, getExample } from "../../../../lib/examples-registry";
import { localizedSitePath, siteUrl } from "../../../../lib/site";

interface ExampleMarkdownRouteContext {
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
  { params }: ExampleMarkdownRouteContext,
): Promise<Response> {
  const { lang, slug } = await params;
  const example = getExample(slug);

  if (!example) {
    return createNotFoundResponse(localizedSitePath(`/examples/${slug}.md`, lang), {
      sitemapUrl: localizedSitePath("/sitemap.md", lang),
      indexUrl: localizedSitePath("/llms.txt", lang),
      fullContentUrl: localizedSitePath("/llms-full.txt", lang),
      exampleUrl: localizedSitePath("/examples/gradient.md", lang),
    });
  }

  const headers = applyMarkdownHeaders(
    new Headers({
      "Cache-Control": "public, max-age=300, must-revalidate",
      "Content-Type": "text/markdown; charset=utf-8",
    }),
    { canonicalUrl: siteUrl(`/examples/${slug}`) },
  );

  return new Response(buildExampleReadme(example), { headers });
}
