#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const spikeDirectory = dirname(fileURLToPath(import.meta.url));
const expectedTintCommit = "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca";
const metalTarget = "air64-apple-macos14.0";
const entryPoints = [
  "vertex_main",
  "fragment_main",
  "fragment_single",
  "scalar_fragment",
  "sparse_vertex",
  "position_only_vertex",
  "constant_color3_fragment",
  "sparse_mrt_fragment",
  "dual_constant_fragment",
  "missing_interstage_fragment",
  "interpolation_mismatch_fragment",
  "type_mismatch_fragment",
];

function fail(message) {
  throw new Error(`C1 shader I/O projection: ${message}`);
}

function parseArguments(argv) {
  const options = {
    releaseRoot: process.env.C1_SHADER_IO_TINT_RELEASE_ROOT,
    compatInclude: process.env.C1_SHADER_IO_TINT_COMPAT_INCLUDE,
    requireTint: process.env.C1_SHADER_IO_REQUIRE_TINT === "1",
    skipMetalRuntime: process.env.C1_SHADER_IO_SKIP_METAL_RUNTIME === "1",
    requireMetalRuntime: process.env.C1_SHADER_IO_REQUIRE_METAL_RUNTIME === "1",
    requireOfflineMetal: process.env.C1_SHADER_IO_REQUIRE_OFFLINE_METAL === "1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: node run.mjs [--release-root <Dawn release>] " +
          "[--compat-include <header overlay>] [--require-tint] " +
          "[--skip-metal-runtime] [--require-metal-runtime] " +
          "[--require-offline-metal]\n"
      );
      process.exit(0);
    }
    if (argument === "--require-tint") {
      options.requireTint = true;
      continue;
    }
    if (argument === "--skip-metal-runtime") {
      options.skipMetalRuntime = true;
      continue;
    }
    if (argument === "--require-metal-runtime") {
      options.requireMetalRuntime = true;
      continue;
    }
    if (argument === "--require-offline-metal") {
      options.requireOfflineMetal = true;
      continue;
    }
    if (argument === "--release-root" || argument === "--compat-include") {
      const value = argv[++index];
      if (!value) fail(`${argument} requires a value`);
      options[argument === "--release-root" ? "releaseRoot" : "compatInclude"] =
        resolve(value);
      continue;
    }
    fail(`unknown argument ${argument}`);
  }
  if (options.releaseRoot) options.releaseRoot = resolve(options.releaseRoot);
  if (options.compatInclude) {
    options.compatInclude = resolve(options.compatInclude);
  }
  if (options.skipMetalRuntime && options.requireMetalRuntime) {
    fail("--skip-metal-runtime conflicts with --require-metal-runtime");
  }
  if (options.requireMetalRuntime || options.requireOfflineMetal) {
    options.requireTint = true;
  }
  return options;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandFailure(owner, result) {
  const diagnostic = `${result.stdout}${result.stderr}`.trim();
  fail(
    `${owner} failed with ${
      result.signal ? `signal ${result.signal}` : `status ${result.status}`
    }${diagnostic ? `: ${diagnostic}` : ""}`
  );
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function regularFileTree(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push({ path, relativePath: relative(root, path) });
      } else {
        fail(`dependency tree contains non-file entry ${entry.name}`);
      }
    }
  };
  visit(root);
  files.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath, "utf8"),
      Buffer.from(right.relativePath, "utf8")
    )
  );
  return files;
}

function fileTreeFingerprint(root) {
  const files = regularFileTree(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath.split(sep).join("/"), "utf8");
    hash.update("\0", "utf8");
    hash.update(sha256(file.path), "utf8");
    hash.update("\n", "utf8");
  }
  return { files: files.length, sha256: hash.digest("hex") };
}

function validatePinnedTint(releaseRoot, compatInclude) {
  const provenance = JSON.parse(
    readFileSync(
      join(
        spikeDirectory,
        "..",
        "c1-tint-standalone",
        "provenance",
        "releases.json"
      ),
      "utf8"
    )
  );
  const release = provenance.releases?.find(
    (candidate) => candidate.commit === expectedTintCommit
  );
  const expectedLibraryHash = release?.files?.["lib/libwebgpu_dawn.a"]?.sha256;
  const expectedIncludeTree = release?.includeTree;
  const expectedCompilerHeaderHash = provenance.supplementalSource?.sha256;
  if (
    !expectedLibraryHash ||
    expectedIncludeTree?.algorithm !==
      "relative-path-nul-file-sha256-lines-v1" ||
    !Number.isSafeInteger(expectedIncludeTree.files) ||
    !expectedCompilerHeaderHash
  ) {
    fail("pinned Dawn provenance is incomplete");
  }

  const includeRoot = join(releaseRoot, "include");
  const tintInclude = join(includeRoot, "src", "tint");
  const library = join(releaseRoot, "lib", "libwebgpu_dawn.a");
  if (!existsSync(tintInclude) || !existsSync(library)) {
    fail("release root lacks Tint headers or libwebgpu_dawn.a");
  }
  if (sha256(library) !== expectedLibraryHash) {
    fail(`libwebgpu_dawn.a does not match ${expectedTintCommit}`);
  }
  const includeTree = fileTreeFingerprint(includeRoot);
  if (
    includeTree.files !== expectedIncludeTree.files ||
    includeTree.sha256 !== expectedIncludeTree.sha256
  ) {
    fail(`include tree does not match ${expectedTintCommit}`);
  }

  const compilerHeader = compatInclude
    ? join(compatInclude, "src", "utils", "compiler.h")
    : join(includeRoot, "src", "utils", "compiler.h");
  if (!existsSync(compilerHeader)) {
    fail("pinned Dawn release requires its exact compiler.h overlay");
  }
  if (sha256(compilerHeader) !== expectedCompilerHeaderHash) {
    fail(`compiler.h does not match ${expectedTintCommit}`);
  }
  if (compatInclude) {
    const overlay = regularFileTree(compatInclude);
    if (
      overlay.length !== 1 ||
      overlay[0].relativePath.split(sep).join("/") !== "src/utils/compiler.h"
    ) {
      fail("--compat-include must contain only src/utils/compiler.h");
    }
  }
  return { includeRoot, tintInclude, library };
}

function validateTrackedSources() {
  const source = readFileSync(
    join(spikeDirectory, "prototype", "main.cc"),
    "utf8"
  );
  const metal = readFileSync(
    join(spikeDirectory, "prototype", "main.mm"),
    "utf8"
  );
  const wgsl = readFileSync(
    join(spikeDirectory, "canaries", "interfaces.wgsl"),
    "utf8"
  );
  for (const required of [
    "tint::msl::writer::Raise",
    "tint::msl::writer::Print",
    "tint::msl::writer::Generate",
    "raised_ir != post_ir",
    "post_print_ir != raised_ir",
    "printed->msl != msl",
  ]) {
    if (!source.includes(required)) fail(`Tint prototype omitted ${required}`);
  }
  for (const required of [
    "fragment-output-3-descriptor-missing",
    "interstage-interpolation-mismatch",
    "render-fragment-output-3-discarded",
    "render-dual-source-enabled",
    "METAL_GATE_PASS",
  ]) {
    if (!metal.includes(required)) fail(`Metal prototype omitted ${required}`);
  }
  if (
    !wgsl.includes("enable dual_source_blending;") ||
    !wgsl.includes("@location(3) model_position") ||
    !wgsl.includes("@location(7) weight") ||
    !wgsl.includes("@location(0) @blend_src(1)") ||
    !wgsl.includes("@location(4) second")
  ) {
    fail("WGSL canary no longer covers sparse and dual-source interfaces");
  }
  return { entryPoints: entryPoints.length };
}

function compileTintProbe(pinned, compatInclude, output) {
  const compilation = runCommand("xcrun", [
    "clang++",
    "-std=c++20",
    "-O2",
    "-DNDEBUG",
    "-Wall",
    "-Wextra",
    "-Werror",
    ...(compatInclude ? [`-I${compatInclude}`] : []),
    `-I${pinned.tintInclude}`,
    join(spikeDirectory, "prototype", "main.cc"),
    pinned.library,
    "-framework",
    "CoreGraphics",
    "-framework",
    "Foundation",
    "-framework",
    "Metal",
    "-framework",
    "Cocoa",
    "-framework",
    "IOKit",
    "-framework",
    "IOSurface",
    "-framework",
    "QuartzCore",
    "-o",
    output,
  ]);
  if (compilation.error || compilation.signal || compilation.status !== 0) {
    commandFailure("Tint probe compilation", compilation);
  }
}

function expectedTintStdout() {
  const emitted = new Map([
    ["vertex_main", "emitted_vertex"],
    ["fragment_main", "emitted_fragment"],
    ["fragment_single", "emitted_fragment_single"],
    ["scalar_fragment", "emitted_scalar"],
    ["sparse_vertex", "emitted_sparse_vertex"],
    ["position_only_vertex", "emitted_position_only_vertex"],
    ["constant_color3_fragment", "emitted_constant_color3_fragment"],
    ["sparse_mrt_fragment", "emitted_sparse_mrt_fragment"],
    ["dual_constant_fragment", "emitted_dual_constant_fragment"],
    ["missing_interstage_fragment", "emitted_missing_interstage_fragment"],
    [
      "interpolation_mismatch_fragment",
      "emitted_interpolation_mismatch_fragment",
    ],
    ["type_mismatch_fragment", "emitted_type_mismatch_fragment"],
  ]);
  return `${entryPoints
    .map((entry) => `PASS ${entry} -> ${emitted.get(entry)}`)
    .join("\n")}\n`;
}

function runTintProbe(executable, outputDirectory) {
  const attempt = runCommand(executable, [
    join(spikeDirectory, "canaries", "interfaces.wgsl"),
    outputDirectory,
  ]);
  if (attempt.error || attempt.signal || attempt.status !== 0) {
    commandFailure("Tint shader I/O probe", attempt);
  }
  if (attempt.stderr !== "" || attempt.stdout !== expectedTintStdout()) {
    fail("Tint shader I/O probe output drifted");
  }
  const files = regularFileTree(outputDirectory);
  const expectedSuffixes = [
    ".inspector.txt",
    ".metal",
    ".post-print.ir",
    ".post.ir",
    ".pre.ir",
    ".raised.ir",
  ];
  if (files.length !== entryPoints.length * expectedSuffixes.length) {
    fail("Tint shader I/O output file count drifted");
  }
  for (const entry of entryPoints) {
    for (const suffix of expectedSuffixes) {
      if (!existsSync(join(outputDirectory, `${entry}${suffix}`))) {
        fail(`Tint shader I/O probe omitted ${entry}${suffix}`);
      }
    }
  }
  return fileTreeFingerprint(outputDirectory);
}

function compileMetalProbe(output) {
  const compilation = runCommand("xcrun", [
    "clang++",
    "-std=c++20",
    "-O2",
    "-DNDEBUG",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fobjc-arc",
    "-framework",
    "Foundation",
    "-framework",
    "Metal",
    join(spikeDirectory, "prototype", "main.mm"),
    "-o",
    output,
  ]);
  if (compilation.error || compilation.signal || compilation.status !== 0) {
    commandFailure("Metal runtime probe compilation", compilation);
  }
}

function countMatches(value, pattern) {
  return value.match(pattern)?.length ?? 0;
}

function validateMetalOutput(output) {
  if (
    countMatches(output, /^LIBRARY_PASS /gmu) !== entryPoints.length ||
    countMatches(output, /^PIPELINE /gmu) !== 11 ||
    countMatches(output, /^RENDER /gmu) !== 6 ||
    countMatches(output, / pass=1$/gmu) !== 6 ||
    !output.includes(
      "PIPELINE label=interstage-interpolation-mismatch success=1 expected=1"
    ) ||
    !output.includes(
      "PIPELINE label=fragment-output-3-descriptor-missing success=1 expected=1"
    ) ||
    !output.includes(
      "RENDER label=render-fragment-output-3-discarded attachment=0 rgba=0,0,255,255"
    ) ||
    !output.includes(
      "RENDER label=render-dual-source-enabled attachment=0 rgba=32,32,143,102"
    ) ||
    !output.endsWith("METAL_GATE_PASS\n")
  ) {
    fail("Metal runtime shader I/O evidence drifted");
  }
}

function runMetalRuntime(resultsDirectory, scratch, required) {
  if (process.platform !== "darwin") {
    if (required) fail("Metal runtime gate requires macOS");
    return { status: "skipped", reason: "host-is-not-macos" };
  }
  const executable = join(scratch, "metal-runtime-probe");
  compileMetalProbe(executable);
  const attempts = [
    runCommand(executable, [resultsDirectory]),
    runCommand(executable, [resultsDirectory]),
  ];
  if (
    attempts.every(
      (attempt) =>
        attempt.status !== 0 && attempt.stderr.includes("DEVICE_FAIL")
    )
  ) {
    if (required) fail("Metal runtime gate found no default Metal device");
    return { status: "skipped", reason: "no-metal-device" };
  }
  for (const attempt of attempts) {
    if (attempt.error || attempt.signal || attempt.status !== 0) {
      commandFailure("Metal runtime shader I/O probe", attempt);
    }
    if (attempt.stderr !== "") {
      fail(`Metal runtime probe wrote stderr: ${attempt.stderr.trim()}`);
    }
    validateMetalOutput(attempt.stdout);
  }
  if (attempts[0].stdout !== attempts[1].stdout) {
    fail("Metal runtime shader I/O output is not deterministic");
  }
  const device = /^DEVICE name=(.+?) registryID=/mu.exec(
    attempts[0].stdout
  )?.[1];
  if (!device) fail("Metal runtime output omitted device identity");
  return {
    status: "passed",
    deterministicRuns: 2,
    libraries: entryPoints.length,
    pipelines: 11,
    readbacks: 6,
    device,
  };
}

function xcrunToolWorks(tool) {
  const lookup = runCommand("xcrun", ["--find", tool]);
  if (
    lookup.error ||
    lookup.signal ||
    lookup.status !== 0 ||
    lookup.stdout.trim() === ""
  ) {
    return false;
  }
  const version = runCommand("xcrun", [tool, "--version"]);
  return !version.error && !version.signal && version.status === 0;
}

function runOfflineMetal(resultsDirectory, scratch, required) {
  if (process.platform !== "darwin") {
    if (required) fail("offline Metal gate requires macOS");
    return { status: "skipped", reason: "host-is-not-macos" };
  }
  const missing = ["metal", "metallib"].filter((tool) => !xcrunToolWorks(tool));
  if (missing.length > 0) {
    if (required) {
      fail(`offline Metal gate requires: ${missing.join(", ")}`);
    }
    return {
      status: "skipped",
      reason: `missing-xcrun-tools:${missing.join(",")}`,
    };
  }

  const airFiles = [];
  for (const entry of entryPoints) {
    const air = join(scratch, `${entry}.air`);
    const compilation = runCommand("xcrun", [
      "-sdk",
      "macosx",
      "metal",
      "-c",
      join(resultsDirectory, `${entry}.metal`),
      "-o",
      air,
      "-std=macos-metal2.4",
      "-target",
      metalTarget,
    ]);
    if (compilation.error || compilation.signal || compilation.status !== 0) {
      commandFailure(`offline Metal compilation for ${entry}`, compilation);
    }
    airFiles.push(air);
  }
  const library = join(scratch, "shader-io.metallib");
  const linking = runCommand("xcrun", [
    "-sdk",
    "macosx",
    "metallib",
    ...airFiles,
    "-o",
    library,
  ]);
  if (linking.error || linking.signal || linking.status !== 0) {
    commandFailure("offline Metal library link", linking);
  }
  if (!existsSync(library) || lstatSync(library).size === 0) {
    fail("offline Metal gate did not produce a metallib");
  }
  return { status: "passed", shaders: entryPoints.length, target: metalTarget };
}

function printSummary(result) {
  process.stdout.write(
    `PASS source contract: ${result.sources.entryPoints} entry points\n`
  );
  for (const [label, value] of [
    ["Tint raise/print", result.tint],
    ["Metal runtime", result.metalRuntime],
    ["offline Metal", result.offlineMetal],
  ]) {
    if (value.status === "passed") {
      const detail = value.device ? ` (${value.device})` : "";
      process.stdout.write(`PASS ${label}${detail}\n`);
    } else {
      process.stdout.write(`SKIP ${label}: ${value.reason}\n`);
    }
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = {
    sources: validateTrackedSources(),
    tint: { status: "skipped", reason: "no-release-root-provided" },
    metalRuntime: { status: "skipped", reason: "requires-tint-output" },
    offlineMetal: { status: "skipped", reason: "requires-tint-output" },
  };
  if (!options.releaseRoot) {
    if (options.requireTint) fail("--require-tint requires --release-root");
    printSummary(result);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), "vgpu-c1-shader-io-"));
  try {
    const pinned = validatePinnedTint(
      options.releaseRoot,
      options.compatInclude
    );
    const executables = ["a", "b"].map((copy) => {
      const buildDirectory = join(scratch, `build-${copy}`);
      mkdirSync(buildDirectory);
      const output = join(buildDirectory, "tint-probe");
      compileTintProbe(pinned, options.compatInclude, output);
      return output;
    });
    if (sha256(executables[0]) !== sha256(executables[1])) {
      fail("two clean Tint probe builds are not byte-identical");
    }
    const outputs = ["a", "b"].map((copy, index) => {
      const directory = join(scratch, `results-${copy}`);
      return {
        directory,
        fingerprint: runTintProbe(executables[index], directory),
      };
    });
    if (
      outputs[0].fingerprint.files !== outputs[1].fingerprint.files ||
      outputs[0].fingerprint.sha256 !== outputs[1].fingerprint.sha256
    ) {
      fail("two Tint shader I/O runs produced different outputs");
    }
    result.tint = {
      status: "passed",
      revision: expectedTintCommit,
      deterministicBuilds: 2,
      deterministicRuns: 2,
      entryPoints: entryPoints.length,
      outputFiles: outputs[0].fingerprint.files,
      outputSha256: outputs[0].fingerprint.sha256,
    };

    if (options.skipMetalRuntime) {
      result.metalRuntime = {
        status: "skipped",
        reason: "requested-by-flag",
      };
    } else {
      result.metalRuntime = runMetalRuntime(
        outputs[0].directory,
        scratch,
        options.requireMetalRuntime
      );
    }
    result.offlineMetal = runOfflineMetal(
      outputs[0].directory,
      scratch,
      options.requireOfflineMetal
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  printSummary(result);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
