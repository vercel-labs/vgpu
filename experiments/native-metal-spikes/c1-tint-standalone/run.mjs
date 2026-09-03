#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const artifactsDir = join(fixtureDir, ".artifacts");
const manifest = JSON.parse(
  readFileSync(join(fixtureDir, "provenance/releases.json"), "utf8")
);

function usage() {
  console.error(
    "Usage: node run.mjs --release-root <extracted-release-dir> [--archive <release.tar.gz>]"
  );
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    }
    if (argument !== "--release-root" && argument !== "--archive") {
      usage();
      process.exit(64);
    }
    const value = arguments_[index + 1];
    if (!value) {
      usage();
      process.exit(64);
    }
    options[argument === "--release-root" ? "releaseRoot" : "archive"] = value;
    index += 1;
  }
  if (!options.releaseRoot) {
    usage();
    process.exit(64);
  }
  return options;
}

function sha256(pathname) {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function compareVersions(left, right) {
  const normalize = (value) =>
    value.split(".").map((part) => Number.parseInt(part, 10));
  const leftParts = normalize(left);
  const rightParts = normalize(right);
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function finish(status, details, exitCode) {
  const result = { schemaVersion: 1, status, ...details };
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(
    join(artifactsDir, "observed.json"),
    `${JSON.stringify(result, null, 2)}\n`
  );
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (exitCode === 0) process.stdout.write(output);
  else process.stderr.write(output);
  process.exit(exitCode);
}

const options = parseArguments(process.argv.slice(2));

if (process.platform !== "darwin" || process.arch !== "arm64") {
  finish(
    "skipped",
    { reason: "The verified official binaries require a Darwin arm64 host." },
    2
  );
}

const releaseRoot = resolve(options.releaseRoot);
const tintPath = join(releaseRoot, "bin/tint");
if (!existsSync(tintPath)) {
  finish(
    "skipped",
    { reason: "The extracted release does not contain bin/tint." },
    2
  );
}

const tintHash = sha256(tintPath);
const release = manifest.releases.find(
  (candidate) => candidate.files["bin/tint"].sha256 === tintHash
);
if (!release) {
  finish(
    "failed",
    {
      reason: "bin/tint does not match any recorded official release hash.",
      tintHash,
    },
    1
  );
}

const expectedTint = release.files["bin/tint"];
if (statSync(tintPath).size !== expectedTint.bytes) {
  finish(
    "failed",
    {
      reason: "bin/tint size does not match the provenance manifest.",
      release: release.tag,
    },
    1
  );
}

let archiveVerification = "not-provided";
if (options.archive) {
  const archivePath = resolve(options.archive);
  if (!existsSync(archivePath)) {
    finish(
      "skipped",
      { reason: "The requested release archive does not exist." },
      2
    );
  }
  const archiveHash = sha256(archivePath);
  if (
    archiveHash !== release.archive.sha256 ||
    statSync(archivePath).size !== release.archive.bytes
  ) {
    finish(
      "failed",
      {
        reason: "The archive does not match the selected official release.",
        release: release.tag,
      },
      1
    );
  }
  archiveVerification = "verified";
}

const otool = spawnSync("otool", ["-l", tintPath], { encoding: "utf8" });
if (otool.error?.code === "ENOENT") {
  finish("skipped", { reason: "Missing prerequisite: otool." }, 2);
}
if (otool.status !== 0) {
  finish(
    "failed",
    { reason: "otool could not inspect bin/tint.", release: release.tag },
    1
  );
}
const minimumMatch = otool.stdout.match(/\bminos\s+([0-9.]+)/);
const observedMinimum = minimumMatch?.[1];
if (observedMinimum !== release.observedPlatform.minimumMacOS) {
  finish(
    "failed",
    {
      reason:
        "The Mach-O deployment target does not match the provenance manifest.",
      release: release.tag,
      observedMinimum,
    },
    1
  );
}

const swVers = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" });
if (swVers.error?.code === "ENOENT") {
  finish("skipped", { reason: "Missing prerequisite: sw_vers." }, 2);
}
if (swVers.status !== 0) {
  finish(
    "skipped",
    { reason: "Could not determine the host macOS version." },
    2
  );
}
const hostVersion = swVers.stdout.trim();
if (compareVersions(hostVersion, observedMinimum) < 0) {
  finish(
    "skipped",
    {
      reason: `The release requires macOS ${observedMinimum} or newer.`,
      release: release.tag,
      hostVersion,
    },
    2
  );
}

const tests = [
  {
    id: "binding-slots/main",
    source: "binding-slots.wgsl",
    entryPoint: "main",
  },
  {
    id: "multiple-entry-points/clear",
    source: "multiple-entry-points.wgsl",
    entryPoint: "clear",
  },
  {
    id: "multiple-entry-points/increment",
    source: "multiple-entry-points.wgsl",
    entryPoint: "increment",
  },
  {
    id: "multiple-entry-points/vertex",
    source: "multiple-entry-points.wgsl",
    entryPoint: "vs_main",
  },
  {
    id: "multiple-entry-points/fragment",
    source: "multiple-entry-points.wgsl",
    entryPoint: "fs_main",
  },
  {
    id: "typed-overrides/main",
    source: "typed-overrides.wgsl",
    entryPoint: "main",
    overrides: "GAIN=2.5,WG_X=4,ENABLED=1",
  },
  {
    id: "uniform-standard-layout/main",
    source: "uniform-standard-layout.wgsl",
    entryPoint: "main",
  },
  {
    id: "invalid/main",
    source: "invalid.wgsl",
    entryPoint: "main",
    expectFailure: true,
  },
];

const normalizeDiagnostic = (text) =>
  text
    .replaceAll(releaseRoot, "<release-root>")
    .replaceAll(fixtureDir, "<fixture-dir>")
    .replaceAll("\\", "/")
    .replaceAll("\r\n", "\n");

mkdirSync(join(artifactsDir, "msl"), { recursive: true });
const results = [];

for (const test of tests) {
  const safeName = test.id.replaceAll("/", "-");
  const sourcePath = join(fixtureDir, "canaries", test.source);
  const outputPaths = [
    join(artifactsDir, "msl", `${safeName}.first.metal`),
    join(artifactsDir, "msl", `${safeName}.second.metal`),
  ];
  const attempts = outputPaths.map((outputPath) => {
    rmSync(outputPath, { force: true });
    const arguments_ = [
      "--format",
      "msl",
      "--entry-point",
      test.entryPoint,
      "--msl-version",
      "2.4",
      "--output-name",
      outputPath,
    ];
    if (test.overrides) arguments_.push("--overrides", test.overrides);
    arguments_.push(sourcePath);
    return spawnSync(tintPath, arguments_, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  });

  const exits = attempts.map((attempt) => attempt.status);
  const signals = attempts.map((attempt) => attempt.signal);
  const spawnErrors = attempts.map((attempt) => attempt.error?.code ?? null);
  const completedNormally = attempts.every(
    (attempt) => !attempt.error && attempt.signal === null
  );
  const expectedOutcome = test.expectFailure
    ? completedNormally && exits.every((status) => status === 1)
    : completedNormally && exits.every((status) => status === 0);
  let deterministic = false;
  let outputSha256;
  let diagnosticSha256;

  if (test.expectFailure) {
    const diagnostics = attempts.map((attempt) =>
      normalizeDiagnostic(`${attempt.stdout}${attempt.stderr}`)
    );
    deterministic =
      diagnostics[0] === diagnostics[1] && diagnostics[0].length > 0;
    diagnosticSha256 = createHash("sha256")
      .update(diagnostics[0])
      .digest("hex");
  } else if (outputPaths.every(existsSync)) {
    const outputs = outputPaths.map((outputPath) => readFileSync(outputPath));
    deterministic = outputs[0].equals(outputs[1]) && outputs[0].length > 0;
    outputSha256 = createHash("sha256").update(outputs[0]).digest("hex");
  }

  results.push({
    id: test.id,
    expected: test.expectFailure ? "failure" : "success",
    exits,
    signals,
    spawnErrors,
    deterministic,
    outputSha256,
    diagnosticSha256,
    passed: expectedOutcome && deterministic,
  });
}

const failures = results.filter((result) => !result.passed);
finish(
  failures.length === 0 ? "passed" : "failed",
  {
    release: {
      tag: release.tag,
      commit: release.commit,
      tintSha256: tintHash,
      minimumMacOS: observedMinimum,
      archiveVerification,
    },
    tests: results,
    summary: {
      attempted: results.length,
      passed: results.length - failures.length,
      failed: failures.length,
    },
    limitations: [
      "Exercises the official stock CLI, not the C++ wrapper prototype.",
      "Does not invoke Apple's metal or metallib tools.",
    ],
  },
  failures.length === 0 ? 0 : 1
);
