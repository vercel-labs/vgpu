#!/usr/bin/env node

let runCli;
try {
  ({ runCli } = await import("../dist/cli/bin/vgpu.js"));
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND") {
    process.stderr.write("vgpu CLI is not built. Run `pnpm build` before using it from a workspace checkout.\n");
    process.exitCode = 1;
  } else {
    throw error;
  }
}

if (runCli) {
  const result = await Promise.resolve(runCli(process.argv.slice(2)));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
