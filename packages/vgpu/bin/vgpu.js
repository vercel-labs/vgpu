#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDocs } from "../lib/docs/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));
const VERSION = packageJson.version;

const help = `vgpu ${VERSION}

Official VGPU CLI.

Commands:
  docs       Explore bundled VGPU documentation
  doctor     Coming soon
  wgsl       Coming soon

Runtime libraries are available under @vgpu/*:
  - @vgpu/core
  - @vgpu/render
  - @vgpu/wgsl
  - @vgpu/adapter-mock
  - @vgpu/adapter-node

Run \`vgpu docs --help\` for docs commands.
`;

const comingSoon = (command) => `vgpu ${command} is coming soon.

This package currently ships docs lookup first. For now, use the @vgpu/* runtime libraries directly.
Run \`vgpu --help\` for details.
`;

export function runCli(args) {
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "-h") return { code: 0, stdout: help };
  if (command === "--version" || command === "-v") return { code: 0, stdout: `${VERSION}\n` };
  if (command === "docs") return runDocs(rest);
  if (command === "doctor" || command === "wgsl") return { code: 1, stderr: comingSoon(command) };
  return { code: 1, stderr: `Unknown vgpu command: ${command}\n\n${help}` };
}

if (isMain()) {
  const result = runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

function isMain() {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}
