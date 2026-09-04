#!/usr/bin/env node

import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const artifactsDirectory = join(fixtureDirectory, ".artifacts");
const compilerProtocolDirectory = resolve(
  fixtureDirectory,
  "..",
  "c1-compiler-protocol"
);
let lock;
let requestDirectory;
let defaultWorkerRoot;
const maxCommandBuffer = 256 * 1024 * 1024;
const systemTools = {
  arch: "/usr/bin/arch",
  file: "/usr/bin/file",
  git: "/usr/bin/git",
  lipo: "/usr/bin/lipo",
  nm: "/usr/bin/nm",
  otool: "/usr/bin/otool",
  plutil: "/usr/bin/plutil",
  swVers: "/usr/bin/sw_vers",
  xcrun: "/usr/bin/xcrun",
};
const expectedArchives = {
  all: 54,
  tint: 44,
  abseil: 9,
  dawnShared: 1,
};
const expectedCache = {
  ABSL_BUILD_MONOLITHIC_SHARED_LIBS: "OFF",
  ABSL_BUILD_TESTING: "OFF",
  BUILD_SHARED_LIBS: "OFF",
  CMAKE_BUILD_TYPE: "Release",
  CMAKE_OSX_DEPLOYMENT_TARGET: "14.0",
  DAWN_BUILD_BENCHMARKS: "OFF",
  DAWN_BUILD_FUZZERS: "OFF",
  DAWN_BUILD_MONOLITHIC_LIBRARY: "OFF",
  DAWN_BUILD_NODE_BINDINGS: "OFF",
  DAWN_BUILD_PROTOBUF: "OFF",
  DAWN_BUILD_SAMPLES: "OFF",
  DAWN_BUILD_TESTS: "OFF",
  DAWN_ENABLE_D3D11: "OFF",
  DAWN_ENABLE_D3D12: "OFF",
  DAWN_ENABLE_DESKTOP_GL: "OFF",
  DAWN_ENABLE_ASAN: "OFF",
  DAWN_ENABLE_METAL: "OFF",
  DAWN_ENABLE_MSAN: "OFF",
  DAWN_ENABLE_NULL: "OFF",
  DAWN_ENABLE_OPENGLES: "OFF",
  DAWN_ENABLE_SPIRV_VALIDATION: "OFF",
  DAWN_ENABLE_SWIFTSHADER: "OFF",
  DAWN_ENABLE_TSAN: "OFF",
  DAWN_ENABLE_UBSAN: "OFF",
  DAWN_ENABLE_VULKAN: "OFF",
  DAWN_ENABLE_WEBGPU_ON_WEBGPU: "OFF",
  DAWN_EMIT_COVERAGE: "OFF",
  DAWN_FETCH_DEPENDENCIES: "OFF",
  DAWN_FORCE_SYSTEM_COMPONENT_LOAD: "OFF",
  DAWN_USE_BUILT_DXC: "OFF",
  TINT_BUILD_BENCHMARKS: "OFF",
  TINT_BUILD_CMD_TOOLS: "OFF",
  TINT_BUILD_FUZZERS: "OFF",
  TINT_BUILD_FUZZER_VULKAN_SUPPORT: "OFF",
  TINT_BUILD_GLSL_VALIDATOR: "OFF",
  TINT_BUILD_GLSL_WRITER: "OFF",
  TINT_BUILD_HLSL_WRITER: "OFF",
  TINT_BUILD_IR_BINARY: "OFF",
  TINT_BUILD_MESA: "OFF",
  TINT_BUILD_MSL_WRITER: "ON",
  TINT_BUILD_NULL_WRITER: "OFF",
  TINT_BUILD_SPV_READER: "OFF",
  TINT_BUILD_SPV_WRITER: "OFF",
  TINT_BUILD_TESTS: "OFF",
  TINT_BUILD_WGSL_READER: "ON",
  TINT_BUILD_WGSL_WRITER: "OFF",
  TINT_ENABLE_BREAK_IN_DEBUGGER: "OFF",
  TINT_ENABLE_IR_DUMPING: "OFF",
  TINT_ENABLE_IR_VALIDATION_ASSERTS: "OFF",
  TINT_RANDOMIZE_HASHES: "OFF",
};

function fail(message) {
  throw new Error(`C1 direct Tint build: ${message}`);
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function usage(stream = process.stderr) {
  stream.write(
    "Usage: node run.mjs --dawn-root <clean Dawn checkout> " +
      "--jsoncpp-root <clean JsonCpp checkout> " +
      "--release-root <monolithic Dawn release> " +
      "--compat-include <release header overlay> --sdk-root <macOS SDK> " +
      "[--cmake <cmake>] [--ninja <ninja>] [--c-compiler <clang>] " +
      "[--cxx-compiler <clang++>] [--python <python3>] [--jobs <count>] " +
      "[--scratch-root <directory>] [--keep-builds]\n"
  );
}

function parseArguments(argv) {
  const options = {
    dawnRoot: process.env.C1_TINT_DIRECT_BUILD_DAWN_ROOT,
    jsoncppRoot: process.env.C1_TINT_DIRECT_BUILD_JSONCPP_ROOT,
    releaseRoot: process.env.C1_TINT_DIRECT_BUILD_RELEASE_ROOT,
    compatInclude: process.env.C1_TINT_DIRECT_BUILD_COMPAT_INCLUDE,
    sdkRoot: process.env.C1_TINT_DIRECT_BUILD_SDK_ROOT,
    workerRoot: defaultWorkerRoot,
    cmake: process.env.C1_TINT_DIRECT_BUILD_CMAKE ?? "cmake",
    ninja: process.env.C1_TINT_DIRECT_BUILD_NINJA ?? "ninja",
    cCompiler: process.env.C1_TINT_DIRECT_BUILD_C_COMPILER ?? "/usr/bin/clang",
    cxxCompiler:
      process.env.C1_TINT_DIRECT_BUILD_CXX_COMPILER ?? "/usr/bin/clang++",
    python: process.env.C1_TINT_DIRECT_BUILD_PYTHON ?? "/usr/bin/python3",
    jobs: Number.parseInt(process.env.C1_TINT_DIRECT_BUILD_JOBS ?? "8", 10),
    scratchRoot: process.env.C1_TINT_DIRECT_BUILD_SCRATCH_ROOT,
    keepBuilds: false,
  };
  const valued = new Map([
    ["--dawn-root", "dawnRoot"],
    ["--jsoncpp-root", "jsoncppRoot"],
    ["--release-root", "releaseRoot"],
    ["--compat-include", "compatInclude"],
    ["--sdk-root", "sdkRoot"],
    ["--cmake", "cmake"],
    ["--ninja", "ninja"],
    ["--c-compiler", "cCompiler"],
    ["--cxx-compiler", "cxxCompiler"],
    ["--python", "python"],
    ["--jobs", "jobs"],
    ["--scratch-root", "scratchRoot"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h")
      fail("help must be the only argument");
    if (argument === "--keep-builds") {
      options.keepBuilds = true;
      continue;
    }
    const key = valued.get(argument);
    if (!key) {
      usage();
      fail(`unknown argument ${argument}`);
    }
    const value = argv[++index];
    if (!value) fail(`${argument} requires a value`);
    options[key] = key === "jobs" ? Number.parseInt(value, 10) : value;
  }

  for (const key of [
    "dawnRoot",
    "jsoncppRoot",
    "releaseRoot",
    "compatInclude",
    "sdkRoot",
  ]) {
    if (!options[key]) {
      usage();
      fail(
        `--${key.replace(
          /[A-Z]/gu,
          (match) => `-${match.toLowerCase()}`
        )} is required`
      );
    }
  }
  if (
    !Number.isSafeInteger(options.jobs) ||
    options.jobs < 1 ||
    options.jobs > 64
  ) {
    fail("--jobs must be an integer from 1 through 64");
  }
  return options;
}

function command(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: null,
    maxBuffer: maxCommandBuffer,
    timeout: 30 * 60_000,
    ...options,
  });
  return {
    ...result,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

function tail(buffer, bytes = 16 * 1024) {
  return buffer.subarray(Math.max(0, buffer.length - bytes)).toString("utf8");
}

function checkedCommand(commandName, args, label, options = {}) {
  const result = command(commandName, args, options);
  if (result.error || result.signal || result.status !== 0) {
    const cause =
      result.error?.message ?? result.signal ?? `exit ${result.status}`;
    fail(
      `${label} failed (${cause})\n${tail(result.stdout)}${tail(result.stderr)}`
    );
  }
  return result;
}

function stdoutText(commandName, args, label, options = {}) {
  return checkedCommand(commandName, args, label, options)
    .stdout.toString("utf8")
    .trim();
}

function resolveExisting(path, label, kind = "file") {
  let resolved;
  try {
    resolved = realpathSync(resolve(path));
  } catch {
    fail(`${label} does not exist: ${path}`);
  }
  const metadata = lstatSync(resolved);
  if (kind === "directory" ? !metadata.isDirectory() : !metadata.isFile()) {
    fail(`${label} is not a ${kind}: ${resolved}`);
  }
  return resolved;
}

function resolveExecutable(candidate, label) {
  if (candidate.includes("/")) return resolveExisting(candidate, label);
  const located = stdoutText("/usr/bin/which", [candidate], `${label} lookup`);
  return resolveExisting(located, label);
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

function validateRelativePath(relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} contains unsafe path ${String(relativePath)}`);
  }
}

function sha256SelectedFiles(root, paths, label) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const relativePath of paths) {
    validateRelativePath(relativePath, label);
    const path = join(root, ...relativePath.split("/"));
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail(`${label} path is not a regular file: ${relativePath}`);
    }
    const contents = readFileSync(path);
    bytes += contents.length;
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(sha256Buffer(contents), "utf8");
    hash.update("\n", "utf8");
  }
  return { files: paths.length, bytes, sha256: hash.digest("hex") };
}

function verifyLockedFile(expected, label) {
  const path = resolve(fixtureDirectory, expected.path);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} is not a regular file: ${path}`);
  }
  assertEqual(metadata.size, expected.bytes, `${label} size`);
  assertEqual(sha256File(path), expected.sha256, `${label} SHA-256`);
  return realpathSync(path);
}

function verifyOracleInputs() {
  const files = Object.fromEntries(
    Object.entries(lock.oracle.inputs).map(([name, expected]) => [
      name,
      verifyLockedFile(expected, `oracle ${name}`),
    ])
  );
  const expectedRequests = lock.oracle.requests;
  const sortedPaths = [...expectedRequests.paths].sort(compareUtf8);
  assertEqual(
    JSON.stringify(expectedRequests.paths),
    JSON.stringify(sortedPaths),
    "oracle request path order"
  );
  const requests = sha256SelectedFiles(
    requestDirectory,
    expectedRequests.paths,
    "oracle request closure"
  );
  for (const key of ["files", "bytes", "sha256"]) {
    assertEqual(
      requests[key],
      expectedRequests[key],
      `oracle request closure ${key}`
    );
  }
  return { files, requests };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(
      `${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(
        expected
      )}`
    );
  }
}

function verifyPinnedCheckout(root, expected, label) {
  const commit = stdoutText(
    systemTools.git,
    ["-C", root, "rev-parse", "HEAD^{commit}"],
    `${label} commit`
  );
  const tree = stdoutText(
    systemTools.git,
    ["-C", root, "rev-parse", "HEAD^{tree}"],
    `${label} tree`
  );
  assertEqual(commit, expected.commit, `${label} commit`);
  assertEqual(tree, expected.tree, `${label} tree`);
  return { commit, tree };
}

function verifyLicense(sourceRoot, dependency, label) {
  const source = join(sourceRoot, dependency.license.sourcePath);
  const tracked = join(
    fixtureDirectory,
    "provenance",
    dependency.license.trackedPath
  );
  for (const path of [source, tracked]) {
    assertEqual(
      statSync(path).size,
      dependency.license.bytes,
      `${label} license size`
    );
    assertEqual(
      sha256File(path),
      dependency.license.sha256,
      `${label} license SHA-256`
    );
  }
}

function verifySourceInputs(options) {
  const fixtureCmake = join(fixtureDirectory, lock.fixture.cmake.path);
  assertEqual(
    statSync(fixtureCmake).size,
    lock.fixture.cmake.bytes,
    "spike CMakeLists.txt size"
  );
  assertEqual(
    sha256File(fixtureCmake),
    lock.fixture.cmake.sha256,
    "spike CMakeLists.txt SHA-256"
  );
  const oracle = verifyOracleInputs();
  const dawnRoot = resolveExisting(options.dawnRoot, "Dawn root", "directory");
  const jsoncppRoot = resolveExisting(
    options.jsoncppRoot,
    "JsonCpp root",
    "directory"
  );
  const releaseRoot = resolveExisting(
    options.releaseRoot,
    "monolithic oracle release root",
    "directory"
  );
  const compatInclude = resolveExisting(
    options.compatInclude,
    "monolithic oracle compatibility include root",
    "directory"
  );
  const workerRoot = resolveExisting(
    options.workerRoot,
    "worker root",
    "directory"
  );
  const sdkRoot = resolveExisting(options.sdkRoot, "SDK root", "directory");
  const cmake = resolveExecutable(options.cmake, "CMake executable");
  const cmakeRoot = realpathSync(dirname(dirname(cmake)));
  const ninja = resolveExecutable(options.ninja, "Ninja executable");
  const cCompiler = resolveExecutable(options.cCompiler, "C compiler");
  const cxxCompiler = resolveExecutable(options.cxxCompiler, "C++ compiler");
  const python = resolveExecutable(options.python, "Python executable");
  const clangResourceRoot = resolveExisting(
    stdoutText(
      cxxCompiler,
      ["-print-resource-dir"],
      "Apple Clang resource directory"
    ),
    "Apple Clang resource directory",
    "directory"
  );

  const dawn = verifyPinnedCheckout(dawnRoot, lock.dawn, "Dawn");
  verifyLicense(dawnRoot, lock.dawn, "Dawn");
  const depsPath = join(dawnRoot, lock.dawn.deps.path);
  assertEqual(statSync(depsPath).size, lock.dawn.deps.bytes, "Dawn DEPS size");
  assertEqual(sha256File(depsPath), lock.dawn.deps.sha256, "Dawn DEPS SHA-256");

  const abseilLock = lock.dependencies.abseil;
  const abseilRoot = join(dawnRoot, abseilLock.pathWithinDawn);
  const abseil = verifyPinnedCheckout(
    abseilRoot,
    { commit: abseilLock.chromiumCheckoutCommit, tree: abseilLock.tree },
    "Abseil"
  );
  verifyLicense(abseilRoot, abseilLock, "Abseil");

  const spirvHeadersLock = lock.dependencies.spirvHeaders;
  const spirvHeadersRoot = join(dawnRoot, spirvHeadersLock.pathWithinDawn);
  const spirvHeaders = verifyPinnedCheckout(
    spirvHeadersRoot,
    spirvHeadersLock,
    "SPIRV-Headers"
  );
  verifyLicense(spirvHeadersRoot, spirvHeadersLock, "SPIRV-Headers");

  const depsText = readFileSync(join(dawnRoot, "DEPS"), "utf8");
  for (const [label, revision] of [
    ["Abseil", abseilLock.chromiumCheckoutCommit],
    ["SPIRV-Headers", spirvHeadersLock.commit],
    ["excluded SPIRV-Tools", lock.dependencies.spirvTools.depsCommit],
  ]) {
    if (!depsText.includes(revision)) fail(`Dawn DEPS omitted pinned ${label}`);
  }
  const abseilReadme = readFileSync(
    join(abseilRoot, "README.chromium"),
    "utf8"
  );
  if (!abseilReadme.includes(`Revision: ${abseilLock.upstreamRevision}`)) {
    fail("Abseil upstream revision does not match README.chromium");
  }

  const jsoncppLock = lock.dependencies.jsoncpp;
  const jsoncpp = verifyPinnedCheckout(jsoncppRoot, jsoncppLock, "JsonCpp");
  const jsoncppProvenance = readJSON(
    resolve(fixtureDirectory, jsoncppLock.sharedProvenance)
  );
  assertEqual(
    jsoncppProvenance.commit,
    jsoncppLock.commit,
    "JsonCpp provenance commit"
  );
  const jsoncppClosure = sha256SelectedFiles(
    jsoncppRoot,
    jsoncppProvenance.compiledClosure.paths,
    "JsonCpp compiled closure"
  );
  assertEqual(
    jsoncppClosure.files,
    jsoncppProvenance.compiledClosure.files,
    "JsonCpp closure file count"
  );
  assertEqual(
    jsoncppClosure.sha256,
    jsoncppProvenance.compiledClosure.sha256,
    "JsonCpp closure SHA-256"
  );
  const jsoncppLicenseSource = join(
    jsoncppRoot,
    jsoncppProvenance.license.sourcePath
  );
  const jsoncppLicenseTracked = join(
    compilerProtocolDirectory,
    "provenance",
    jsoncppProvenance.license.trackedPath
  );
  for (const path of [jsoncppLicenseSource, jsoncppLicenseTracked]) {
    assertEqual(
      statSync(path).size,
      jsoncppProvenance.license.bytes,
      "JsonCpp license size"
    );
    assertEqual(
      sha256File(path),
      jsoncppProvenance.license.sha256,
      "JsonCpp license SHA-256"
    );
  }

  const workerClosure = sha256SelectedFiles(
    workerRoot,
    lock.worker.closure.paths,
    "worker closure"
  );
  assertEqual(
    workerClosure.files,
    lock.worker.closure.files,
    "worker closure files"
  );
  assertEqual(
    workerClosure.sha256,
    lock.worker.closure.sha256,
    "worker closure SHA-256"
  );

  const configuration = verifyConfigurationManifest({
    dawnRoot,
    abseilRoot,
    spirvHeadersRoot,
    jsoncppRoot,
    workerRoot,
  });

  const sdkVersion = stdoutText(
    systemTools.plutil,
    ["-extract", "Version", "raw", join(sdkRoot, "SDKSettings.plist")],
    "SDK version"
  );
  assertEqual(sdkVersion, "14.5", "SDK version");

  return {
    dawnRoot,
    jsoncppRoot,
    releaseRoot,
    compatInclude,
    workerRoot,
    sdkRoot,
    cmake,
    cmakeRoot,
    ninja,
    cCompiler,
    cxxCompiler,
    python,
    clangResourceRoot,
    abseilRoot,
    spirvHeadersRoot,
    revisions: { dawn, abseil, spirvHeaders, jsoncpp },
    configurationInputPaths: configuration.absolutePaths,
    closures: {
      configuration: configuration.closure,
      jsoncpp: jsoncppClosure,
      requests: oracle.requests,
      worker: workerClosure,
    },
    oracle,
    sdkVersion,
  };
}

function isWithinRoot(path, root) {
  const child = relative(root, path);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function portableRelative(root, path, label) {
  if (!isWithinRoot(path, root)) fail(`${label} escaped its source root`);
  const portable = relative(root, path).split(sep).join("/");
  validateRelativePath(portable, label);
  return portable;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function summarizeAbsoluteFiles(root, paths, label) {
  const entries = [...new Set(paths)].map((path) => {
    if (!isAbsolute(path)) fail(`${label} contains a relative path: ${path}`);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail(`${label} input is not a regular file: ${path}`);
    }
    const canonical = realpathSync(path);
    if (canonical !== path) fail(`${label} input is not canonical: ${path}`);
    const portablePath = portableRelative(root, path, label);
    const bytes = readFileSync(path);
    return {
      path: portablePath,
      bytes: bytes.length,
      sha256: sha256Buffer(bytes),
    };
  });
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  const hash = createHash("sha256");
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.bytes;
    hash.update(entry.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.sha256, "utf8");
    hash.update("\n", "utf8");
  }
  return {
    files: entries.length,
    bytes,
    sha256: hash.digest("hex"),
    entries,
  };
}

function sourceGroups(inputs) {
  // Nested repositories must precede Dawn so their paths are attributed to
  // the commit that actually owns the bytes.
  return [
    { name: "abseil", root: inputs.abseilRoot },
    { name: "spirvHeaders", root: inputs.spirvHeadersRoot },
    { name: "dawn", root: inputs.dawnRoot },
    { name: "jsoncpp", root: inputs.jsoncppRoot },
    { name: "worker", root: inputs.workerRoot },
  ];
}

function classifySourcePath(path, inputs) {
  return sourceGroups(inputs).find(({ root }) => isWithinRoot(path, root));
}

function verifyConfigurationManifest(inputs) {
  const expectedManifest = lock.fixture.configurationInputs;
  const manifestPath = join(fixtureDirectory, expectedManifest.path);
  assertEqual(
    statSync(manifestPath).size,
    expectedManifest.bytes,
    "configuration input manifest size"
  );
  assertEqual(
    sha256File(manifestPath),
    expectedManifest.sha256,
    "configuration input manifest SHA-256"
  );
  const manifest = readJSON(manifestPath);
  assertEqual(manifest.schemaVersion, 1, "configuration manifest schema");
  assertEqual(
    manifest.algorithm,
    "utf8-byte-sorted-relative-path-lists-v1",
    "configuration manifest algorithm"
  );

  const expectedRepositories = Object.keys(
    lock.closures.configuration.repositories
  ).sort(compareUtf8);
  const repositories = Object.keys(manifest.repositories ?? {}).sort(
    compareUtf8
  );
  assertEqual(
    JSON.stringify(repositories),
    JSON.stringify(expectedRepositories),
    "configuration manifest repositories"
  );

  const absolutePaths = [];
  for (const repository of expectedRepositories) {
    const group = sourceGroups(inputs).find(({ name }) => name === repository);
    if (!group) fail(`configuration manifest has unknown ${repository} root`);
    const paths = manifest.repositories[repository];
    if (!Array.isArray(paths)) {
      fail(`configuration manifest ${repository} paths are not an array`);
    }
    const sorted = [...paths].sort(compareUtf8);
    assertEqual(
      JSON.stringify(paths),
      JSON.stringify(sorted),
      `configuration manifest ${repository} path order`
    );
    assertEqual(
      new Set(paths).size,
      paths.length,
      `configuration manifest ${repository} unique paths`
    );
    for (const relativePath of paths) {
      validateRelativePath(
        relativePath,
        `configuration manifest ${repository}`
      );
      absolutePaths.push(join(group.root, ...relativePath.split("/")));
    }
  }

  const closure = verifyClosure(
    absolutePaths,
    inputs,
    lock.closures.configuration,
    "preflight configuration closure"
  );
  return { absolutePaths, closure };
}

function verifyClosure(paths, inputs, expected, label) {
  const byRepository = new Map();
  for (const path of paths) {
    const group = classifySourcePath(path, inputs);
    if (!group) fail(`${label} contains an unattributed source input: ${path}`);
    const values = byRepository.get(group.name) ?? [];
    values.push(path);
    byRepository.set(group.name, values);
  }

  const summaries = {};
  const combinedEntries = [];
  for (const group of sourceGroups(inputs)) {
    const expectedRepository = expected.repositories[group.name];
    const repositoryPaths = byRepository.get(group.name) ?? [];
    if (!expectedRepository && repositoryPaths.length > 0) {
      fail(`${label} unexpectedly includes ${group.name}`);
    }
    if (!expectedRepository) continue;
    const summary = summarizeAbsoluteFiles(
      group.root,
      repositoryPaths,
      `${label} ${group.name}`
    );
    for (const key of ["files", "bytes", "sha256"]) {
      assertEqual(
        summary[key],
        expectedRepository[key],
        `${label} ${group.name} ${key}`
      );
    }
    summaries[group.name] = {
      files: summary.files,
      bytes: summary.bytes,
      sha256: summary.sha256,
    };
    for (const entry of summary.entries) {
      combinedEntries.push({ repository: group.name, ...entry });
    }
  }

  combinedEntries.sort((left, right) =>
    compareUtf8(
      `${left.repository}\0${left.path}`,
      `${right.repository}\0${right.path}`
    )
  );
  const combinedHash = createHash("sha256");
  for (const entry of combinedEntries) {
    combinedHash.update(entry.repository, "utf8");
    combinedHash.update("\0", "utf8");
    combinedHash.update(entry.path, "utf8");
    combinedHash.update("\0", "utf8");
    combinedHash.update(entry.sha256, "utf8");
    combinedHash.update("\n", "utf8");
  }
  const combined = {
    files: combinedEntries.length,
    bytes: combinedEntries.reduce((total, entry) => total + entry.bytes, 0),
    sha256: combinedHash.digest("hex"),
  };
  for (const key of ["files", "bytes", "sha256"]) {
    assertEqual(combined[key], expected[key], `${label} combined ${key}`);
  }
  return { repositories: summaries, ...combined };
}

function splitNinjaWords(value, label) {
  const words = [];
  let word = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "$") {
      index += 1;
      if (index >= value.length)
        fail(`${label} ends with an incomplete escape`);
      word += value[index];
    } else if (/\s/u.test(character)) {
      if (word) words.push(word);
      word = "";
    } else {
      word += character;
    }
  }
  if (word) words.push(word);
  return words;
}

function configurationInputs(buildNinja, buildDirectory, inputs) {
  const line = buildNinja
    .split("\n")
    .find((candidate) =>
      candidate.startsWith("build build.ninja: RERUN_CMAKE | ")
    );
  if (!line) fail("Ninja graph omitted the RERUN_CMAKE source closure");
  const words = splitNinjaWords(
    line.slice("build build.ninja: RERUN_CMAKE | ".length),
    "RERUN_CMAKE inputs"
  );
  const fixtureCmake = join(fixtureDirectory, lock.fixture.cmake.path);
  const expectedSources = new Set(inputs.configurationInputPaths);
  const observedSources = [];
  let fixtureOccurrences = 0;
  for (const word of words) {
    const absolute = realpathSync(resolve(buildDirectory, word));
    if (absolute === fixtureCmake) {
      fixtureOccurrences += 1;
      continue;
    }
    if (classifySourcePath(absolute, inputs)) {
      observedSources.push(absolute);
      continue;
    }
    if (
      isWithinRoot(absolute, inputs.cmakeRoot) ||
      isWithinRoot(absolute, buildDirectory)
    ) {
      continue;
    }
    fail(`RERUN_CMAKE input escaped the allowed roots: ${absolute}`);
  }
  assertEqual(
    fixtureOccurrences,
    1,
    "RERUN_CMAKE spike CMakeLists.txt occurrences"
  );
  assertEqual(
    statSync(fixtureCmake).size,
    lock.fixture.cmake.bytes,
    "spike CMakeLists.txt size"
  );
  assertEqual(
    sha256File(fixtureCmake),
    lock.fixture.cmake.sha256,
    "spike CMakeLists.txt SHA-256"
  );
  const observedSorted = [...observedSources].sort(compareUtf8);
  const expectedSorted = [...expectedSources].sort(compareUtf8);
  assertEqual(
    JSON.stringify(observedSorted),
    JSON.stringify(expectedSorted),
    "RERUN_CMAKE exact source inputs"
  );
  return observedSources;
}

function compiledInputs(buildDirectory, inputs) {
  const inputResult = checkedCommand(
    inputs.ninja,
    ["-C", buildDirectory, "-t", "inputs", "-0", "vgpu-tint-worker"],
    "Ninja transitive input query"
  );
  const graphInputs = inputResult.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const objects = new Set(graphInputs.filter((path) => path.endsWith(".o")));
  assertEqual(
    objects.size,
    lock.closures.compiled.objects,
    "compiled object closure"
  );

  const dependencyResult = checkedCommand(
    inputs.ninja,
    ["-C", buildDirectory, "-t", "deps"],
    "Ninja dependency query"
  );
  const dependencies = new Set(graphInputs.filter((path) => isAbsolute(path)));
  let selectedObject = false;
  let selectedBlocks = 0;
  for (const line of dependencyResult.stdout.toString("utf8").split("\n")) {
    if (!line.startsWith(" ")) {
      const header = line.match(
        /^(.*): #deps \d+, deps mtime \d+ \(([^)]+)\)$/u
      );
      const object = header?.[1] ?? "";
      selectedObject = objects.has(object);
      if (selectedObject) {
        assertEqual(header[2], "VALID", `${object} Ninja dependency state`);
        selectedBlocks += 1;
      }
      continue;
    }
    if (!selectedObject || !line.startsWith("    ")) continue;
    const dependency = line.slice(4);
    if (!dependency) continue;
    const absolute = isAbsolute(dependency)
      ? dependency
      : resolve(buildDirectory, dependency);
    const group = classifySourcePath(absolute, inputs);
    if (group) {
      dependencies.add(absolute);
      continue;
    }
    if (
      !isWithinRoot(absolute, buildDirectory) &&
      !isWithinRoot(absolute, inputs.sdkRoot) &&
      !isWithinRoot(absolute, inputs.clangResourceRoot)
    ) {
      fail(`compiled dependency escaped the allowed roots: ${absolute}`);
    }
  }
  assertEqual(selectedBlocks, objects.size, "Ninja dependency object blocks");
  return dependencies;
}

function verifyBuildInputClosures(buildDirectory, inputs) {
  const buildNinja = readFileSync(join(buildDirectory, "build.ninja"), "utf8");
  const configuration = verifyClosure(
    configurationInputs(buildNinja, buildDirectory, inputs),
    inputs,
    lock.closures.configuration,
    "configuration closure"
  );
  const compiled = verifyClosure(
    compiledInputs(buildDirectory, inputs),
    inputs,
    lock.closures.compiled,
    "compiled closure"
  );
  return { configuration, compiled };
}

function verifyToolchain(inputs) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail(
      "the arm64-native plus x86_64-Rosetta gate requires an arm64 macOS host"
    );
  }
  const hostMacOS = stdoutText(
    systemTools.swVers,
    ["-productVersion"],
    "host macOS version"
  );
  const hostMajor = Number.parseInt(hostMacOS.split(".")[0], 10);
  if (
    !Number.isSafeInteger(hostMajor) ||
    hostMajor < lock.build.minimumHostMacOS
  ) {
    fail(
      `the monolithic reference requires macOS ${lock.build.minimumHostMacOS} or newer; host is ${hostMacOS}`
    );
  }
  const cmakeOutput = stdoutText(inputs.cmake, ["--version"], "CMake version");
  const cmakeVersion = cmakeOutput.match(/^cmake version ([^\s]+)/u)?.[1];
  assertEqual(cmakeVersion, lock.build.cmake, "CMake version");
  const ninjaVersion = stdoutText(inputs.ninja, ["--version"], "Ninja version");
  if (
    ninjaVersion !== lock.build.ninja &&
    !ninjaVersion.startsWith(`${lock.build.ninja}.`)
  ) {
    fail(`Ninja version is ${ninjaVersion}, expected ${lock.build.ninja}.x`);
  }
  const cCompilerVersion = stdoutText(
    inputs.cCompiler,
    ["--version"],
    "Apple C compiler version"
  ).split("\n")[0];
  const cxxCompilerVersion = stdoutText(
    inputs.cxxCompiler,
    ["--version"],
    "Apple C++ compiler version"
  ).split("\n")[0];
  assertEqual(
    cCompilerVersion,
    lock.build.appleClangFirstLine,
    "Apple C compiler version"
  );
  assertEqual(
    cxxCompilerVersion,
    lock.build.appleClangFirstLine,
    "Apple C++ compiler version"
  );
  const pythonVersion = stdoutText(
    inputs.python,
    ["--version"],
    "Python version"
  );
  assertEqual(pythonVersion, lock.build.pythonFirstLine, "Python version");
  const xcrunCxx = resolveExisting(
    stdoutText(
      systemTools.xcrun,
      ["--find", "clang++"],
      "xcrun clang++ lookup"
    ),
    "xcrun clang++"
  );
  const xcrunCxxVersion = stdoutText(
    xcrunCxx,
    ["--version"],
    "xcrun oracle C++ compiler version"
  ).split("\n")[0];
  assertEqual(
    xcrunCxxVersion,
    lock.build.appleClangFirstLine,
    "xcrun oracle C++ compiler version"
  );
  return {
    cmakeVersion,
    ninjaVersion,
    cCompilerVersion,
    cxxCompilerVersion,
    pythonVersion,
    hostMacOS,
  };
}

function readCMakeCache(path) {
  const values = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const match = line.match(/^([^:=]+):[^=]*=(.*)$/u);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function verifyCache(buildDirectory, architecture, inputs) {
  const cache = readCMakeCache(join(buildDirectory, "CMakeCache.txt"));
  for (const [key, value] of Object.entries(expectedCache)) {
    assertEqual(cache.get(key), value, `${architecture} CMake cache ${key}`);
  }
  assertEqual(
    cache.get("CMAKE_GENERATOR"),
    "Ninja",
    `${architecture} CMake generator`
  );
  assertEqual(
    cache.get("CMAKE_OSX_ARCHITECTURES"),
    architecture,
    `${architecture} CMake architecture`
  );
  assertEqual(
    realpathSync(cache.get("CMAKE_OSX_SYSROOT")),
    inputs.sdkRoot,
    `${architecture} CMake SDK`
  );
  assertEqual(
    realpathSync(cache.get("CMAKE_MAKE_PROGRAM")),
    inputs.ninja,
    `${architecture} CMake Ninja`
  );
  assertEqual(
    realpathSync(cache.get("_Python3_EXECUTABLE")),
    inputs.python,
    `${architecture} CMake Python`
  );
}

function extractLinkBlock(buildNinja) {
  const lines = buildNinja.split("\n");
  const index = lines.findIndex((line) =>
    line.startsWith("build vgpu-tint-worker:")
  );
  if (index < 0) fail("Ninja graph omitted vgpu-tint-worker");
  const firstLine = lines[index];
  const block = [firstLine];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.startsWith("build ") || line.startsWith("# ")) break;
    block.push(line);
  }
  const properties = new Map(
    block
      .slice(1)
      .map((line) => line.match(/^  ([A-Z_]+) = (.*)$/u))
      .filter(Boolean)
      .map((match) => [match[1], match[2]])
  );
  const libraries = properties.get("LINK_LIBRARIES");
  if (!libraries) fail("Ninja graph omitted the worker link libraries");
  const directEdge = firstLine
    .slice("build vgpu-tint-worker: ".length)
    .split(" | ")[0];
  const edgeWords = splitNinjaWords(directEdge, "worker link edge");
  if (edgeWords.shift() !== "CXX_EXECUTABLE_LINKER__vgpu-tint-worker_Release") {
    fail("Ninja graph changed the worker linker rule");
  }
  return {
    block: block.join("\n"),
    directObjects: edgeWords,
    libraries,
    properties,
  };
}

function verifyBuildGraph(buildDirectory, architecture, inputs) {
  const buildNinja = readFileSync(join(buildDirectory, "build.ninja"), "utf8");
  const link = extractLinkBlock(buildNinja);
  const libraryWords = splitNinjaWords(link.libraries, "worker link libraries");
  const archives = libraryWords.filter((word) => word.endsWith(".a"));
  assertEqual(
    libraryWords.length,
    archives.length,
    `${architecture} non-archive link input count`
  );
  const tint = archives.filter((path) => /\/libtint_[^/]+\.a$/u.test(path));
  const abseil = archives.filter((path) => /\/libabsl_[^/]+\.a$/u.test(path));
  const dawnShared = archives.filter((path) =>
    path.endsWith("/libdawn_shared_utils.a")
  );
  assertEqual(
    archives.length,
    expectedArchives.all,
    `${architecture} archive closure`
  );
  assertEqual(
    tint.length,
    expectedArchives.tint,
    `${architecture} Tint archives`
  );
  assertEqual(
    abseil.length,
    expectedArchives.abseil,
    `${architecture} Abseil archives`
  );
  assertEqual(
    dawnShared.length,
    expectedArchives.dawnShared,
    `${architecture} Dawn shared utility archives`
  );
  const archiveHash = createHash("sha256");
  for (const archive of archives) {
    archiveHash.update(archive, "utf8");
    archiveHash.update("\n", "utf8");
  }
  assertEqual(
    archiveHash.digest("hex"),
    lock.build.linkArchives.sha256,
    `${architecture} ordered archive closure SHA-256`
  );
  assertEqual(
    link.directObjects.length,
    lock.build.directWorkerObjects,
    `${architecture} direct worker object count`
  );
  assertEqual(
    link.properties.get("FLAGS"),
    `-O3 -DNDEBUG -arch ${architecture} -isysroot ${inputs.sdkRoot} ` +
      "-mmacosx-version-min=14.0",
    `${architecture} exact linker flags`
  );
  if (link.properties.has("LINK_FLAGS")) {
    fail(`${architecture} worker link edge contains unexpected LINK_FLAGS`);
  }
  if (!archives[0]?.endsWith("/libtint_api.a")) {
    fail(`${architecture} first and sole declared link root is not tint_api`);
  }
  for (const forbidden of [
    "libwebgpu",
    "webgpu_dawn",
    "libdawn_native",
    "dawn_monolithic",
    "-framework",
    "libtint_cmd",
    "libtint_lang_spirv",
    "libtint_lang_glsl",
    "libtint_lang_hlsl",
  ]) {
    if (link.libraries.includes(forbidden)) {
      fail(`${architecture} link closure contains forbidden ${forbidden}`);
    }
  }

  const compileCommands = readJSON(
    join(buildDirectory, "compile_commands.json")
  );
  const workerFiles = new Set(
    [
      join(inputs.workerRoot, "main.cc"),
      join(inputs.workerRoot, "json-codec.cc"),
      join(inputs.jsoncppRoot, "src", "lib_json", "json_reader.cpp"),
      join(inputs.jsoncppRoot, "src", "lib_json", "json_value.cpp"),
      join(inputs.jsoncppRoot, "src", "lib_json", "json_writer.cpp"),
    ].map((path) => realpathSync(path))
  );
  assertEqual(
    compileCommands.length,
    lock.build.compileCommands,
    `${architecture} configured compile command count`
  );
  const workerCommands = compileCommands.filter((entry) =>
    entry.output?.startsWith("CMakeFiles/vgpu-tint-worker.dir/")
  );
  assertEqual(
    workerCommands.length,
    5,
    `${architecture} worker translation units`
  );
  const compiledWorkerFiles = new Set(
    workerCommands.map((entry) => realpathSync(entry.file))
  );
  assertEqual(
    JSON.stringify([...compiledWorkerFiles].sort()),
    JSON.stringify([...workerFiles].sort()),
    `${architecture} exact worker translation units`
  );
  for (const entry of workerCommands) {
    for (const required of [
      "-std=c++20",
      "-Werror",
      "-DTINT_BUILD_MSL_WRITER=1",
      "-DTINT_BUILD_WGSL_READER=1",
      "-DTINT_ENABLE_IR_VALIDATION_ASSERTS=0",
    ]) {
      if (!entry.command.includes(required)) {
        fail(`${architecture} worker compile command omitted ${required}`);
      }
    }
    if (entry.command.includes("-fno-exceptions")) {
      fail(`${architecture} worker unexpectedly disabled codec exceptions`);
    }
  }
  for (const entry of compileCommands) {
    for (const required of [
      "-std=c++20",
      `-arch ${architecture}`,
      `-isysroot ${inputs.sdkRoot}`,
      "-mmacosx-version-min=14.0",
      `-ffile-prefix-map=${inputs.dawnRoot}=/vgpu/source/dawn`,
      `-fmacro-prefix-map=${inputs.dawnRoot}=/vgpu/source/dawn`,
      `-ffile-prefix-map=${inputs.jsoncppRoot}=/vgpu/source/jsoncpp`,
      `-fmacro-prefix-map=${inputs.jsoncppRoot}=/vgpu/source/jsoncpp`,
      `-ffile-prefix-map=${inputs.workerRoot}=/vgpu/source/worker`,
      `-fmacro-prefix-map=${inputs.workerRoot}=/vgpu/source/worker`,
      `-ffile-prefix-map=${buildDirectory}=/vgpu/build`,
      `-fmacro-prefix-map=${buildDirectory}=/vgpu/build`,
    ]) {
      if (!entry.command.includes(required)) {
        fail(`${architecture} compile command omitted ${required}`);
      }
    }
    if (/\s-D(?:DAWN_ENABLE|TINT_BUILD)_[A-Z0-9_]+=1\b/u.test(entry.command)) {
      const allowed = [
        "-DTINT_BUILD_IS_MAC=1",
        "-DTINT_BUILD_MSL_WRITER=1",
        "-DTINT_BUILD_WGSL_READER=1",
      ];
      const enabled =
        entry.command.match(/-D(?:DAWN_ENABLE|TINT_BUILD)_[A-Z0-9_]+=1\b/gu) ??
        [];
      for (const define of enabled) {
        if (!allowed.includes(define)) {
          fail(`${architecture} compile command enabled forbidden ${define}`);
        }
      }
    }
  }

  const ninjaLog = readFileSync(join(buildDirectory, ".ninja_log"), "utf8");
  const outputs = new Set(
    ninjaLog
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => line.split("\t")[3])
  );
  for (const output of outputs) {
    if (
      /(?:^|\/)src\/dawn\/native\//u.test(output) ||
      /(?:webgpu|monolithic|tint_cmd)/iu.test(output)
    ) {
      fail(`${architecture} built forbidden target output ${output}`);
    }
  }
  if (
    ![...outputs].some((output) => output.endsWith("src/tint/libtint_api.a"))
  ) {
    fail(`${architecture} did not build the direct tint_api root`);
  }
  const inputsClosure = verifyBuildInputClosures(buildDirectory, inputs);
  return {
    archives: archives.length,
    tintArchives: tint.length,
    abseilArchives: abseil.length,
    dawnSharedArchives: dawnShared.length,
    builtOutputs: outputs.size,
    declaredRoot: "tint_api",
    orderedArchiveSha256: lock.build.linkArchives.sha256,
    sourceInputs: inputsClosure,
  };
}

function inspectThinBinary(executable, architecture, inputs, buildDirectory) {
  const file = stdoutText(
    systemTools.file,
    [executable],
    `${architecture} file inspection`
  );
  if (
    !file.includes("Mach-O 64-bit executable") ||
    !file.includes(architecture)
  ) {
    fail(`${architecture} output is not the expected thin Mach-O: ${file}`);
  }
  assertEqual(
    stdoutText(
      systemTools.lipo,
      ["-archs", executable],
      `${architecture} lipo inspection`
    ),
    architecture,
    `${architecture} thin slice`
  );
  const loadCommands = stdoutText(
    systemTools.otool,
    ["-l", executable],
    `${architecture} load commands`
  );
  if (!/\bminos\s+14\.0\b/u.test(loadCommands)) {
    fail(`${architecture} binary does not declare macOS 14.0`);
  }
  if (!/\bsdk\s+14\.5\b/u.test(loadCommands)) {
    fail(`${architecture} binary was not linked against macOS SDK 14.5`);
  }
  if (loadCommands.includes("LC_RPATH")) {
    fail(`${architecture} binary unexpectedly contains LC_RPATH`);
  }
  const linked = stdoutText(
    systemTools.otool,
    ["-L", executable],
    `${architecture} dynamic dependencies`
  )
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean);
  const expectedLibraries = [
    "/usr/lib/libSystem.B.dylib",
    "/usr/lib/libc++.1.dylib",
  ];
  assertEqual(
    JSON.stringify([...linked].sort()),
    JSON.stringify([...expectedLibraries].sort()),
    `${architecture} dynamic dependency closure`
  );
  const symbols = stdoutText(
    systemTools.nm,
    ["-gU", executable],
    `${architecture} symbol inspection`
  );
  if (
    /(?:webgpu|wgpu|dawn::native|dawn_native|MetalBackend|VulkanBackend)/iu.test(
      symbols
    )
  ) {
    fail(`${architecture} binary exposes a forbidden runtime backend symbol`);
  }
  const binaryBytes = readFileSync(executable);
  for (const physicalPath of [
    inputs.dawnRoot,
    inputs.jsoncppRoot,
    inputs.workerRoot,
    buildDirectory,
  ]) {
    if (binaryBytes.includes(Buffer.from(physicalPath, "utf8"))) {
      fail(`${architecture} binary embeds physical path ${physicalPath}`);
    }
  }
  const observed = {
    architecture,
    bytes: binaryBytes.length,
    sha256: sha256Buffer(binaryBytes),
    minimumMacOS: "14.0",
    sdk: "14.5",
    dynamicLibraries: linked.sort(),
    frameworks: [],
  };
  const expectedOutput = lock.build.outputs[architecture];
  assertEqual(
    observed.bytes,
    expectedOutput.bytes,
    `${architecture} binary bytes`
  );
  assertEqual(
    observed.sha256,
    expectedOutput.sha256,
    `${architecture} binary SHA-256`
  );
  return observed;
}

function configureAndBuild({ architecture, copy, buildRoot, inputs, jobs }) {
  const buildDirectory = join(buildRoot, `build-${architecture}-${copy}`);
  process.stderr.write(
    `C1 direct Tint build: configure ${architecture}/${copy}\n`
  );
  checkedCommand(
    inputs.cmake,
    [
      "-S",
      fixtureDirectory,
      "-B",
      buildDirectory,
      "-G",
      "Ninja",
      "-DCMAKE_BUILD_TYPE=Release",
      `-DCMAKE_MAKE_PROGRAM=${inputs.ninja}`,
      `-DCMAKE_C_COMPILER=${inputs.cCompiler}`,
      `-DCMAKE_CXX_COMPILER=${inputs.cxxCompiler}`,
      `-DPython3_EXECUTABLE=${inputs.python}`,
      `-DCMAKE_OSX_ARCHITECTURES=${architecture}`,
      `-DCMAKE_OSX_SYSROOT=${inputs.sdkRoot}`,
      "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0",
      "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
      `-DVGPU_DAWN_ROOT=${inputs.dawnRoot}`,
      `-DVGPU_JSONCPP_ROOT=${inputs.jsoncppRoot}`,
      `-DVGPU_WORKER_ROOT=${inputs.workerRoot}`,
    ],
    `${architecture}/${copy} configure`
  );
  verifyCache(buildDirectory, architecture, inputs);
  process.stderr.write(`C1 direct Tint build: build ${architecture}/${copy}\n`);
  checkedCommand(
    inputs.cmake,
    [
      "--build",
      buildDirectory,
      "--target",
      "vgpu-tint-worker",
      "--parallel",
      String(jobs),
    ],
    `${architecture}/${copy} build`
  );
  const graph = verifyBuildGraph(buildDirectory, architecture, inputs);
  const executable = join(buildDirectory, "vgpu-tint-worker");
  const binary = inspectThinBinary(
    executable,
    architecture,
    inputs,
    buildDirectory
  );
  return { buildDirectory, executable, graph, binary };
}

function runWorker(executable, execution, request, label) {
  const commandName = execution === "native" ? executable : systemTools.arch;
  const args = execution === "native" ? [] : ["-x86_64", executable];
  const result = command(commandName, args, {
    input: request,
    timeout: 60_000,
  });
  if (result.error || result.signal || result.status !== 0) {
    const cause =
      result.error?.message ?? result.signal ?? `exit ${result.status}`;
    fail(`${label} worker failed (${cause}): ${tail(result.stderr)}`);
  }
  if (result.stderr.length !== 0) fail(`${label} worker wrote to stderr`);
  if (!isUtf8(result.stdout)) fail(`${label} worker emitted invalid UTF-8`);
  let decoded;
  try {
    decoded = JSON.parse(result.stdout.toString("utf8"));
  } catch (error) {
    fail(`${label} worker emitted invalid JSON: ${error.message}`);
  }
  assertEqual(
    decoded?.compiler?.upstream?.revision,
    lock.dawn.commit,
    `${label} response Tint revision`
  );
  return { bytes: result.stdout, decoded };
}

function verifyRequestParity(builds, universal, oracle) {
  const fixtureIds = [
    "noop",
    "runtime-array",
    "wgsl-error",
    // This checked-in request retains a historical fixture name, but the real
    // worker does not inject failures and successfully translates it.
    "generate-failure",
  ];
  const directVariants = [
    ["arm64/a", builds.arm64.a.executable, "native"],
    ["arm64/b", builds.arm64.b.executable, "native"],
    ["x86_64/a", builds.x86_64.a.executable, "rosetta"],
    ["x86_64/b", builds.x86_64.b.executable, "rosetta"],
    ["universal/a-arm64", universal.a, "native"],
    ["universal/a-x86_64", universal.a, "rosetta"],
    ["universal/b-arm64", universal.b, "native"],
    ["universal/b-x86_64", universal.b, "rosetta"],
  ];
  const results = {};
  for (const id of fixtureIds) {
    const expected = lock.oracle.canaries[id];
    if (!expected) fail(`oracle canary ${id} is not locked`);
    const request = readFileSync(join(requestDirectory, `${id}.json`));
    const requestSha256 = sha256Buffer(request);
    assertEqual(requestSha256, expected.requestSha256, `${id} request SHA-256`);
    const reference = runWorker(
      oracle.executable,
      "native",
      request,
      `${id} monolithic oracle`
    );
    const responseSha256 = sha256Buffer(reference.bytes);
    assertEqual(
      reference.bytes.length,
      expected.responseBytes,
      `${id} response bytes`
    );
    assertEqual(
      responseSha256,
      expected.responseSha256,
      `${id} response SHA-256`
    );
    assertEqual(reference.decoded.ok, expected.ok, `${id} oracle ok`);
    for (const [variant, executable, execution] of directVariants) {
      const result = runWorker(
        executable,
        execution,
        request,
        `${id} ${variant}`
      );
      if (!result.bytes.equals(reference.bytes)) {
        fail(
          `${id} response from ${variant} differs from the monolithic oracle canary`
        );
      }
    }
    results[id] = {
      requestSha256,
      responseBytes: reference.bytes.length,
      responseSha256,
      directVariants: directVariants.length,
      oracleMatched: true,
      ok: reference.decoded.ok,
    };
  }
  return results;
}

function createUniversal(builds, buildRoot) {
  const output = {};
  for (const copy of ["a", "b"]) {
    const path = join(buildRoot, `vgpu-tint-worker-universal-${copy}`);
    checkedCommand(
      systemTools.lipo,
      [
        "-create",
        builds.arm64[copy].executable,
        builds.x86_64[copy].executable,
        "-output",
        path,
      ],
      `universal/${copy} creation`
    );
    assertEqual(
      stdoutText(
        systemTools.lipo,
        ["-archs", path],
        `universal/${copy} inspection`
      ),
      "x86_64 arm64",
      `universal/${copy} architectures`
    );
    for (const architecture of ["arm64", "x86_64"]) {
      const linked = stdoutText(
        systemTools.otool,
        ["-arch", architecture, "-L", path],
        `universal/${copy} ${architecture} dependencies`
      );
      if (linked.includes(".framework/") || linked.includes("libwebgpu")) {
        fail(
          `universal/${copy} ${architecture} contains a forbidden dependency`
        );
      }
    }
    output[copy] = path;
  }
  const aHash = sha256File(output.a);
  const bHash = sha256File(output.b);
  assertEqual(bHash, aHash, "universal A/B binary SHA-256");
  assertEqual(
    statSync(output.a).size,
    lock.build.outputs.universal.bytes,
    "universal binary bytes"
  );
  assertEqual(
    aHash,
    lock.build.outputs.universal.sha256,
    "universal binary SHA-256"
  );
  return {
    ...output,
    bytes: statSync(output.a).size,
    sha256: aHash,
    architectures: ["arm64", "x86_64"],
  };
}

function binaryNotices() {
  const jsoncpp = readJSON(
    resolve(fixtureDirectory, lock.dependencies.jsoncpp.sharedProvenance)
  );
  return [
    {
      dependency: "Dawn/Tint linked closure",
      spdx: lock.dawn.license.linkedClosureSpdx,
      source: join(
        fixtureDirectory,
        "provenance",
        lock.dawn.license.trackedPath
      ),
      filename: "Dawn-Tint.txt",
      bytes: lock.dawn.license.bytes,
      sha256: lock.dawn.license.sha256,
    },
    {
      dependency: "Abseil",
      spdx: lock.dependencies.abseil.license.spdx,
      source: join(
        fixtureDirectory,
        "provenance",
        lock.dependencies.abseil.license.trackedPath
      ),
      filename: "Abseil.txt",
      bytes: lock.dependencies.abseil.license.bytes,
      sha256: lock.dependencies.abseil.license.sha256,
    },
    {
      dependency: "JsonCpp",
      spdx: jsoncpp.license.spdx,
      source: join(
        compilerProtocolDirectory,
        "provenance",
        jsoncpp.license.trackedPath
      ),
      filename: "JsonCpp.txt",
      bytes: jsoncpp.license.bytes,
      sha256: jsoncpp.license.sha256,
    },
  ];
}

function publishArtifacts(builds, universal, report, notices) {
  const stagingDirectory = mkdtempSync(
    join(fixtureDirectory, ".artifacts-staging-")
  );
  let published = false;
  try {
    if (existsSync(artifactsDirectory)) {
      fail("artifact destination reappeared while the gate was running");
    }
    const binaryDirectory = join(stagingDirectory, "bin");
    const licenseDirectory = join(stagingDirectory, "licenses");
    mkdirSync(binaryDirectory);
    mkdirSync(licenseDirectory);
    copyFileSync(
      builds.arm64.a.executable,
      join(binaryDirectory, "vgpu-tint-worker-arm64")
    );
    copyFileSync(
      builds.x86_64.a.executable,
      join(binaryDirectory, "vgpu-tint-worker-x86_64")
    );
    copyFileSync(
      universal.a,
      join(binaryDirectory, "vgpu-tint-worker-universal")
    );
    for (const notice of notices) {
      assertEqual(
        statSync(notice.source).size,
        notice.bytes,
        `${notice.dependency} notice size`
      );
      assertEqual(
        sha256File(notice.source),
        notice.sha256,
        `${notice.dependency} notice SHA-256`
      );
      copyFileSync(notice.source, join(licenseDirectory, notice.filename));
    }
    writeFileSync(
      join(stagingDirectory, "observed.json"),
      `${JSON.stringify(report, null, 2)}\n`
    );
    renameSync(stagingDirectory, artifactsDirectory);
    published = true;
  } finally {
    if (!published) {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }
}

function buildMonolithicOracle(inputs, buildRoot, compileTintPrototype) {
  const scratch = join(buildRoot, "monolithic-oracle");
  mkdirSync(scratch);
  process.stderr.write(
    "C1 direct Tint build: build monolithic reference oracle\n"
  );
  const oracle = compileTintPrototype({
    fixtureDirectory: compilerProtocolDirectory,
    releaseRoot: inputs.releaseRoot,
    compatInclude: inputs.compatInclude,
    jsoncppRoot: inputs.jsoncppRoot,
    scratch,
  });
  const description = stdoutText(
    systemTools.file,
    [oracle.executable],
    "monolithic oracle inspection"
  );
  if (!description.includes("Mach-O 64-bit executable arm64")) {
    fail(`monolithic oracle is not an arm64 Mach-O: ${description}`);
  }
  const loadCommands = stdoutText(
    systemTools.otool,
    ["-l", oracle.executable],
    "monolithic oracle load commands"
  );
  if (!/\bminos\s+26\.0\b/u.test(loadCommands)) {
    fail("monolithic oracle does not declare its expected macOS 26.0 minimum");
  }
  return {
    ...oracle,
    architecture: "arm64",
    role: "reference-only; never published or distributed",
    linkRoot: "libwebgpu_dawn.a",
    minimumMacOS: "26.0",
  };
}

function createScratch(options) {
  if (options.scratchRoot) {
    const parent = resolve(options.scratchRoot);
    mkdirSync(parent, { recursive: true });
    return mkdtempSync(join(parent, "c1-tint-direct-build-"));
  }
  return mkdtempSync(join(tmpdir(), "vgpu-c1-tint-direct-build-"));
}

function compactBuildEvidence(builds) {
  return Object.fromEntries(
    Object.entries(builds).map(([architecture, copies]) => [
      architecture,
      {
        binary: copies.a.binary,
        graph: copies.a.graph,
        deterministicRebuild:
          copies.a.binary.sha256 === copies.b.binary.sha256 &&
          copies.a.binary.bytes === copies.b.binary.bytes,
        rebuildSha256: copies.b.binary.sha256,
      },
    ])
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const pureHelp =
    argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h");
  if (pureHelp) {
    usage(process.stdout);
    return;
  }
  // A failed or interrupted gate must never leave an older PASS visible.
  rmSync(artifactsDirectory, { recursive: true, force: true });
  lock = readJSON(join(fixtureDirectory, "provenance", "source-lock.json"));
  requestDirectory = resolve(fixtureDirectory, lock.oracle.requests.root);
  defaultWorkerRoot = resolve(fixtureDirectory, lock.worker.defaultRoot);
  const options = parseArguments(argv);
  const inputs = verifySourceInputs(options);
  const compilerModule = await import(
    pathToFileURL(inputs.oracle.files.nativeCompiler).href
  );
  if (typeof compilerModule.compileTintPrototype !== "function") {
    fail("locked native compiler helper omitted compileTintPrototype");
  }
  const toolchain = verifyToolchain(inputs);
  const buildRoot = createScratch(options);
  let completed = false;
  try {
    const oracle = buildMonolithicOracle(
      inputs,
      buildRoot,
      compilerModule.compileTintPrototype
    );
    const builds = { arm64: {}, x86_64: {} };
    for (const architecture of lock.build.architectures) {
      for (const copy of ["a", "b"]) {
        builds[architecture][copy] = configureAndBuild({
          architecture,
          copy,
          buildRoot,
          inputs,
          jobs: options.jobs,
        });
      }
      assertEqual(
        builds[architecture].b.binary.sha256,
        builds[architecture].a.binary.sha256,
        `${architecture} A/B binary SHA-256`
      );
    }

    const universal = createUniversal(builds, buildRoot);
    process.stderr.write(
      "C1 direct Tint build: compare direct workers with monolithic oracle\n"
    );
    const requests = verifyRequestParity(builds, universal, oracle);
    const finalInputs = verifySourceInputs(options);
    assertEqual(
      JSON.stringify({
        revisions: finalInputs.revisions,
        closures: finalInputs.closures,
      }),
      JSON.stringify({
        revisions: inputs.revisions,
        closures: inputs.closures,
      }),
      "post-build source identity"
    );
    for (const architecture of lock.build.architectures) {
      for (const copy of ["a", "b"]) {
        const finalClosures = verifyBuildInputClosures(
          builds[architecture][copy].buildDirectory,
          inputs
        );
        assertEqual(
          JSON.stringify(finalClosures),
          JSON.stringify(builds[architecture][copy].graph.sourceInputs),
          `${architecture}/${copy} post-build source closure`
        );
      }
    }
    const notices = binaryNotices();
    const report = {
      schemaVersion: 1,
      status: "passed",
      profile: lock.profile,
      source: {
        dawn: inputs.revisions.dawn,
        abseil: inputs.revisions.abseil,
        spirvHeaders: {
          ...inputs.revisions.spirvHeaders,
          role: lock.dependencies.spirvHeaders.role,
        },
        spirvTools: lock.dependencies.spirvTools,
        jsoncpp: inputs.revisions.jsoncpp,
        workerClosure: inputs.closures.worker,
      },
      toolchain: {
        ...toolchain,
        sdkVersion: inputs.sdkVersion,
        minimumMacOS: lock.build.minimumMacOS,
      },
      oracle: {
        role: oracle.role,
        architecture: oracle.architecture,
        linkRoot: oracle.linkRoot,
        minimumMacOS: oracle.minimumMacOS,
        sha256: oracle.sha256,
        published: false,
      },
      builds: compactBuildEvidence(builds),
      universal: {
        architectures: universal.architectures,
        bytes: universal.bytes,
        sha256: universal.sha256,
        deterministicRebuild: true,
      },
      execution: {
        arm64: "native",
        x86_64: "Rosetta via arch -x86_64",
        requests,
      },
      distribution: {
        notices: notices.map(({ source: _source, ...notice }) => notice),
        spirvHeaders: "configure-only; source license is not a binary notice",
      },
    };
    publishArtifacts(builds, universal, report, notices);
    completed = true;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (options.keepBuilds) {
      process.stderr.write(
        `C1 direct Tint build: kept build roots at ${buildRoot}\n`
      );
    } else {
      rmSync(buildRoot, { recursive: true, force: true });
    }
    if (!completed) {
      process.stderr.write("C1 direct Tint build: gate did not complete\n");
    }
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
  process.exit(1);
}
