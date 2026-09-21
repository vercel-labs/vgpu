import { openApiDocument } from "@/lib/examples-api/openapi";
import { siteUrl } from "@/lib/site";

export const revalidate = false;

export function GET(): Response {
  return Response.json(openApiDocument, {
    headers: {
      "Cache-Control": "public, max-age=300, must-revalidate",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Link",
      "Link": [
        `<${siteUrl("/.well-known/api-catalog")}>; rel="api-catalog"`,
        `<${siteUrl("/docs/examples-api")}>; rel="service-doc"; type="text/html"`,
      ].join(", "),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
