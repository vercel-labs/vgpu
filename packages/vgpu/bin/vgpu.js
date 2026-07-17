#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "../lib/check/run.js";
import { runDocs } from "../lib/docs/run.js";
import { runSnapshotCommand } from "../lib/snapshot/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));
const VERSION = packageJson.version;

const help = `vgpu ${VERSION}

Official VGPU CLI.

Commands:
  check      Validate and reflect a WGSL file as JSON
  docs       Explore bundled VGPU documentation
  snapshot   Compare the representative GPU pixel snapshot
  doctor     Coming soon
  wgsl       Coming soon

Primary runtime entrypoints:
  - vgpu
  - vgpu/node
  - vgpu/mock
  - vgpu/scene
  - vgpu/client

Slim tooling subpaths:
  - @vgpu/render/inspect
  - @vgpu/render/utils
  - @vgpu/render/edit
  - @vgpu/render/perf

WGSL and adapter packages:
  - @vgpu/wgsl
  - @vgpu/adapter-mock
  - @vgpu/adapter-node

Run \`vgpu docs --help\` for docs commands.
`;

const comingSoon = (command) => `vgpu ${command} is coming soon.

This package currently ships docs lookup first. Use vgpu, vgpu/node, vgpu/mock,
vgpu/scene, and the documented slim tooling subpaths. Run \`vgpu --help\` for details.
`;

export function runCli(args) {
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "-h") return { code: 0, stdout: help };
  if (command === "--version" || command === "-v") return { code: 0, stdout: `${VERSION}\n` };
  if (command === "check") return runCheck(rest);
  if (command === "docs") return runDocs(rest);
  if (command === "snapshot") return runSnapshotCommand({ args: rest });
  if (command === "doctor" || command === "wgsl") return { code: 1, stderr: comingSoon(command) };
  return { code: 1, stderr: `Unknown vgpu command: ${command}\n\n${help}` };
}

if (isMain()) {
  const result = await Promise.resolve(runCli(process.argv.slice(2)));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

function isMain() {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}
