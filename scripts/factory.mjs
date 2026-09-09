#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_USAGE = 2;
const MINIMUM_NODE_MAJOR = 24;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const triageRunner = path.join(
  repositoryRoot,
  "apps",
  "factory",
  "scripts",
  "triage.ts"
);

function usage() {
  return `Usage:
  pnpm factory triage --issue <number> --dry-run [--json]
  pnpm factory triage --fixture <repo-relative.json> --dry-run [--json]`;
}

function failUsage(message) {
  console.error(`factory: ${message}`);
  console.error(usage());
  process.exit(EXIT_USAGE);
}

function validateNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);

  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    console.error(
      `factory: Node.js ${MINIMUM_NODE_MAJOR} or newer is required; current version is ${process.versions.node}.`
    );
    process.exit(EXIT_USAGE);
  }
}

function validateArguments(argv) {
  if (argv.length === 0) {
    failUsage('missing command; expected "triage".');
  }

  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(usage());
    process.exit(0);
  }

  const [command, ...options] = argv;
  if (command !== "triage") {
    failUsage(`unknown command ${JSON.stringify(command)}; expected "triage".`);
  }

  if (options.includes("--help") || options.includes("-h")) {
    if (options.length !== 1) {
      failUsage("--help cannot be combined with triage options.");
    }
    console.log(usage());
    process.exit(0);
  }

  let issue;
  let fixture;
  let dryRun = false;
  let json = false;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];

    if (option === "--issue" || option === "--fixture") {
      const value = options[index + 1];
      if (value === undefined || value.startsWith("--")) {
        failUsage(`${option} requires a value.`);
      }

      if (option === "--issue") {
        if (issue !== undefined) {
          failUsage("--issue may be provided only once.");
        }
        issue = value;
      } else {
        if (fixture !== undefined) {
          failUsage("--fixture may be provided only once.");
        }
        fixture = value;
      }

      index += 1;
      continue;
    }

    if (option === "--dry-run") {
      if (dryRun) {
        failUsage("--dry-run may be provided only once.");
      }
      dryRun = true;
      continue;
    }

    if (option === "--json") {
      if (json) {
        failUsage("--json may be provided only once.");
      }
      json = true;
      continue;
    }

    failUsage(`unknown option ${JSON.stringify(option)}.`);
  }

  if ((issue === undefined) === (fixture === undefined)) {
    failUsage("provide exactly one of --issue or --fixture.");
  }

  if (
    issue !== undefined &&
    (!/^[1-9]\d*$/.test(issue) || !Number.isSafeInteger(Number(issue)))
  ) {
    failUsage("--issue must be a positive safe integer.");
  }

  if (fixture !== undefined) {
    const normalized = path.normalize(fixture);
    if (
      path.isAbsolute(fixture) ||
      normalized === ".." ||
      normalized.startsWith(`..${path.sep}`) ||
      path.extname(normalized) !== ".json"
    ) {
      failUsage(
        "--fixture must be a repo-relative .json path without parent traversal."
      );
    }
  }

  if (!dryRun) {
    failUsage("--dry-run is required; the factory has no mutation mode.");
  }

  return [command, ...options];
}

validateNodeVersion();
const runnerArguments = validateArguments(process.argv.slice(2));

const child = spawn(process.execPath, [triageRunner, ...runnerArguments], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
});

let forwardedSignal;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    forwardedSignal = signal;
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.once("error", (error) => {
  console.error(`factory: failed to start the triage runner: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (typeof code === "number") {
    process.exitCode = code;
    return;
  }

  const exitSignal = signal ?? forwardedSignal;
  process.exitCode =
    exitSignal === "SIGINT" ? 130 : exitSignal === "SIGTERM" ? 143 : 1;
});
