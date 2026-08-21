import { openApiDocument } from "@/lib/examples-api/openapi";

export const revalidate = false;

export function GET(): Response {
  return Response.json(openApiDocument, {
    headers: {
      "Cache-Control": "public, max-age=300, must-revalidate",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
