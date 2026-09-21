import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, expect, test } from "vitest";
import { createDocsService } from "../lib/docs/service.js";
import {
  MCP_MAX_READ_CHARACTERS,
  MCP_MAX_RESULT_BYTES,
  MCP_MAX_TEXT_BYTES,
  createVgpuMcpServer,
} from "../lib/mcp/server.js";

const cleanups: Array<() => Promise<void>> = [];
const clientInfo = { name: "vgpu-test", version: "1.0.0" };
type ServerOptions = Parameters<typeof createVgpuMcpServer>[0];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connectHttp(options: ServerOptions) {
  const handler = createMcpHandler(() => createVgpuMcpServer(options));
  const transport = new StreamableHTTPClientTransport(new URL("http://vgpu.test/mcp"), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  const client = new Client(clientInfo);
  cleanups.push(async () => {
    await client.close();
    await handler.close();
  });
  await client.connect(transport);
  return client;
}

async function connectInMemory(options: ServerOptions) {
  const server = createVgpuMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(clientInfo);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

test("MCP exposes exactly the docs and examples tools through the official client", async () => {
  const docs = {
    execute: (input: unknown) => ({ operation: "search", input, results: [{ symbol: "Buffer" }] }),
  };
  const examples = {
    execute: async (input: unknown) => ({ operation: "search", input, results: [{ id: "triangle" }] }),
  };
  const client = await connectHttp({ version: "0.2.0", docs, examples, allowDownload: false });

  const listed = await client.listTools();
  expect(listed.tools.map((tool) => tool.name)).toEqual(["docs", "examples"]);
  expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
  expect(listed.tools.every((tool) => tool.annotations?.openWorldHint === false)).toBe(true);

  const result = await client.callTool({
    name: "docs",
    arguments: { operation: "search", query: "Buffer" },
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({
    operation: "search",
    input: { operation: "search", query: "Buffer" },
    results: [{ symbol: "Buffer" }],
  });
});

test("local examples are marked open-world and receive the MCP cancellation signal", async () => {
  let receivedSignal: AbortSignal | undefined;
  let started!: () => void;
  let aborted!: () => void;
  const operationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const operationAborted = new Promise<void>((resolve) => {
    aborted = resolve;
  });
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
  const client = await connectInMemory({ version: "0.2.0", docs, examples, allowDownload: true });

  expect(client.getInstructions()).toContain(
    "Pass a relative destination beneath the configured MCP output directory",
  );

  const listed = await client.listTools();
  const examplesTool = listed.tools.find((tool) => tool.name === "examples");
  expect(examplesTool?.annotations).toMatchObject({
    readOnlyHint: false,
    openWorldHint: true,
  });
  const examplesSchema = JSON.stringify(examplesTool?.inputSchema);
  expect(examplesSchema).toContain('"destination"');
  expect(examplesSchema).not.toContain('"out"');

  const controller = new AbortController();
  const pending = client.callTool(
    { name: "examples", arguments: { operation: "search", query: "triangle" } },
    { signal: controller.signal },
  );
  await operationStarted;
  controller.abort(new DOMException("cancelled by test", "AbortError"));

  await expect(pending).rejects.toThrow(/AbortError: cancelled by test/u);
  await operationAborted;
  expect(receivedSignal?.aborted).toBe(true);
});

test("read-only local examples retain offline repository access", async () => {
  let receivedInput: unknown;
  const docs = { execute: () => ({ operation: "search", results: [] }) };
  const examples = {
    execute: (input: unknown) => {
      receivedInput = input;
      return { operation: "search", revision: "a".repeat(64), results: [] };
    },
  };
  const client = await connectInMemory({
    version: "0.2.0",
    docs,
    examples,
    allowDownload: false,
    examplesOpenWorld: true,
  });

  const examplesTool = (await client.listTools()).tools.find((tool) => tool.name === "examples");
  const schema = JSON.stringify(examplesTool?.inputSchema);
  expect(schema).toContain('"offline"');
  expect(schema).not.toContain('"download"');

  await client.callTool({
    name: "examples",
    arguments: { operation: "search", query: "gradient", offline: true },
  });
  expect(receivedInput).toMatchObject({ operation: "search", offline: true });
});

test("read operations return source text once and keep structured content to metadata", async () => {
  const docs = {
    execute: () => ({
      operation: "read",
      target: "Buffer",
      document: { path: "api/Buffer.md", contentType: "text/markdown", content: "# Buffer\nDocs" },
    }),
  };
  const examples = {
    execute: () => ({
      operation: "read",
      id: "triangle",
      path: "main.js",
      contentType: "text/javascript",
      size: 21,
      content: "console.log('hello')\n",
    }),
  };
  const client = await connectHttp({ version: "0.2.0", docs, examples, allowDownload: false });

  const docsResult = await client.callTool({
    name: "docs",
    arguments: { operation: "read", target: "Buffer" },
  });
  expect(docsResult.content).toEqual([{ type: "text", text: "# Buffer\nDocs" }]);
  expect(docsResult.structuredContent).toEqual({
    operation: "read",
    target: "Buffer",
    document: { path: "api/Buffer.md", contentType: "text/markdown" },
  });

  const examplesResult = await client.callTool({
    name: "examples",
    arguments: { operation: "read", id: "triangle", path: "main.js" },
  });
  expect(examplesResult.content).toEqual([{ type: "text", text: "console.log('hello')\n" }]);
  expect(examplesResult.structuredContent).toEqual({
    operation: "read",
    id: "triangle",
    path: "main.js",
    contentType: "text/javascript",
    size: 21,
  });
});

test("typed docs errors retain bounded ambiguity candidates", async () => {
  const docs = {
    execute: () => {
      const error = Object.assign(new Error("Ambiguous symbol: Uniform"), {
        code: "VGPU-DOCS-AMBIGUOUS",
        candidates: [
          { symbol: "Uniform", package: "@vgpu/core", path: "api/core/Uniform.md" },
          { symbol: "Uniform", package: "@vgpu/shader", path: "api/shader/Uniform.md" },
        ],
      });
      throw error;
    },
  };
  const examples = { execute: () => ({ operation: "search", results: [] }) };
  const client = await connectHttp({ version: "0.2.0", docs, examples, allowDownload: false });

  const result = await client.callTool({
    name: "docs",
    arguments: { operation: "resolve", target: "Uniform" },
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toEqual({
    error: {
      code: "VGPU-DOCS-AMBIGUOUS",
      message: "Ambiguous symbol: Uniform",
      candidates: [
        { symbol: "Uniform", package: "@vgpu/core", path: "api/core/Uniform.md" },
        { symbol: "Uniform", package: "@vgpu/shader", path: "api/shader/Uniform.md" },
      ],
    },
  });
});

test("read responses paginate valid large source files within the MCP contract budget", async () => {
  const chunkCharacters = MCP_MAX_READ_CHARACTERS;
  const content = "\0".repeat(MCP_MAX_TEXT_BYTES + chunkCharacters);
  const docs = { execute: () => ({ operation: "search", results: [] }) };
  const examples = {
    execute: () => ({ operation: "read", id: "large", path: "main.js", size: content.length, content }),
  };
  const client = await connectHttp({ version: "0.2.0", docs, examples, allowDownload: false });

  const first = await client.callTool({
    name: "examples",
    arguments: { operation: "read", id: "large", path: "main.js", limit: chunkCharacters },
  });
  expect(first.isError).not.toBe(true);
  expect(first.content).toEqual([{ type: "text", text: content.slice(0, chunkCharacters) }]);
  expect(first.structuredContent).toMatchObject({
    offset: 0,
    characters: chunkCharacters,
    totalCharacters: content.length,
    truncated: true,
    nextOffset: chunkCharacters,
  });
  expect(JSON.stringify(first).length).toBeLessThan(MCP_MAX_RESULT_BYTES);

  const second = await client.callTool({
    name: "examples",
    arguments: {
      operation: "read",
      id: "large",
      path: "main.js",
      offset: chunkCharacters,
      limit: chunkCharacters,
    },
  });
  expect(second.isError).not.toBe(true);
  expect(second.content).toEqual([
    { type: "text", text: content.slice(chunkCharacters, chunkCharacters * 2) },
  ]);
  expect(second.structuredContent).toMatchObject({
    offset: chunkCharacters,
    characters: chunkCharacters,
    nextOffset: chunkCharacters * 2,
  });
});

test("non-read results and errors stay within a whole-response budget without duplicating large payloads", async () => {
  let mode: "show" | "search" | "oversized" = "show";
  const docs = {
    execute: () => {
      throw new Error("e".repeat(3 * 1024 * 1024));
    },
  };
  const examples = {
    execute: () => {
      if (mode === "show") return { operation: "show", manifest: { description: "x".repeat(240 * 1024) } };
      if (mode === "search") {
        return {
          operation: "search",
          results: Array.from({ length: 50 }, (_, id) => ({ id: String(id), description: "x".repeat(20 * 1024) })),
        };
      }
      return { operation: "search", results: [{ description: "x".repeat(3 * 1024 * 1024) }] };
    },
  };
  const client = await connectHttp({ version: "0.2.0", docs, examples, allowDownload: false });

  const show = await client.callTool({ name: "examples", arguments: { operation: "show", id: "large" } });
  expect(show.isError).not.toBe(true);
  expect(show.content).toEqual([
    { type: "text", text: "Structured examples.show result; inspect structuredContent for details." },
  ]);
  expect(JSON.stringify(show).length).toBeLessThan(512 * 1024);

  mode = "search";
  const search = await client.callTool({
    name: "examples",
    arguments: { operation: "search", query: "large", limit: 50 },
  });
  expect(search.isError).not.toBe(true);
  expect(search.content).toEqual([
    { type: "text", text: "Structured examples.search result; inspect structuredContent for details." },
  ]);
  expect(JSON.stringify(search).length).toBeLessThan(MCP_MAX_RESULT_BYTES);

  mode = "oversized";
  const oversized = await client.callTool({
    name: "examples",
    arguments: { operation: "search", query: "large" },
  });
  expect(oversized).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "VGPU-MCP-RESULT-TOO-LARGE" } },
  });
  expect(JSON.stringify(oversized).length).toBeLessThan(16 * 1024);

  const errored = await client.callTool({ name: "docs", arguments: { operation: "search", query: "large" } });
  expect(errored.isError).toBe(true);
  expect(JSON.stringify(errored).length).toBeLessThan(16 * 1024);
});

test("the real docs service exposes typed misses and ambiguity through MCP", async () => {
  const client = await connectInMemory({
    version: "0.2.0",
    docs: createDocsService(),
    examples: { execute: () => ({ operation: "search", results: [] }) },
    allowDownload: false,
  });

  const missing = await client.callTool({
    name: "docs",
    arguments: { operation: "search", query: "definitely-no-such-vgpu-document" },
  });
  expect(missing).toMatchObject({
    isError: true,
    structuredContent: {
      error: {
        code: "VGPU-DOCS-NOT-FOUND",
        query: "definitely-no-such-vgpu-document",
      },
    },
  });

  const ambiguous = await client.callTool({
    name: "docs",
    arguments: { operation: "resolve", target: "Uniform" },
  });
  expect(ambiguous).toMatchObject({
    isError: true,
    structuredContent: {
      error: {
        code: "VGPU-DOCS-AMBIGUOUS",
        target: "Uniform",
        candidates: expect.arrayContaining([
          expect.objectContaining({ symbol: "Uniform", virtualPath: "/vgpu/core/uniform.docs.md" }),
          expect.objectContaining({ symbol: "Uniform", virtualPath: "/vgpu/uniform.docs.md" }),
        ]),
      },
    },
  });
});
