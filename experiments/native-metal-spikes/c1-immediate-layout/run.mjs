#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const spikeDirectory = dirname(fileURLToPath(import.meta.url));
const expectedTintCommit = "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca";
const expectedLayout = "vgpu-metal-immediate-data-layout-v1";
const metalTarget = "air64-apple-macos14.0";
const wgslPath = join(spikeDirectory, "canaries/immediate-layout.wgsl");

const cases = [
  {
    id: "compute",
    entryPoint: "computeMain",
    emittedEntryPoint: "vgpu_layout_compute",
    stage: "compute",
    sizesOffset: 4,
    fragDepthUsed: false,
    configuredDepthRange: false,
  },
  {
    id: "vertex",
    entryPoint: "vertexMain",
    emittedEntryPoint: "vgpu_layout_vertex",
    stage: "vertex",
    sizesOffset: 4,
    fragDepthUsed: false,
    configuredDepthRange: false,
  },
  {
    id: "fragment-depth",
    entryPoint: "fragmentDepthMain",
    emittedEntryPoint: "vgpu_layout_fragment_depth",
    stage: "fragment",
    sizesOffset: 12,
    fragDepthUsed: true,
    configuredDepthRange: true,
  },
  {
    id: "fragment-no-depth",
    entryPoint: "fragmentNoDepthMain",
    emittedEntryPoint: "vgpu_layout_fragment_no_depth",
    stage: "fragment",
    sizesOffset: 12,
    fragDepthUsed: false,
    configuredDepthRange: false,
  },
];

function fail(message) {
  throw new Error(`C1 immediate layout: ${message}`);
}

function parseArguments(argv) {
  const options = {
    releaseRoot: process.env.C1_IMMEDIATE_LAYOUT_TINT_RELEASE_ROOT,
    compatInclude: process.env.C1_IMMEDIATE_LAYOUT_TINT_COMPAT_INCLUDE,
    requireTint: process.env.C1_IMMEDIATE_LAYOUT_REQUIRE_TINT === "1",
    skipMetalRuntime:
      process.env.C1_IMMEDIATE_LAYOUT_SKIP_METAL_RUNTIME === "1",
    requireMetalRuntime:
      process.env.C1_IMMEDIATE_LAYOUT_REQUIRE_METAL_RUNTIME === "1",
    requireOfflineMetal:
      process.env.C1_IMMEDIATE_LAYOUT_REQUIRE_OFFLINE_METAL === "1",
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
  if (options.compatInclude)
    options.compatInclude = resolve(options.compatInclude);
  if (options.skipMetalRuntime && options.requireMetalRuntime) {
    fail("--skip-metal-runtime conflicts with --require-metal-runtime");
  }
  if (options.requireMetalRuntime || options.requireOfflineMetal) {
    options.requireTint = true;
  }
  return options;
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function commandFailure(owner, result) {
  const diagnostic = [result.error?.message, result.stderr, result.stdout]
    .filter(Boolean)
    .join("\n")
    .trim();
  const suffix = diagnostic ? `: ${diagnostic}` : "";
  fail(
    `${owner} failed with ${
      result.signal ? `signal ${result.signal}` : `status ${result.status}`
    }${suffix}`
  );
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function availableXcrunTool(tool) {
  const result = runCommand("xcrun", ["--find", tool]);
  return (
    !result.error && result.status === 0 && result.stdout.trim().length > 0
  );
}

function compileTintWrapper(releaseRoot, compatInclude, scratch) {
  const provenance = readJSON(
    join(spikeDirectory, "../c1-tint-standalone/provenance/releases.json")
  );
  const release = provenance.releases?.find(
    (candidate) => candidate.commit === expectedTintCommit
  );
  const expectedLibraryHash = release?.files?.["lib/libwebgpu_dawn.a"]?.sha256;
  const expectedCompilerHeaderHash = provenance.supplementalSource?.sha256;
  if (!expectedLibraryHash || !expectedCompilerHeaderHash) {
    fail("pinned Dawn provenance is incomplete");
  }

  const includeRoot = join(releaseRoot, "include");
  const tintInclude = join(includeRoot, "src/tint");
  const library = join(releaseRoot, "lib/libwebgpu_dawn.a");
  if (!existsSync(tintInclude) || !existsSync(library)) {
    fail("release root lacks Tint headers or libwebgpu_dawn.a");
  }
  if (sha256File(library) !== expectedLibraryHash) {
    fail(`libwebgpu_dawn.a does not match pinned Dawn ${expectedTintCommit}`);
  }
  const bundledCompilerHeader = join(includeRoot, "src/utils/compiler.h");
  const compilerHeader = compatInclude
    ? join(compatInclude, "src/utils/compiler.h")
    : bundledCompilerHeader;
  if (!existsSync(compilerHeader)) {
    fail(
      "official release needs --compat-include with its exact missing header overlay"
    );
  }
  if (sha256File(compilerHeader) !== expectedCompilerHeaderHash) {
    fail(`compiler.h does not match pinned Dawn ${expectedTintCommit}`);
  }

  const source = join(spikeDirectory, "prototype/main.cc");
  const sourceText = readFileSync(source, "utf8");
  if (
    sourceText.includes("tint::GenerateBindings") ||
    sourceText.includes("api/helpers/generate_bindings")
  ) {
    fail(
      "prototype must not call or include Tint's automatic binding allocator"
    );
  }
  for (const expectedSource of [
    "kNonConstantZeroOffset = 0",
    "kVertexComputeSizesOffset = 4",
    "kFragmentDepthMinOffset = 4",
    "kFragmentDepthMaxOffset = 8",
    "kFragmentSizesOffset = 12",
  ]) {
    if (!sourceText.includes(expectedSource)) {
      fail(`prototype source lock omitted ${expectedSource}`);
    }
  }

  const wrapper = join(scratch, "vgpu-tint-immediate-layout");
  const compilation = runCommand("xcrun", [
    "clang++",
    "-std=c++20",
    "-O2",
    source,
    ...(compatInclude ? [`-I${compatInclude}`] : []),
    `-I${tintInclude}`,
    `-I${includeRoot}`,
    `-L${join(releaseRoot, "lib")}`,
    "-lwebgpu_dawn",
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
    wrapper,
  ]);
  if (compilation.error || compilation.signal || compilation.status !== 0) {
    commandFailure("Tint wrapper compilation", compilation);
  }
  return wrapper;
}

function immediateStruct(msl, owner) {
  const match = /struct tint_immediate_data_struct \{([\s\S]*?)\n\};/.exec(msl);
  if (!match) fail(`${owner} MSL omitted tint_immediate_data_struct`);
  return match[1];
}

function requireOffset(body, offset, declaration, owner) {
  const line = `/* 0x${offset.toString(16).padStart(4, "0")} */ ${declaration}`;
  if (!body.includes(line)) {
    fail(`${owner} MSL omitted exact immediate field: ${line}`);
  }
}

function verifyMSL(msl, testCase) {
  if (!msl.includes(testCase.emittedEntryPoint)) {
    fail(`${testCase.id} MSL omitted the remapped entry point`);
  }
  if (!msl.includes("[[buffer(0)]]") || !msl.includes("[[buffer(30)]]")) {
    fail(`${testCase.id} MSL omitted an external or immediate Metal slot`);
  }
  if ((testCase.stage === "compute") !== msl.includes("[[buffer(1)]]")) {
    fail(`${testCase.id} MSL compute result binding shape drifted`);
  }
  const body = immediateStruct(msl, testCase.id);
  requireOffset(body, 0, "uint tint_non_constant_zero;", testCase.id);
  requireOffset(
    body,
    testCase.sizesOffset,
    "tint_array<uint, 1> tint_storage_buffer_sizes;",
    testCase.id
  );
  if (testCase.id === "fragment-depth") {
    requireOffset(body, 4, "float tint_frag_depth_min;", testCase.id);
    requireOffset(body, 8, "float tint_frag_depth_max;", testCase.id);
    if (!msl.includes("clamp(")) {
      fail("fragment-depth MSL omitted frag-depth clamping");
    }
  } else if (
    body.includes("tint_frag_depth_min") ||
    body.includes("tint_frag_depth_max")
  ) {
    fail(`${testCase.id} unexpectedly materialized fragment-depth fields`);
  }
  if (testCase.id === "fragment-no-depth") {
    requireOffset(body, 4, "tint_array<int8_t, 8> tint_pad;", testCase.id);
  } else if (body.includes("tint_pad")) {
    fail(`${testCase.id} introduced unexpected immediate-data padding`);
  }
  if (!msl.includes("tint_storage_buffer_sizes[0u]")) {
    fail(`${testCase.id} MSL did not read physical size word zero`);
  }
}

function generateCases(wrapper, scratch) {
  const generated = [];
  for (const testCase of cases) {
    const attempts = ["first", "second"].map((suffix) => {
      const outputPath = join(scratch, `${testCase.id}-${suffix}.metal`);
      const process = runCommand(wrapper, [
        wgslPath,
        testCase.entryPoint,
        testCase.emittedEntryPoint,
        outputPath,
      ]);
      return {
        ...process,
        outputPath,
        msl: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
      };
    });
    for (const attempt of attempts) {
      if (
        attempt.error ||
        attempt.signal ||
        attempt.status !== 0 ||
        attempt.msl.length === 0
      ) {
        commandFailure(`${testCase.id} Tint generation`, attempt);
      }
    }
    if (
      attempts[0].stdout !== attempts[1].stdout ||
      attempts[0].msl !== attempts[1].msl
    ) {
      fail(`${testCase.id} Tint output is not deterministic`);
    }
    const response = JSON.parse(attempts[0].stdout);
    const expected = {
      layout: expectedLayout,
      entryPoint: testCase.entryPoint,
      emittedEntryPoint: testCase.emittedEntryPoint,
      stage: testCase.stage,
      immediateBufferIndex: 30,
      nonConstantZeroOffset: 0,
      storageBufferSizesOffset: testCase.sizesOffset,
      fragDepthUsed: testCase.fragDepthUsed,
      depthMinOffset: testCase.stage === "fragment" ? 4 : null,
      depthMaxOffset: testCase.stage === "fragment" ? 8 : null,
      configuredDepthRange: testCase.configuredDepthRange,
    };
    if (!isDeepStrictEqual(response, expected)) {
      fail(`${testCase.id} wrapper metadata drifted`);
    }
    verifyMSL(attempts[0].msl, testCase);
    generated.push({
      ...testCase,
      path: attempts[0].outputPath,
      sha256: sha256Bytes(attempts[0].msl),
    });
  }
  return {
    generated,
    summary: {
      status: "passed",
      deterministicRunsPerEntry: 2,
      entries: generated.map(({ id, stage, sizesOffset, sha256 }) => ({
        id,
        stage,
        sizesOffset,
        sha256,
      })),
      noDepthFragmentPaddingBytes: 8,
    },
  };
}

function runOfflineMetal(generated, scratch, required) {
  if (process.platform !== "darwin") {
    if (required) fail("offline Metal gate requires macOS");
    return { status: "skipped", reason: "host-is-not-macos" };
  }
  const missing = ["metal", "metallib"].filter(
    (tool) => !availableXcrunTool(tool)
  );
  if (missing.length > 0) {
    if (required) {
      fail(
        `offline Metal gate requires missing xcrun tools: ${missing.join(", ")}`
      );
    }
    return {
      status: "skipped",
      reason: `missing-xcrun-tools:${missing.join(",")}`,
    };
  }

  const libraries = [];
  for (const entry of generated) {
    const air = join(scratch, `${entry.id}.air`);
    const library = join(scratch, `${entry.id}.metallib`);
    const compile = runCommand("xcrun", [
      "-sdk",
      "macosx",
      "metal",
      "-c",
      entry.path,
      "-o",
      air,
      "-std=macos-metal2.4",
      "-target",
      metalTarget,
    ]);
    if (compile.error || compile.signal || compile.status !== 0) {
      commandFailure(`${entry.id} offline Metal compilation`, compile);
    }
    const link = runCommand("xcrun", [
      "-sdk",
      "macosx",
      "metallib",
      air,
      "-o",
      library,
    ]);
    if (link.error || link.signal || link.status !== 0) {
      commandFailure(`${entry.id} offline metallib link`, link);
    }
    if (!existsSync(library) || statSync(library).size === 0) {
      fail(`${entry.id} offline Metal gate produced no nonempty metallib`);
    }
    libraries.push({ id: entry.id, bytes: statSync(library).size });
  }
  return { status: "passed", target: metalTarget, libraries };
}

function compileSwiftCanary(scratch) {
  const executable = join(scratch, "immediate-layout-canary");
  const architecture = process.arch === "x64" ? "x86_64" : process.arch;
  if (architecture !== "arm64" && architecture !== "x86_64") {
    fail(`unsupported Swift target architecture ${architecture}`);
  }
  const compilation = runCommand("xcrun", [
    "swiftc",
    "-O",
    "-target",
    `${architecture}-apple-macosx14.0`,
    join(spikeDirectory, "prototype/main.swift"),
    "-framework",
    "Foundation",
    "-framework",
    "Metal",
    "-o",
    executable,
  ]);
  if (compilation.error || compilation.signal || compilation.status !== 0) {
    commandFailure("Swift runtime canary compilation", compilation);
  }
  return executable;
}

function verifyRuntimeResponse(response) {
  const expected = {
    backingBufferLength: 512,
    backingOffsets: [0, 256],
    canonicalColor: [4, 4, 11, 11],
    canonicalDepthBits: 0x3f19999a,
    canonicalFragmentUploadHex: "00000000cdcc4c3e9a99193f10000000",
    canonicalVertexUploadHex: "0000000010000000",
    computeImmediateAlignment: 4,
    computeImmediateDataSize: 8,
    fragmentDepthImmediateAlignment: 4,
    fragmentDepthImmediateDataSize: 16,
    fragmentNoDepthImmediateAlignment: 4,
    fragmentNoDepthImmediateDataSize: 16,
    reboundColor: [7, 7, 22, 22],
    reboundDepthBits: 0x3ecccccd,
    reboundFragmentUploadHex: "00000000cdcccc3dcdcccc3e1c000000",
    reboundVertexUploadHex: "000000001c000000",
    vertexImmediateAlignment: 4,
    vertexImmediateDataSize: 8,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(response[key], value)) {
      fail(`Metal runtime response ${key} drifted`);
    }
  }
  if (typeof response.device !== "string" || response.device.length === 0) {
    fail("Metal runtime response omitted the device name");
  }
}

function runMetalRuntime(generated, scratch, required) {
  if (process.platform !== "darwin") {
    if (required) fail("Metal runtime gate requires macOS");
    return { status: "skipped", reason: "host-is-not-macos" };
  }
  if (!availableXcrunTool("swiftc")) {
    if (required) fail("Metal runtime gate requires xcrun swiftc");
    return { status: "skipped", reason: "swiftc-unavailable" };
  }
  const byId = new Map(generated.map((entry) => [entry.id, entry.path]));
  const executable = compileSwiftCanary(scratch);
  const args = [
    byId.get("compute"),
    byId.get("vertex"),
    byId.get("fragment-depth"),
    byId.get("fragment-no-depth"),
  ];
  if (args.some((value) => typeof value !== "string")) {
    fail("runtime gate omitted one or more generated entries");
  }
  const attempts = [runCommand(executable, args), runCommand(executable, args)];
  if (attempts.some((attempt) => attempt.status === 75)) {
    if (required) fail("Metal runtime gate found no Metal device");
    return { status: "skipped", reason: "no-metal-device" };
  }
  for (const attempt of attempts) {
    if (attempt.error || attempt.signal || attempt.status !== 0) {
      commandFailure("Metal runtime canary", attempt);
    }
  }
  if (attempts[0].stdout !== attempts[1].stdout) {
    fail("Metal runtime output is not deterministic across processes");
  }
  const response = JSON.parse(attempts[0].stdout);
  verifyRuntimeResponse(response);
  return {
    status: "passed",
    deterministicProcesses: 2,
    device: response.device,
    canonicalColor: response.canonicalColor,
    canonicalDepthBits: response.canonicalDepthBits,
    reboundColor: response.reboundColor,
    reboundDepthBits: response.reboundDepthBits,
    readbackSha256: sha256Bytes(attempts[0].stdout),
  };
}

function printSummary(result) {
  for (const [label, value] of [
    ["Tint immediate layout", result.tint],
    ["offline Metal", result.offlineMetal],
    ["Metal runtime", result.metalRuntime],
  ]) {
    if (value.status === "passed") {
      const detail = value.device ? ` (${value.device})` : "";
      process.stdout.write(`PASS ${label}${detail}\n`);
    } else {
      process.stdout.write(`SKIP ${label}: ${value.reason}\n`);
    }
  }
  if (result.tint.status === "passed") {
    for (const entry of result.tint.entries) {
      process.stdout.write(
        `INFO ${entry.id} MSL sha256 ${entry.sha256} ` +
          `(sizes@${entry.sizesOffset})\n`
      );
    }
  }
  if (result.metalRuntime.status === "passed") {
    process.stdout.write(
      `INFO Metal canonical ${JSON.stringify(
        result.metalRuntime.canonicalColor
      )} ` + `depth=0x${result.metalRuntime.canonicalDepthBits.toString(16)}\n`
    );
    process.stdout.write(
      `INFO Metal rebound ${JSON.stringify(
        result.metalRuntime.reboundColor
      )} ` + `depth=0x${result.metalRuntime.reboundDepthBits.toString(16)}\n`
    );
    process.stdout.write(
      `INFO Metal readback sha256 ${result.metalRuntime.readbackSha256}\n`
    );
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = {
    tint: { status: "skipped", reason: "no-release-root-provided" },
    offlineMetal: { status: "skipped", reason: "requires-tint-output" },
    metalRuntime: { status: "skipped", reason: "requires-tint-output" },
  };
  if (!options.releaseRoot) {
    if (options.requireTint) fail("--require-tint requires --release-root");
    printSummary(result);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), "vgpu-c1-immediate-layout-"));
  try {
    const wrapper = compileTintWrapper(
      options.releaseRoot,
      options.compatInclude,
      scratch
    );
    const generated = generateCases(wrapper, scratch);
    result.tint = generated.summary;
    result.offlineMetal = runOfflineMetal(
      generated.generated,
      scratch,
      options.requireOfflineMetal
    );
    if (options.skipMetalRuntime) {
      result.metalRuntime = { status: "skipped", reason: "requested-by-flag" };
    } else {
      result.metalRuntime = runMetalRuntime(
        generated.generated,
        scratch,
        options.requireMetalRuntime
      );
    }
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
