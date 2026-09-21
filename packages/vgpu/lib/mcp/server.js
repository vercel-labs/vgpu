import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const MCP_MAX_TEXT_BYTES = 256 * 1024;
export const MCP_MAX_READ_CHARACTERS = 64 * 1024;
export const MCP_MAX_RESULT_BYTES = 2 * 1024 * 1024;

const MCP_MAX_READ_OFFSET = 2 * 1024 * 1024;
const MCP_INLINE_JSON_BYTES = 16 * 1024;
const MCP_MAX_ERROR_MESSAGE_CHARACTERS = 4 * 1024;

const revision = z.string().regex(/^[a-f0-9]{64}$/u, "Expected a 64-character lowercase SHA-256 revision");
const exampleId = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/u, "Expected an example id");
const readWindow = {
  offset: z.number().int().min(0).max(MCP_MAX_READ_OFFSET).default(0)
    .describe("UTF-16 character offset for a paginated read"),
  limit: z.number().int().min(1).max(MCP_MAX_READ_CHARACTERS).default(MCP_MAX_READ_CHARACTERS)
    .describe(`Maximum UTF-16 characters to return (up to ${MCP_MAX_READ_CHARACTERS})`),
};

const docsInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("search"), query: z.string().min(1).max(200) }),
  z.strictObject({ operation: z.literal("read"), target: z.string().min(1).max(512), ...readWindow }),
  z.strictObject({ operation: z.literal("resolve"), target: z.string().min(1).max(512) }),
  z.strictObject({ operation: z.literal("list"), path: z.string().min(1).max(512).default("/") }),
  z.strictObject({
    operation: z.literal("grep"),
    pattern: z.string().min(1).max(200),
    ignoreCase: z.boolean().default(false),
    package: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  z.strictObject({
    operation: z.literal("symbols"),
    query: z.string().min(1).max(200).optional(),
    package: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
]);

function examplesInputSchema({ allowDownload, examplesOpenWorld }) {
  const offline = examplesOpenWorld ? { offline: z.boolean().default(false) } : {};
  const operations = [
    z.strictObject({
      operation: z.literal("search"),
      query: z.string().min(1).max(200),
      match: z.enum(["all", "any"]).default("all"),
      limit: z.number().int().min(1).max(50).default(20),
      revision: revision.optional(),
      ...offline,
    }),
    z.strictObject({ operation: z.literal("show"), id: exampleId, revision: revision.optional(), ...offline }),
    z.strictObject({
      operation: z.literal("read"),
      id: exampleId,
      path: z.string().min(1).max(1024),
      revision: revision.optional(),
      ...readWindow,
      ...offline,
    }),
  ];
  if (allowDownload) {
    operations.push(z.strictObject({
      operation: z.literal("download"),
      id: exampleId,
      destination: z.string().min(1).max(1024)
        .describe("Relative directory beneath the configured MCP output directory"),
      revision: revision.optional(),
      offline: z.boolean().default(false),
    }));
  }
  return z.discriminatedUnion("operation", operations);
}

export function createVgpuMcpServer({
  version,
  docs,
  examples,
  allowDownload = false,
  examplesOpenWorld = allowDownload,
}) {
  const server = new McpServer(
    { name: "vgpu", version },
    {
      instructions: [
        "Use docs to discover and read VGPU documentation. Use examples to find and inspect working examples.",
        ...(allowDownload
          ? ["Pass a relative destination beneath the configured MCP output directory when using examples.download."]
          : []),
      ].join(" "),
    },
  );

  server.registerTool(
    "docs",
    {
      title: "VGPU documentation",
      description: "Search, resolve, list, grep, and read the canonical VGPU documentation corpus.",
      inputSchema: docsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input, context) => {
      const signal = context.mcpReq.signal;
      return executeTool(() => docs.execute(input, { signal }), signal, { input, tool: "docs" });
    },
  );

  server.registerTool(
    "examples",
    {
      title: "VGPU examples",
      description: allowDownload
        ? "Search, inspect, read, or download a verified VGPU example beneath the configured MCP output directory."
        : "Search, inspect, and read verified VGPU examples.",
      inputSchema: examplesInputSchema({ allowDownload, examplesOpenWorld }),
      annotations: {
        readOnlyHint: !allowDownload,
        destructiveHint: false,
        idempotentHint: !allowDownload,
        openWorldHint: examplesOpenWorld,
      },
    },
    (input, context) => {
      const signal = context.mcpReq.signal;
      return executeTool(() => examples.execute(input, { signal }), signal, { input, tool: "examples" });
    },
  );

  return server;
}

async function executeTool(operation, signal, rendering) {
  try {
    const output = await operation();
    return assertResultWithinLimit(renderToolOutput(output, rendering));
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error && typeof error === "object" && error.name === "AbortError") throw error;
    const normalized = normalizeToolError(error);
    return assertResultWithinLimit({
      content: [{ type: "text", text: `${normalized.code}: ${normalized.message}` }],
      structuredContent: { error: normalized },
      isError: true,
    });
  }
}

function normalizeToolError(error) {
  const rawMessage = error instanceof Error ? error.message : "Unknown tool error";
  const message = rawMessage.slice(0, MCP_MAX_ERROR_MESSAGE_CHARACTERS);
  if (error && typeof error === "object" && typeof error.code === "string") {
    const normalized = { code: error.code, message };
    const candidates = normalizeCandidates(error.candidates);
    const target = typeof error.target === "string" ? error.target.slice(0, 1024) : undefined;
    const lookup = typeof error.lookup === "string" ? error.lookup.slice(0, 64) : undefined;
    const query = typeof error.query === "string" ? error.query.slice(0, 1024) : undefined;
    const pattern = typeof error.pattern === "string" ? error.pattern.slice(0, 1024) : undefined;
    return {
      ...normalized,
      ...(target ? { target } : {}),
      ...(lookup ? { lookup } : {}),
      ...(query ? { query } : {}),
      ...(pattern ? { pattern } : {}),
      ...(candidates ? { candidates } : {}),
    };
  }
  if (/not found/iu.test(message)) return { code: "VGPU-DOCS-NOT-FOUND", message };
  if (/^Ambiguous symbol:/u.test(message)) return { code: "VGPU-DOCS-AMBIGUOUS", message };
  return { code: "VGPU-TOOL-ERROR", message };
}

function renderToolOutput(output, { input, tool }) {
  if (output && typeof output === "object" && output.operation === "read") {
    if (typeof output.content === "string") {
      const { content, ...metadata } = output;
      const page = paginateText(content, input);
      assertTextWithinLimit(page.content);
      return {
        content: [{ type: "text", text: page.content }],
        structuredContent: { ...metadata, ...page.metadata },
      };
    }
    if (output.document && typeof output.document === "object" && typeof output.document.content === "string") {
      const { content, ...document } = output.document;
      const page = paginateText(content, input);
      assertTextWithinLimit(page.content);
      return {
        content: [{ type: "text", text: page.content }],
        structuredContent: { ...output, document, ...page.metadata },
      };
    }
  }
  const serialized = JSON.stringify(output) ?? "null";
  const operation = typeof input.operation === "string" ? input.operation : "result";
  const fallback = Buffer.byteLength(serialized, "utf8") <= MCP_INLINE_JSON_BYTES
    ? serialized
    : `Structured ${tool}.${operation} result; inspect structuredContent for details.`;
  return {
    content: [{ type: "text", text: fallback }],
    structuredContent: output,
  };
}

function paginateText(content, input) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? MCP_MAX_READ_CHARACTERS;
  const page = content.slice(offset, offset + limit);
  const end = offset + page.length;
  const truncated = end < content.length;
  const includeMetadata = offset > 0 || truncated;
  return {
    content: page,
    metadata: includeMetadata
      ? {
          offset,
          limit,
          characters: page.length,
          totalCharacters: content.length,
          truncated,
          ...(truncated ? { nextOffset: end } : {}),
        }
      : {},
  };
}

function normalizeCandidates(value) {
  if (!Array.isArray(value)) return undefined;
  const candidates = value.slice(0, 50).flatMap((candidate) => {
    if (typeof candidate === "string") return [candidate.slice(0, 1024)];
    if (!candidate || typeof candidate !== "object") return [];
    const normalized = {};
    for (const key of ["symbol", "package", "virtualPath", "repoPath", "path", "kind"]) {
      if (typeof candidate[key] === "string") normalized[key] = candidate[key].slice(0, 1024);
    }
    return Object.keys(normalized).length > 0 ? [normalized] : [];
  });
  return candidates.length > 0 ? candidates : undefined;
}

function assertTextWithinLimit(content) {
  if (Buffer.byteLength(content, "utf8") <= MCP_MAX_TEXT_BYTES) return;
  throw resultTooLarge(`Read chunk exceeds the ${MCP_MAX_TEXT_BYTES / 1024} KiB MCP text limit; request a smaller read limit.`);
}

function assertResultWithinLimit(result) {
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes <= MCP_MAX_RESULT_BYTES) return result;
  throw resultTooLarge(`Tool result exceeds the ${MCP_MAX_RESULT_BYTES / (1024 * 1024)} MiB MCP response limit.`);
}

function resultTooLarge(message) {
  return Object.assign(new Error(message), { code: "VGPU-MCP-RESULT-TOO-LARGE" });
}
