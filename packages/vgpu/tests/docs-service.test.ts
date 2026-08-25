import { expect, test } from "vitest";
import { createDocsService } from "../lib/docs/service.js";

test("docs service returns ranked structured search results", () => {
  const docs = createDocsService();

  const result = docs.execute({ operation: "search", query: "Buffer" });

  expect(result).toMatchObject({ operation: "search", truncated: false });
  expect(result.results[0]).toEqual({
    kind: "symbol",
    symbol: "Buffer",
    package: "vgpu/core",
    virtualPath: "/vgpu/core/buffer.docs.md",
  });
});

test("docs service reads a document with stable metadata", () => {
  const docs = createDocsService();

  const result = docs.execute({ operation: "read", target: "Buffer" });

  expect(result).toMatchObject({
    operation: "read",
    document: {
      symbol: "Buffer",
      package: "vgpu/core",
      virtualPath: "/vgpu/core/buffer.docs.md",
      repoPath: "packages/core/src/buffer.docs.md",
      kind: "api",
    },
  });
  expect(result.document.content).toContain("# Buffer");
});

test("docs service resolves a symbol to its canonical document path", () => {
  const docs = createDocsService();

  expect(docs.execute({ operation: "resolve", target: "Buffer" })).toEqual({
    operation: "resolve",
    target: "Buffer",
    symbol: "Buffer",
    package: "vgpu/core",
    virtualPath: "/vgpu/core/buffer.docs.md",
    repoPath: "packages/core/src/buffer.docs.md",
    kind: "api",
  });
});

test("docs service reports ambiguous symbols with actionable candidates", () => {
  const docs = createDocsService();

  expect(() => docs.execute({ operation: "resolve", target: "Uniform" })).toThrow(
    expect.objectContaining({
      code: "VGPU-DOCS-AMBIGUOUS",
      target: "Uniform",
      candidates: [
        {
          symbol: "Uniform",
          package: "vgpu/core",
          virtualPath: "/vgpu/core/uniform.docs.md",
          repoPath: "packages/vgpu-api/src/core/uniform.docs.md",
          kind: "api",
        },
        {
          symbol: "Uniform",
          package: "vgpu",
          virtualPath: "/vgpu/uniform.docs.md",
          repoPath: "packages/vgpu-api/src/core/uniform.docs.md",
          kind: "api",
        },
      ],
    }),
  );
});

test("docs service reports typed not-found errors", () => {
  const docs = createDocsService();

  expect(() => docs.execute({ operation: "read", target: "MissingSymbol" })).toThrow(
    expect.objectContaining({
      code: "VGPU-DOCS-NOT-FOUND",
      target: "MissingSymbol",
      lookup: "symbol",
    }),
  );
});

test("docs service lists a documentation directory without CLI-only hints", () => {
  const docs = createDocsService();

  expect(docs.execute({ operation: "list", path: "/" })).toMatchObject({
    operation: "list",
    path: "/",
    entries: expect.arrayContaining(["/guides", "/vgpu", "/vgpu/core"]),
  });
  expect(docs.execute({ operation: "list", path: "/" }).entries).not.toContainEqual(
    expect.stringContaining("Tip:"),
  );
});

test("docs service greps document bodies into bounded structured matches", () => {
  const docs = createDocsService();

  const result = docs.execute({
    operation: "grep",
    pattern: "# Buffer",
    package: "vgpu/core",
    limit: 1,
  });

  expect(result).toEqual({
    operation: "grep",
    pattern: "# Buffer",
    truncated: false,
    matches: [
      {
        virtualPath: "/vgpu/core/buffer.docs.md",
        line: 1,
        text: "# Buffer",
      },
    ],
  });
});

test("docs service enumerates filterable symbols as structured records", () => {
  const docs = createDocsService();

  const result = docs.execute({
    operation: "symbols",
    query: "Buffer",
    package: "vgpu/core",
    limit: 1,
  });

  expect(result).toEqual({
    operation: "symbols",
    truncated: true,
    symbols: [
      {
        symbol: "Buffer",
        package: "vgpu/core",
        virtualPath: "/vgpu/core/buffer.docs.md",
      },
    ],
  });
});

test("the bundled CLI reference documents both MCP transports and their write boundary", () => {
  const docs = createDocsService();

  const result = docs.execute({ operation: "read", target: "cli" });

  expect(result.document.content).toContain("## mcp");
  expect(result.document.content).toContain("https://vgpu.sh/api/mcp");
  expect(result.document.content).toContain("npx vgpu mcp --project-from-cwd");
  expect(result.document.content).toContain("download");
});

test("the project-scoped Codex MCP example follows the active workspace cwd", () => {
  const docs = createDocsService();
  const result = docs.execute({ operation: "read", target: "cli" });
  const block = result.document.content.match(
    /Codex[^\n]*project-scoped[^\n]*:\n\n```toml\n([\s\S]*?)```/u,
  );

  expect(block?.[1]).toContain('args = ["-y", "vgpu", "mcp", "--project-from-cwd"]');
  expect(block?.[1]).not.toContain("cwd =");
  expect(result.document.content).toContain("npx vgpu mcp --output-dir /absolute/path/to/project");
  expect(result.document.content).toContain(
    "when Codex launches the MCP process from the active workspace",
  );
  expect(result.document.content).toContain(
    "Claude Code and Codex MCP configurations load inside Conductor",
  );
  expect(result.document.content).toContain(
    "Cursor reads `.cursor/mcp.json` only after you open the Conductor workspace in Cursor",
  );
  expect(result.document.content).not.toContain(
    "Conductor inherits the selected Claude Code, Codex, or Cursor MCP configuration",
  );
});
