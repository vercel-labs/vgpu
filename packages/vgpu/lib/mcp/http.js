import {
  createMcpHandler,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { createVgpuMcpServer } from "./server.js";

const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * @param {{
 *   version: string,
 *   docs: { execute(input: unknown): unknown },
 *   examples: { execute(input: unknown): unknown },
 *   allowedOriginHostnames?: string[],
 *   onerror?: (error: Error) => void,
 * }} options
 */
export function createVgpuMcpHttpHandler({
  version,
  docs,
  examples,
  allowedOriginHostnames = /** @type {string[]} */ ([]),
  onerror,
}) {
  // This route is horizontally scaled, so process-local legacy sessions cannot be routed
  // reliably. Modern MCP is request-scoped and keeps the public handler stateless.
  const handler = createMcpHandler(
    () => createVgpuMcpServer({ version, docs, examples, allowDownload: false }),
    { legacy: "reject", onerror },
  );

  return {
    ...handler,
    async fetch(request, options) {
      const rejectedOrigin = originValidationResponse(
        request,
        [...new Set(allowedOriginHostnames)],
      );
      if (rejectedOrigin) return rejectedOrigin;

      const contentLength = request.headers.get("content-length");
      if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)) {
        return new Response("MCP request body is too large.\n", { status: 413 });
      }
      let bounded;
      try {
        bounded = await bufferBoundedRequest(request);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        try { onerror?.(normalized); } catch {}
        return Response.json({
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: the request body could not be read" },
          id: null,
        }, { status: 400 });
      }
      if (bounded instanceof Response) return bounded;
      return handler.fetch(bounded, options);
    },
    close: () => handler.close(),
  };
}

async function bufferBoundedRequest(request) {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return new Response("MCP request body is too large.\n", { status: 413 });
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body });
}
