#!/usr/bin/env node
import { existsSync } from "node:fs";

const cliUrl = new URL("../dist/cli/bin/vgpu.js", import.meta.url);

if (!existsSync(cliUrl)) {
  process.stderr.write("vgpu CLI is not built. Run `pnpm build` before using it from a workspace checkout.\n");
  process.exit(1);
}

const { runCli } = await import(cliUrl.href);
const result = await Promise.resolve(runCli(process.argv.slice(2)));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.code;
