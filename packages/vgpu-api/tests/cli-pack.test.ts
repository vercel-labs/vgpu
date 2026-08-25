import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { startExamplesFixture } from "../../vgpu/tests/examples-fixture.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageDir, "../..");
const cliDir = resolve(workspaceRoot, "packages/vgpu");

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("vgpu owns the CLI bin and the internal CLI cannot be published", () => {
  const vgpu = readJson(resolve(packageDir, "package.json"));
  const cli = readJson(resolve(workspaceRoot, "packages/vgpu/package.json"));

  expect(vgpu.bin).toEqual({ vgpu: "./bin/vgpu.js" });
  expect(vgpu.exports["./package.json"]).toBe("./package.json");
  expect(existsSync(resolve(packageDir, "bin/vgpu.js"))).toBe(true);
  expect(cli.name).toBe("@vgpu/cli");
  expect(cli.private).toBe(true);
});

test("the vgpu tarball includes the full internal CLI", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
  });
  const [pack] = JSON.parse(output.slice(output.indexOf("[")));
  const files = pack.files.map((file: { path: string }) => file.path);

  expect(files).toContain("bin/vgpu.js");
  expect(files).toContain("dist/cli/bin/vgpu.js");
  expect(files).toContain("dist/cli/lib/generated/docs-manifest.generated.js");
  expect(files).toContain("dist/cli/lib/examples/run.js");
  expect(files).toContain("dist/cli/lib/examples/local-service.js");
  expect(files).toContain("dist/cli/lib/examples/service.js");
  expect(files).toContain("dist/cli/lib/examples/schemas/v1/discovery.schema.json");
  expect(files).toContain("dist/cli/lib/docs/service.js");
  expect(files).toContain("dist/cli/lib/mcp/server.js");
  expect(files).toContain("dist/cli/lib/mcp/stdio.js");
  expect(readJson(resolve(packageDir, "package.json")).dependencies).toMatchObject({
    "@modelcontextprotocol/server": "2.0.0",
    zod: expect.any(String),
  });
});

test("generating docs refreshes the public CLI guide manifest", () => {
  execFileSync("pnpm", ["--dir", cliDir, "generate:docs"], {
    cwd: workspaceRoot,
    stdio: "pipe",
  });

  const list = execFileSync("node", ["bin/vgpu.js", "docs", "ls", "/guides"], {
    cwd: packageDir,
    encoding: "utf8",
  });
  expect(list).toContain("shader-workflow.docs.md");
  expect(list).toContain("shader-debugging.docs.md");

  for (const [guide, heading] of [
    ["shader-workflow.md", "# The default workflow for developing shaders with vgpu"],
    ["shader-debugging.md", "# Debugging shaders by extracting internal values"],
  ]) {
    const output = execFileSync("node", ["bin/vgpu.js", "docs", "cat", guide], {
      cwd: packageDir,
      encoding: "utf8",
    });
    expect(output).toContain(heading);
  }
});

test("the isolated public tarball serves its packaged MCP entrypoint", async () => {
  execFileSync("node", ["scripts/copy-cli.mjs"], { cwd: packageDir, stdio: "pipe" });
  const temporary = await mkdtemp(join(tmpdir(), "vgpu-packed-cli-"));
  let closeFixture: (() => Promise<void>) | undefined;
  try {
    const dependencyClosure = join(temporary, "dependency-closure");
    execFileSync("pnpm", ["--filter", "vgpu", "deploy", "--prod", dependencyClosure], {
      cwd: workspaceRoot,
      stdio: "pipe",
    });
    const archiveName = execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: packageDir, encoding: "utf8" },
    ).trim().split("\n").at(-1);
    if (!archiveName) throw new Error("npm pack did not produce an archive");
    const runtime = join(temporary, "runtime");
    await mkdir(runtime);
    execFileSync(
      "tar",
      ["-xzf", join(temporary, archiveName), "--strip-components=1", "-C", runtime],
      { stdio: "pipe" },
    );
    await rename(join(dependencyClosure, "node_modules"), join(runtime, "node_modules"));

    for (const dependency of ["@modelcontextprotocol/server", "zod"]) {
      expect(realpathSync(join(runtime, "node_modules", dependency)).startsWith(realpathSync(runtime))).toBe(true);
    }
    const fixture = await startExamplesFixture();
    closeFixture = fixture.close;
    const client = new Client({ name: "vgpu-packed-cli-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(runtime, "bin/vgpu.js"), "mcp", "--output-dir", temporary],
      cwd: temporary,
      env: {
        ...getDefaultEnvironment(),
        VGPU_CACHE_DIR: join(temporary, "cache"),
        VGPU_EXAMPLES_BASE_URL: fixture.origin,
      },
      stderr: "pipe",
    });

    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.version).toBe(readJson(resolve(packageDir, "package.json")).version);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["docs", "examples"]);
      if (["linux", "darwin"].includes(process.platform)) {
        const downloaded = await client.callTool({
          name: "examples",
          arguments: { operation: "download", id: "gradient", destination: "packed-download" },
        });
        expect(downloaded.isError).not.toBe(true);
        expect(downloaded.structuredContent).toMatchObject({
          operation: "download",
          destination: join(realpathSync(temporary), "packed-download"),
          files: 1,
          bytes: fixture.source.byteLength,
        });
        expect(await readFile(join(temporary, "packed-download", "example.ts"), "utf8"))
          .toBe(fixture.source.toString("utf8"));
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    await closeFixture?.().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
});
