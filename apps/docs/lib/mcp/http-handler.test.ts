import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, test } from "vitest";
import { createVgpuMcpHttpHandler } from "./http-handler";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

test("HTTP MCP serves a stateless modern session through the official client", async () => {
  const docs = { execute: (input: unknown) => ({ operation: "search", input, results: [] }) };
  const examples = { execute: async (input: unknown) => ({ operation: "search", input, results: [] }) };
  const handler = createVgpuMcpHttpHandler({ version: "0.3.0", docs, examples });
  const transport = new StreamableHTTPClientTransport(new URL("https://vgpu.sh/api/mcp"), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  const client = new Client({
    name: "vgpu-http-test",
    version: "1.0.0",
  }, { versionNegotiation: { mode: "auto" } });
  cleanups.push(async () => {
    await client.close();
    await handler.close();
  });

  await client.connect(transport);
  expect(client.getProtocolEra()).toBe("modern");
  const listed = await client.listTools();

  expect(listed.tools.map((tool) => tool.name)).toEqual(["docs", "examples"]);
  const examplesTool = listed.tools.find((tool) => tool.name === "examples");
  expect(examplesTool?.annotations?.readOnlyHint).toBe(true);
  const examplesSchema = JSON.stringify(examplesTool?.inputSchema);
  expect(examplesSchema).not.toContain('"offline"');
  expect(examplesSchema).not.toContain('"download"');

  const result = await client.callTool({
    name: "examples",
    arguments: { operation: "search", query: "gradient" },
  });
  expect(result.structuredContent).toMatchObject({
    operation: "search",
    input: { operation: "search", query: "gradient", match: "all", limit: 20 },
  });
});

test("HTTP MCP cancellation aborts the original tool execution", async () => {
  let started!: () => void;
  let aborted!: () => void;
  let receivedSignal: AbortSignal | undefined;
  const operationStarted = new Promise<void>((resolve) => { started = resolve; });
  const operationAborted = new Promise<void>((resolve) => { aborted = resolve; });
  const docs = { execute: () => ({ operation: "search", results: [] }) };
  const examples = {
    execute: (_input: unknown, options?: { signal?: AbortSignal }) => {
      receivedSignal = options?.signal;
      started();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted();
          reject(options.signal?.reason);
        }, { once: true });
      });
    },
  };
  const handler = createVgpuMcpHttpHandler({ version: "0.3.0", docs, examples });
  const transport = new StreamableHTTPClientTransport(new URL("https://vgpu.sh/api/mcp"), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  const client = new Client({
    name: "vgpu-http-cancellation-test",
    version: "1.0.0",
  }, { versionNegotiation: { mode: "auto" } });
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await handler.close();
  });
  await client.connect(transport);

  const controller = new AbortController();
  const pending = client.callTool(
    { name: "examples", arguments: { operation: "search", query: "gradient" } },
    { signal: controller.signal },
  );
  await operationStarted;
  controller.abort(new DOMException("cancelled by test", "AbortError"));

  await expect(pending).rejects.toThrow(/AbortError: cancelled by test/u);
  const serverOutcome = await Promise.race([
    operationAborted.then(() => "aborted"),
    new Promise((resolve) => setTimeout(() => resolve("still running"), 250)),
  ]);
  expect(serverOutcome).toBe("aborted");
  expect(receivedSignal?.aborted).toBe(true);
});

test("HTTP MCP rejects legacy initialization instead of creating process-local sessions", async () => {
  const service = { execute: () => ({ operation: "search", results: [] }) };
  const handler = createVgpuMcpHttpHandler({ version: "0.3.0", docs: service, examples: service });
  cleanups.push(() => handler.close());

  const response = await handler.fetch(legacyInitializeRequest(1));
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: { message: expect.stringMatching(/unsupported protocol version/iu) },
  });
});

test("HTTP MCP rejects browser requests from another origin", async () => {
  const service = { execute: () => ({ operation: "search", results: [] }) };
  const handler = createVgpuMcpHttpHandler({ version: "0.3.0", docs: service, examples: service });
  cleanups.push(() => handler.close());

  const response = await handler.fetch(new Request("https://vgpu.sh/api/mcp", {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/json" },
    body: "{}",
  }));

  expect(response.status).toBe(403);
});

test("HTTP MCP does not trust the request hostname as an origin allowlist", async () => {
  const service = { execute: () => ({ operation: "search", results: [] }) };
  const handler = createVgpuMcpHttpHandler({
    version: "0.3.0",
    docs: service,
    examples: service,
    allowedOriginHostnames: ["vgpu.sh"],
  });
  cleanups.push(() => handler.close());

  const response = await handler.fetch(new Request("https://attacker.example/api/mcp", {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/json" },
    body: "{}",
  }));

  expect(response.status).toBe(403);
});

test("HTTP MCP caps request bodies even when content-length is absent", async () => {
  const service = { execute: () => ({ operation: "search", results: [] }) };
  const handler = createVgpuMcpHttpHandler({ version: "0.3.0", docs: service, examples: service });
  cleanups.push(() => handler.close());

  const response = await handler.fetch(new Request("https://vgpu.sh/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(65_537),
  }));

  expect(response.status).toBe(413);
});

test("HTTP MCP caps the actual body when content-length understates it", async () => {
  const service = { execute: () => ({ operation: "search", results: [] }) };
  const handler = createVgpuMcpHttpHandler({ version: "0.3.0", docs: service, examples: service });
  cleanups.push(() => handler.close());

  const response = await handler.fetch(new Request("https://vgpu.sh/api/mcp", {
    method: "POST",
    headers: { "content-length": "1", "content-type": "application/json" },
    body: "x".repeat(65_537),
  }));

  expect(response.status).toBe(413);
});

test("HTTP MCP reports an errored request stream as a bounded parse failure", async () => {
  const service = { execute: () => ({ operation: "search", results: [] }) };
  const reported: Error[] = [];
  const handler = createVgpuMcpHttpHandler({
    version: "0.3.0",
    docs: service,
    examples: service,
    onerror: (error) => reported.push(error),
  });
  cleanups.push(() => handler.close());
  const request = new Request("https://vgpu.sh/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.error(new Error("request stream broke"));
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const response = await handler.fetch(request);

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    jsonrpc: "2.0",
    error: { code: -32700, message: "Parse error: the request body could not be read" },
    id: null,
  });
  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatchObject({ message: "request stream broke" });
});

function legacyInitializeRequest(id: number) {
  return new Request("https://vgpu.sh/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "vgpu-http-session-test", version: "1.0.0" },
      },
    }),
  });
}
