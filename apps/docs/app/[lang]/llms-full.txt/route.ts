import { applyMarkdownHeaders } from "@vercel/agent-readability";
import { createLlmsRoute } from "@vercel/geistdocs/routes/llms";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { localizedSiteUrl } from "@/lib/site";

const route = createLlmsRoute({
  sources: [geistdocsSource],
});

export const { revalidate } = route;

export const GET: typeof route.GET = async (request, context) => {
  const { lang } = await context.params;
  const response = await route.GET(request, context);
  const headers = applyMarkdownHeaders(response.headers, {
    canonicalUrl: localizedSiteUrl("/llms-full.txt", lang),
  });

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};
