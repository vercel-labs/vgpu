import { apiNotFoundResponse } from "../../../lib/api-not-found";

// Specific API routes take precedence over this catch-all. An unknown endpoint
// does not support any method, so every method returns the same 404 contract
// instead of a framework-generated HTML 404 or 405 response.
export const GET = (_request: Request) => apiNotFoundResponse();
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const OPTIONS = GET;
export const HEAD = (_request: Request) => apiNotFoundResponse(true);
