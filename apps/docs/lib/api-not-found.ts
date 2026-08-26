import { siteUrl } from "./site";

const body = `${JSON.stringify({
  error: {
    code: "VGPU-API-NOT-FOUND",
    message: "API endpoint not found",
    resolution: "Use the OpenAPI document to find a supported endpoint.",
    documentationUrl: siteUrl("/openapi.json"),
  },
})}\n`;

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Content-Length",
  "Cache-Control": "no-store",
  "Content-Length": String(new TextEncoder().encode(body).byteLength),
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

export function apiNotFoundResponse(head = false): Response {
  return new Response(head ? null : body, { status: 404, headers });
}
