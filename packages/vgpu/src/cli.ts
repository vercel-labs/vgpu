#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { rootHelp } from "./docs/help.ts";
import { runDocs } from "./docs/run.ts";
import type { CommandResult } from "./docs/model.ts";

export function runCli(args: string[]): CommandResult {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { code: 0, stdout: `${rootHelp}\n` };
  }
  if (command === "docs") return runDocs(rest);
  return { code: 1, stderr: `Unknown command: ${command}\n\n${rootHelp}\n` };
}

if (isMain()) {
  const result = runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));
}
