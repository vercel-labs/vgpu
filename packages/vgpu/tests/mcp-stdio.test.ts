import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { startExamplesFixture } from "./examples-fixture.js";

const cliPath = fileURLToPath(new URL("../bin/vgpu.js", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const supportsDownload = ["linux", "darwin"].includes(process.platform);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function connectStdio({
  args = [],
  cwd = workspaceRoot,
  env,
  nodeArgs = [],
}: {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  nodeArgs?: string[];
} = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...nodeArgs, cliPath, "mcp", ...args],
    cwd,
    env: env && { ...getDefaultEnvironment(), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "vgpu-stdio-test", version: "1.0.0" });
  cleanups.push(() => client.close().catch(() => undefined));
  await client.connect(transport);
  return client;
}

test("bare vgpu mcp serves docs and read-only examples over stdio", async () => {
  const client = await connectStdio();
  const listed = await client.listTools();
  expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["docs", "examples"]);
  expect(JSON.stringify(listed.tools.find((tool) => tool.name === "examples")?.inputSchema))
    .not.toContain('"download"');
});

test("vgpu mcp does not advertise download when the platform cannot publish safely", async () => {
  const root = await temporaryDirectory("vgpu-mcp-windows-");
  const nodeArgs: string[] = [];
  if (process.platform !== "win32") {
    const preload = join(root, "windows-platform.mjs");
    await writeFile(preload, 'Object.defineProperty(process, "platform", { value: "win32" });\n');
    nodeArgs.push("--import", preload);
  }
  const client = await connectStdio({
    args: ["--output-dir", root],
    nodeArgs,
  });
  const examples = (await client.listTools()).tools.find((tool) => tool.name === "examples");
  expect(examples?.annotations?.readOnlyHint).toBe(true);
  expect(examples?.annotations?.openWorldHint).toBe(true);
  const schema = JSON.stringify(examples?.inputSchema);
  expect(schema).toContain('"offline"');
  expect(schema).not.toContain('"download"');
});

test.runIf(supportsDownload)(
  "vgpu mcp advertises download when explicitly configured from cwd",
  async () => {
    const root = await temporaryDirectory("vgpu-mcp-project-cwd-");
    const client = await connectStdio({
      args: ["--project-from-cwd"],
      cwd: root,
      env: { VGPU_MCP_OUTPUT_DIR: "ignored-relative-value" },
    });
    const examples = (await client.listTools()).tools.find((tool) => tool.name === "examples");
    expect(JSON.stringify(examples?.inputSchema)).toContain('"download"');
  },
);

test.runIf(supportsDownload)(
  "vgpu mcp uses VGPU_MCP_OUTPUT_DIR when no CLI selector is supplied",
  async () => {
    const root = await temporaryDirectory("vgpu-mcp-output-env-");
    const client = await connectStdio({
      env: { VGPU_MCP_OUTPUT_DIR: root },
    });
    const examples = (await client.listTools()).tools.find((tool) => tool.name === "examples");
    expect(JSON.stringify(examples?.inputSchema)).toContain('"download"');
  },
);

test.runIf(supportsDownload)(
  "explicit output directory overrides the environment and downloads beneath its canonical target",
  async () => {
    const root = await temporaryDirectory("vgpu-mcp-download-e2e-");
    const canonicalRoot = join(root, "output");
    const outputAlias = join(root, "output-alias");
    await mkdir(canonicalRoot);
    await symlink(canonicalRoot, outputAlias, "dir");
    const fixture = await startExamplesFixture();
    cleanups.push(fixture.close);
    const client = await connectStdio({
      args: ["--output-dir", outputAlias],
      env: {
        VGPU_CACHE_DIR: join(root, "cache"),
        VGPU_EXAMPLES_BASE_URL: fixture.origin,
        VGPU_MCP_OUTPUT_DIR: "ignored-relative-value",
      },
    });
    const examples = (await client.listTools()).tools.find((tool) => tool.name === "examples");
    expect(examples?.annotations?.readOnlyHint).toBe(false);
    expect(JSON.stringify(examples?.inputSchema)).toContain('"download"');

    const result = await client.callTool({
      name: "examples",
      arguments: { operation: "download", id: "gradient", destination: "downloaded" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      operation: "download",
      id: "gradient",
      destination: join(await realpath(canonicalRoot), "downloaded"),
      files: 1,
      bytes: fixture.source.byteLength,
    });
    expect(await readFile(join(canonicalRoot, "downloaded", "example.ts"), "utf8"))
      .toBe(fixture.source.toString("utf8"));
  },
);
