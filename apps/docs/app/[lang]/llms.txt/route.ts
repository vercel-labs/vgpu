import { applyMarkdownHeaders } from "@vercel/agent-readability";
import { buildLlmsIndexMarkdown } from "../../../lib/llms";
import { siteUrl } from "../../../lib/site";

export const revalidate = false;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ lang: string }> },
): Promise<Response> {
  const { lang } = await params;
  const localePrefix = lang === "en" ? "" : `/${lang}`;
  const headers = applyMarkdownHeaders(
    new Headers({
      "Cache-Control": "public, max-age=300, must-revalidate",
      "Content-Type": "text/markdown; charset=utf-8",
    }),
    { canonicalUrl: siteUrl(`${localePrefix}/llms.txt`) },
  );

  return new Response(buildLlmsIndexMarkdown(lang), { headers });
}
