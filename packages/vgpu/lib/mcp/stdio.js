import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createDocsService } from "../docs/service.js";
import { ExamplesCache, cacheRoot } from "../examples/cache.js";
import { ExamplesClient } from "../examples/client.js";
import { createLocalExamplesService } from "../examples/local-service.js";
import { createExamplesService } from "../examples/service.js";
import { createVgpuMcpServer } from "./server.js";

export const mcpHelp = `Usage: vgpu mcp [--output-dir <absolute-directory> | --project-from-cwd]

Serve VGPU documentation and examples over MCP stdio. On Linux and macOS, the
examples tool may download into a new relative directory beneath an explicitly
configured output directory. Bare invocation is read-only. VGPU_MCP_OUTPUT_DIR
is the environment-variable alternative to --output-dir.
`;

export function runMcpStdio(
  args,
  {
    version = "0.0.0",
    cwd = process.cwd(),
    env = process.env,
    fetchImpl = fetch,
    now = () => new Date(),
    platform = process.platform,
    reportError = (error) => process.stderr.write(`vgpu mcp: ${error.message}\n`),
  } = {},
) {
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0])) {
    return { code: 0, stdout: mcpHelp };
  }
  const usesOutputDirectory = args.length === 2 && args[0] === "--output-dir" && !!args[1];
  const usesProjectCwd = args.length === 1 && args[0] === "--project-from-cwd";
  if (args.length !== 0 && !usesOutputDirectory && !usesProjectCwd) {
    return { code: 2, stderr: mcpHelp };
  }

  const configuredOutputDirectory = usesOutputDirectory
    ? args[1]
    : usesProjectCwd
      ? undefined
      : env.VGPU_MCP_OUTPUT_DIR;
  if (configuredOutputDirectory && !isAbsolute(configuredOutputDirectory)) {
    return { code: 2, stderr: `MCP output directory must be absolute: ${configuredOutputDirectory}\n` };
  }
  let downloadRoot = usesProjectCwd ? cwd : configuredOutputDirectory;
  if (downloadRoot) {
    try {
      downloadRoot = realpathSync(downloadRoot);
      if (!statSync(downloadRoot).isDirectory()) throw new Error("not a directory");
    } catch {
      return { code: 2, stderr: `MCP output directory is not a directory: ${downloadRoot}\n` };
    }
  }

  const source = new ExamplesClient({
    baseUrl: env.VGPU_EXAMPLES_BASE_URL || "https://vgpu.sh",
    fetchImpl,
    cache: new ExamplesCache(cacheRoot(env), { platform }),
    cliVersion: version,
    now,
    warn: (warning) => process.stderr.write(warning),
  });
  const docs = createDocsService();
  const allowDownload = !!downloadRoot && (platform === "linux" || platform === "darwin");
  const examples = allowDownload
    ? createLocalExamplesService({ source, downloadRoot, platform })
    : createExamplesService({ source });
  serveStdio(
    () => createVgpuMcpServer({ version, docs, examples, allowDownload, examplesOpenWorld: true }),
    { onerror: reportError },
  );
  return { code: 0 };
}
