import { createDocsMarkdownRoute } from "@vercel/geistdocs/routes/llms";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { siteUrl } from "@/lib/site";

const route = createDocsMarkdownRoute({
  config,
  sources: [geistdocsSource],
  notFound: {},
});

export const { generateStaticParams, revalidate } = route;

export const GET: typeof route.GET = async (request, context) => {
  const response = await route.GET(request, context);
  const canonical = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="canonical"/iu)?.[1];

  if (canonical) {
    const url = new URL(canonical);
    response.headers.set("Link", `<${siteUrl(`${url.pathname}${url.search}`)}>; rel="canonical"`);
  }

  return response;
};
