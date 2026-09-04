#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "../lib/check/run.js";
import { runDocs } from "../lib/docs/run.js";
import { runDoctor } from "../lib/doctor/run.js";
import { runInstallDawn } from "../lib/install-dawn/run.js";
import { runInstallSoftwareRenderer } from "../lib/install-software-renderer/run.js";
import { runSnapshotCommand } from "../lib/snapshot/run.js";
import { runExamples } from "../lib/examples/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));

// In-repo, `../package.json` is packages/vgpu/package.json (`@vgpu/cli`): private, never published,
// versioned independently of the public `vgpu` package and known to drift from it (see
// CONTRIBUTING.md). Reporting that version made every in-repo `vgpu examples ...` call fail the
// server handshake with VGPU-EXAMPLES-CLI-TOO-OLD, so resolve the public version from the sibling
// `vgpu-api` package instead and degrade to the CLI package version for an incomplete checkout.
//
// In the published tarball, `../package.json` is the synthetic `{type,version}` stamp written by
// packages/vgpu-api/scripts/copy-cli.mjs, which has no `name` field, so this branch is dead code
// there and the published version keeps coming from the stamp (guarded by a unit test).
export function resolveVersion(dir, pkg) {
  if (pkg.name === "@vgpu/cli") {
    try {
      const apiPackageJson = JSON.parse(readFileSync(resolve(dir, "../../vgpu-api/package.json"), "utf8"));
      return apiPackageJson.version;
    } catch {
      // Incomplete checkout (sparse clone, deleted sibling): degrade to our own version, never crash.
      return pkg.version;
    }
  }
  return pkg.version;
}

const VERSION = resolveVersion(here, packageJson);

const help = `vgpu ${VERSION}

TypeScript library for WebGPU: typed shader imports, a tiny gpu-first API, and
the same code running in the browser, headless Node, and your test suite.

## Read the docs
  npx vgpu docs cat getting-started.md    The guide for using the current API correctly
  npx vgpu docs find "<topic | symbol | VGPU-error-code>"
  npx vgpu docs cat <path>

## Validate shader code
  npx vgpu check <file.wgsl>              Validate and reflect a WGSL file as JSON
  npx vgpu check <file.wgsl> --require-validation
                                          Fail instead of skipping when no WebGPU device is available

## Working examples
  npx vgpu examples search "<topic>"
  npx vgpu examples pull <slug> --out <dir>

## Agent tools (MCP)
  npx vgpu mcp                           Serve docs and examples over stdio

## Node rendering environment
  npx vgpu doctor
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
  if (command === "examples") return runExamples(rest, { version: VERSION });
  if (command === "mcp") {
    return import("../lib/mcp/stdio.js").then(({ runMcpStdio }) => runMcpStdio(rest, { version: VERSION }));
  }
  if (command === "snapshot") return runSnapshotCommand({ args: rest });
  if (command === "install-dawn") return runInstallDawn(rest);
  if (command === "install-software-renderer") return runInstallSoftwareRenderer(rest);
  if (command === "doctor") return runDoctor(rest);
  if (command === "wgsl") return { code: 1, stderr: comingSoon(command) };
  return { code: 2, stderr: `Unknown command: ${command}\n\n${help}` };
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
