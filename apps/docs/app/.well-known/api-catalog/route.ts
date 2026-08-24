import {
  API_CATALOG_CONTENT_TYPE,
  apiCatalogDocument,
} from "../../../lib/api-catalog";
import { siteUrl } from "../../../lib/site";

export const revalidate = false;

const body = JSON.stringify(apiCatalogDocument);
const contentLength = new TextEncoder().encode(body).byteLength.toString();

function createApiCatalogResponse(includeBody: boolean): Response {
  return new Response(includeBody ? body : null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Link",
      "Cache-Control": "public, max-age=300, must-revalidate",
      "Content-Length": contentLength,
      "Content-Type": API_CATALOG_CONTENT_TYPE,
      "Link": `<${siteUrl("/.well-known/api-catalog")}>; rel="api-catalog"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function GET(): Response {
  return createApiCatalogResponse(true);
}

export function HEAD(): Response {
  return createApiCatalogResponse(false);
}
