#!/usr/bin/env node

import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const artifactsDirectory = join(fixtureDirectory, ".artifacts");
const repositoryRoot = resolve(fixtureDirectory, "..", "..", "..");
const contextDirectory = join(repositoryRoot, ".context");
const compilerProtocolDirectory = resolve(
  fixtureDirectory,
  "..",
  "c1-compiler-protocol"
);
const compilerContractId = "vgpu-native-tint-compiler/v1";
const inventoryContractId = "vgpu-native-tint-entry-inventory/v1";
const semanticExtractionContractId = "vgpu-native-tint-semantic-extraction/v1";
let lock;
let baseLockSha256;
let localHeadCommit;
let candidateMode = false;
const candidateMeasurements = new Map();
let candidateCanaries;
let baselineLockShape;
let invocationLockDirectory;
let requestDirectory;
let defaultWorkerRoot;
let Ajv2020;
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
const legacyOracleInputIds = [
  "releasesManifest",
  "jsoncppProvenance",
  "nativeCompiler",
  "protocol",
];
const compilerOracleInputIds = [
  ...legacyOracleInputIds,
  "originSchema",
  "requestSchema",
  "responseSchema",
];
const inventoryOracleInputIds = [
  "releasesManifest",
  "jsoncppProvenance",
  "nativeCompiler",
  "protocol",
  "originMapProtocol",
  "originSchema",
  "requestSchema",
  "responseSchema",
  "inventoryProtocol",
  "inventoryRequestSchema",
  "inventoryResponseSchema",
];
const fixedInterfaceOracleInputIds = [
  ...inventoryOracleInputIds,
  "semanticExtractionProtocol",
  "semanticExtractionRequestSchema",
  "semanticExtractionResponseSchema",
];
const currentOracleInputIds = [
  ...inventoryOracleInputIds,
  "semanticExtractionProtocol",
  "semanticResourceGraph",
  "semanticExtractionRequestSchema",
  "semanticExtractionResponseSchema",
  "semanticActiveResourceResponse",
];
const oracleInputs = [
  {
    id: "releasesManifest",
    path: "../c1-tint-standalone/provenance/releases.json",
    mutable: false,
  },
  {
    id: "jsoncppProvenance",
    path: "../c1-compiler-protocol/provenance/jsoncpp-1.9.8.json",
    mutable: false,
  },
  {
    id: "nativeCompiler",
    path: "../c1-compiler-protocol/lib/native-compiler.mjs",
    mutable: true,
  },
  {
    id: "protocol",
    path: "../c1-compiler-protocol/lib/protocol.mjs",
    mutable: true,
  },
  {
    id: "originMapProtocol",
    path: "../c1-compiler-protocol/lib/origin-map.mjs",
    mutable: true,
  },
  {
    id: "originSchema",
    path: "../c1-compiler-protocol/contracts/origin-map-v1.schema.json",
    mutable: true,
  },
  {
    id: "requestSchema",
    path: "../c1-compiler-protocol/contracts/request-v1.schema.json",
    mutable: true,
  },
  {
    id: "responseSchema",
    path: "../c1-compiler-protocol/contracts/response-v1.schema.json",
    mutable: true,
  },
  {
    id: "inventoryProtocol",
    path: "../c1-semantic-bridge/lib/protocol.mjs",
    mutable: true,
  },
  {
    id: "inventoryRequestSchema",
    path: "../c1-semantic-bridge/contracts/inventory-request-v1.schema.json",
    mutable: true,
  },
  {
    id: "inventoryResponseSchema",
    path: "../c1-semantic-bridge/contracts/inventory-response-v1.schema.json",
    mutable: true,
  },
  {
    id: "semanticExtractionProtocol",
    path: "../c1-semantic-bridge/lib/semantic-extraction-protocol.mjs",
    mutable: true,
  },
  {
    id: "semanticResourceGraph",
    path: "../c1-semantic-bridge/lib/semantic-resource-graph.mjs",
    mutable: true,
  },
  {
    id: "semanticExtractionRequestSchema",
    path: "../c1-semantic-bridge/contracts/semantic-extraction-request-v1.schema.json",
    mutable: true,
  },
  {
    id: "semanticExtractionResponseSchema",
    path: "../c1-semantic-bridge/contracts/semantic-extraction-response-v1.schema.json",
    mutable: true,
  },
  {
    id: "semanticActiveResourceResponse",
    path: "../c1-semantic-bridge/fixtures/semantic-extraction/responses/active-resource.json",
    mutable: true,
  },
];
const legacyOracleRequestRoot = "../c1-compiler-protocol/fixtures/requests";
const legacyOracleRequestPaths = [
  "generate-failure.json",
  "noop.json",
  "runtime-array.json",
  "wgsl-error.json",
];
const oracleRequestRoot = "..";
const oracleFixtures = [
  {
    id: "generate-failure",
    ok: true,
    path: "c1-compiler-protocol/fixtures/requests/generate-failure.json",
  },
  {
    id: "noop",
    ok: true,
    path: "c1-compiler-protocol/fixtures/requests/noop.json",
  },
  {
    id: "runtime-array",
    ok: true,
    path: "c1-compiler-protocol/fixtures/requests/runtime-array.json",
  },
  {
    id: "wgsl-error",
    ok: false,
    path: "c1-compiler-protocol/fixtures/requests/wgsl-error.json",
  },
  {
    id: "inventory-empty-module",
    ok: true,
    path: "c1-semantic-bridge/fixtures/requests/empty-module.json",
  },
  {
    id: "inventory-invalid-wgsl",
    ok: false,
    path: "c1-semantic-bridge/fixtures/requests/invalid-wgsl.json",
  },
  {
    id: "inventory-library-only",
    ok: true,
    path: "c1-semantic-bridge/fixtures/requests/library-only.json",
  },
  {
    id: "inventory-multi-stage",
    ok: true,
    path: "c1-semantic-bridge/fixtures/requests/multi-stage.json",
  },
  {
    id: "semantic-active-override",
    ok: false,
    path: "c1-semantic-bridge/fixtures/semantic-extraction/requests/active-override.json",
  },
  {
    id: "semantic-active-resource",
    ok: true,
    path: "c1-semantic-bridge/fixtures/semantic-extraction/requests/active-resource.json",
  },
  {
    id: "semantic-compute-interface",
    ok: true,
    path: "c1-semantic-bridge/fixtures/semantic-extraction/requests/compute-interface.json",
  },
  {
    id: "semantic-render-interface",
    ok: true,
    path: "c1-semantic-bridge/fixtures/semantic-extraction/requests/render-interface.json",
  },
  {
    id: "compute-builtins",
    ok: true,
    path: "c1-tint-direct-build/fixtures/requests/compute-builtins.json",
  },
  {
    id: "dual-source",
    ok: true,
    path: "c1-tint-direct-build/fixtures/requests/dual-source.json",
  },
  {
    id: "fragment-sparse",
    ok: true,
    path: "c1-tint-direct-build/fixtures/requests/fragment-sparse.json",
  },
  {
    id: "interface-mismatch",
    ok: false,
    path: "c1-tint-direct-build/fixtures/requests/interface-mismatch.json",
  },
  {
    id: "scalar-fragment",
    ok: true,
    path: "c1-tint-direct-build/fixtures/requests/scalar-fragment.json",
  },
  {
    id: "vertex-sparse",
    ok: true,
    path: "c1-tint-direct-build/fixtures/requests/vertex-sparse.json",
  },
];
const oracleFixtureIds = oracleFixtures.map(({ id }) => id);
const oracleRequestPaths = oracleFixtures.map(({ path }) => path);
const compilerOracleFixtureIds = [
  "generate-failure",
  "noop",
  "runtime-array",
  "wgsl-error",
  "compute-builtins",
  "dual-source",
  "fragment-sparse",
  "interface-mismatch",
  "scalar-fragment",
  "vertex-sparse",
];
const inventoryOracleFixtureIds = [
  "generate-failure",
  "noop",
  "runtime-array",
  "wgsl-error",
  "inventory-empty-module",
  "inventory-invalid-wgsl",
  "inventory-library-only",
  "inventory-multi-stage",
  "compute-builtins",
  "dual-source",
  "fragment-sparse",
  "interface-mismatch",
  "scalar-fragment",
  "vertex-sparse",
];
const currentOracleFixtureIds = [
  "generate-failure",
  "noop",
  "runtime-array",
  "wgsl-error",
  "inventory-empty-module",
  "inventory-invalid-wgsl",
  "inventory-library-only",
  "inventory-multi-stage",
  "semantic-active-override",
  "semantic-active-resource",
  "semantic-compute-interface",
  "semantic-render-interface",
  "compute-builtins",
  "dual-source",
  "fragment-sparse",
  "interface-mismatch",
  "scalar-fragment",
  "vertex-sparse",
];
const compilerOracleRequestPaths = oracleRequestPathsForFixtureIds(
  compilerOracleFixtureIds
);
const inventoryOracleRequestPaths = oracleRequestPathsForFixtureIds(
  inventoryOracleFixtureIds
);
const currentOracleRequestPaths = oracleRequestPathsForFixtureIds(
  currentOracleFixtureIds
);
const mutableCompiledRepositories = ["dawn", "abseil", "jsoncpp", "worker"];
const valuedArguments = new Map([
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
  ["--emit-lock-candidate", "emitLockCandidate"],
]);

function fail(message) {
  throw new Error(`C1 direct Tint build: ${message}`);
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function oracleRequestPathsForFixtureIds(fixtureIds) {
  const pathsById = new Map(oracleFixtures.map(({ id, path }) => [id, path]));
  return fixtureIds.map((id) => {
    const path = pathsById.get(id);
    if (!path) fail(`oracle fixture cohort references unknown ID ${id}`);
    return path;
  });
}

function usage(stream = process.stderr) {
  stream.write(
    "Usage: node run.mjs --dawn-root <clean Dawn checkout> " +
      "--jsoncpp-root <clean JsonCpp checkout> " +
      "--release-root <monolithic Dawn release> " +
      "--compat-include <release header overlay> --sdk-root <macOS SDK> " +
      "[--cmake <cmake>] [--ninja <ninja>] [--c-compiler <clang>] " +
      "[--cxx-compiler <clang++>] [--python <python3>] [--jobs <count>] " +
      "[--scratch-root <directory>] [--keep-builds] " +
      "[--emit-lock-candidate <path-under-.context>]\n"
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
    emitLockCandidate: process.env.C1_TINT_DIRECT_BUILD_EMIT_LOCK_CANDIDATE,
    keepBuilds: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h")
      fail("help must be the only argument");
    if (argument === "--keep-builds") {
      options.keepBuilds = true;
      continue;
    }
    const key = valuedArguments.get(argument);
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
  if (options.emitLockCandidate !== undefined) {
    if (!options.emitLockCandidate) {
      fail("--emit-lock-candidate requires a non-empty path");
    }
    options.emitLockCandidate = resolveLockCandidatePath(
      options.emitLockCandidate
    );
  }
  return options;
}

function detectCandidateIntent(argv) {
  if (process.env.C1_TINT_DIRECT_BUILD_EMIT_LOCK_CANDIDATE !== undefined) {
    return true;
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--emit-lock-candidate") return true;
    if (argument === "--keep-builds") continue;
    if (!valuedArguments.has(argument)) return false;
    if (!argv[index + 1]) return false;
    index += 1;
  }
  return false;
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

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function resolveProspectivePath(path, label) {
  let cursor = resolve(path);
  const missing = [];
  while (true) {
    let metadata;
    try {
      metadata = lstatSync(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) fail(`${label} has no resolvable ancestor`);
      missing.unshift(basename(cursor));
      cursor = parent;
      continue;
    }
    let canonical;
    try {
      canonical = realpathSync(cursor);
    } catch {
      fail(`${label} has an unresolvable existing ancestor: ${cursor}`);
    }
    if (missing.length > 0 && !statSync(canonical).isDirectory()) {
      fail(`${label} has a non-directory ancestor: ${cursor}`);
    }
    return resolve(canonical, ...missing);
  }
}

function validateScratchRoot(options) {
  const configured = Boolean(options.scratchRoot);
  const scratchRoot = resolveProspectivePath(
    configured ? options.scratchRoot : tmpdir(),
    "scratch root"
  );
  const artifactDestination = resolveProspectivePath(
    artifactsDirectory,
    "artifact destination"
  );
  if (isWithinRootIgnoringAsciiCase(scratchRoot, artifactDestination)) {
    fail("the effective scratch root may not target .artifacts");
  }
  if (
    invocationLockDirectory &&
    isWithinRoot(scratchRoot, invocationLockDirectory)
  ) {
    fail(
      "the effective scratch root may not target the invocation-lock directory"
    );
  }
  options.effectiveScratchRoot = scratchRoot;
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

function verifyLockedFile(expected, label, mutablePointer) {
  const path = resolve(fixtureDirectory, expected.path);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} is not a regular file: ${path}`);
  }
  assertOrMeasure(
    metadata.size,
    expected.bytes,
    `${label} size`,
    mutablePointer ? `${mutablePointer}/bytes` : undefined
  );
  assertOrMeasure(
    sha256File(path),
    expected.sha256,
    `${label} SHA-256`,
    mutablePointer ? `${mutablePointer}/sha256` : undefined
  );
  return realpathSync(path);
}

function verifyOracleInputs() {
  const lockedIds = Object.keys(lock.oracle.inputs);
  const expectedIds = oracleInputIdsForLockShape(baselineLockShape);
  assertEqual(
    JSON.stringify(lockedIds),
    JSON.stringify(expectedIds),
    `${baselineLockShape} oracle input IDs`
  );
  const files = {};
  for (const input of oracleInputs) {
    const expected = lock.oracle.inputs[input.id];
    if (!expected && expectedIds.includes(input.id)) {
      fail(`oracle input ${input.id} is not locked`);
    }
    if (expected) {
      assertEqual(expected.path, input.path, `oracle ${input.id} path`);
    }
    files[input.id] = verifyLockedFile(
      expected ?? { path: input.path },
      `oracle ${input.id}`,
      input.mutable ? `/oracle/inputs/${input.id}` : undefined
    );
  }
  const expectedRequests = lock.oracle.requests;
  const requests = sha256SelectedFiles(
    requestDirectory,
    oracleRequestPaths,
    "oracle request closure"
  );
  assertEqual(
    requests.files,
    oracleFixtures.length,
    "oracle request closure intended file count"
  );
  for (const key of ["files", "bytes", "sha256"]) {
    assertOrMeasure(
      requests[key],
      expectedRequests[key],
      `oracle request closure ${key}`,
      `/oracle/requests/${key}`
    );
  }
  verifyFilesMatchGitHead(
    repositoryRoot,
    [
      ...oracleInputs
        .filter((input) => input.mutable)
        .map((input) => files[input.id]),
      ...oracleRequestPaths.map((path) =>
        realpathSync(join(requestDirectory, ...path.split("/")))
      ),
    ],
    "candidate local oracle inputs",
    localHeadCommit
  );
  const schemas = [
    readJSON(files.originSchema),
    readJSON(files.requestSchema),
    readJSON(files.responseSchema),
    readJSON(files.inventoryRequestSchema),
    readJSON(files.inventoryResponseSchema),
    readJSON(files.semanticExtractionRequestSchema),
    readJSON(files.semanticExtractionResponseSchema),
  ];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) ajv.addSchema(schema);
  const validators = {
    [compilerContractId]: {
      request: ajv.getSchema(schemas[1].$id),
      response: ajv.getSchema(schemas[2].$id),
    },
    [inventoryContractId]: {
      request: ajv.getSchema(schemas[3].$id),
      response: ajv.getSchema(schemas[4].$id),
    },
    [semanticExtractionContractId]: {
      request: ajv.getSchema(schemas[5].$id),
      response: ajv.getSchema(schemas[6].$id),
    },
  };
  for (const [contractId, contractValidators] of Object.entries(validators)) {
    if (!contractValidators.request || !contractValidators.response) {
      fail(`oracle schemas omitted validators for ${contractId}`);
    }
  }
  return { files, requests, validators };
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

function assertOrMeasure(actual, expected, label, jsonPointer) {
  if (!candidateMode || !jsonPointer) {
    assertEqual(actual, expected, label);
    return;
  }
  if (candidateMeasurements.has(jsonPointer)) {
    assertEqual(
      actual,
      candidateMeasurements.get(jsonPointer),
      `${label} across candidate measurements`
    );
    return;
  }
  candidateMeasurements.set(jsonPointer, actual);
}

function assertOracleFixtureDefinitions() {
  assertEqual(
    JSON.stringify(oracleInputs.map(({ id }) => id)),
    JSON.stringify(currentOracleInputIds),
    "current oracle input cohort"
  );
  assertEqual(
    JSON.stringify(oracleFixtureIds),
    JSON.stringify(currentOracleFixtureIds),
    "current oracle fixture cohort"
  );
  assertEqual(
    new Set(oracleFixtureIds).size,
    oracleFixtureIds.length,
    "oracle fixture ID uniqueness"
  );
  assertEqual(
    new Set(oracleRequestPaths).size,
    oracleRequestPaths.length,
    "oracle fixture path uniqueness"
  );
  assertEqual(
    JSON.stringify(oracleRequestPaths),
    JSON.stringify([...oracleRequestPaths].sort(compareUtf8)),
    "oracle fixture path order"
  );
  for (const fixture of oracleFixtures) {
    validateRelativePath(fixture.path, `oracle fixture ${fixture.id}`);
  }
  verifyMslMaskSelfCanary();
}

function oracleInputIdsForLockShape(shape) {
  switch (shape) {
    case "legacy":
      return legacyOracleInputIds;
    case "compiler":
      return compilerOracleInputIds;
    case "inventory":
      return inventoryOracleInputIds;
    case "current": {
      const lockedIds = Object.keys(lock?.oracle?.inputs ?? {});
      if (
        candidateMode &&
        JSON.stringify(lockedIds) ===
          JSON.stringify(fixedInterfaceOracleInputIds)
      ) {
        return fixedInterfaceOracleInputIds;
      }
      return currentOracleInputIds;
    }
    default:
      fail(`unknown oracle input lock shape ${String(shape)}`);
  }
}

function oracleFixtureIdsForLockShape(shape) {
  switch (shape) {
    case "legacy":
      return legacyOracleRequestPaths.map((path) => path.slice(0, -5));
    case "compiler":
      return compilerOracleFixtureIds;
    case "inventory":
      return inventoryOracleFixtureIds;
    case "current":
      return currentOracleFixtureIds;
    default:
      fail(`unknown oracle fixture lock shape ${String(shape)}`);
  }
}

function selectOracleRequestRoot() {
  assertOracleFixtureDefinitions();
  const expected = lock.oracle.requests;
  assertEqual(
    expected.algorithm,
    "relative-path-nul-file-sha256-lines-v1",
    "oracle request closure algorithm"
  );
  if (candidateMode) {
    const shapes = [
      {
        id: "legacy",
        root: legacyOracleRequestRoot,
        paths: legacyOracleRequestPaths,
      },
      {
        id: "compiler",
        root: oracleRequestRoot,
        paths: compilerOracleRequestPaths,
      },
      {
        id: "inventory",
        root: oracleRequestRoot,
        paths: inventoryOracleRequestPaths,
      },
      {
        id: "current",
        root: oracleRequestRoot,
        paths: currentOracleRequestPaths,
      },
    ];
    const recognized = shapes.find(
      (shape) =>
        expected.root === shape.root &&
        JSON.stringify(expected.paths) === JSON.stringify(shape.paths)
    );
    if (!recognized) {
      fail(
        "source lock has no recognized legacy, compiler-only, inventory, or current oracle request shape"
      );
    }
    baselineLockShape = recognized.id;
    const expectedCanaryIds = oracleFixtureIdsForLockShape(baselineLockShape);
    assertEqual(
      JSON.stringify(Object.keys(lock.oracle.canaries).sort(compareUtf8)),
      JSON.stringify([...expectedCanaryIds].sort(compareUtf8)),
      "recognized source-lock oracle canary IDs"
    );
  } else {
    baselineLockShape = "current";
    assertEqual(expected.root, oracleRequestRoot, "oracle request root");
    assertEqual(
      JSON.stringify(expected.paths),
      JSON.stringify(oracleRequestPaths),
      "oracle request paths"
    );
    assertEqual(
      JSON.stringify(Object.keys(lock.oracle.canaries)),
      JSON.stringify(oracleFixtureIds),
      "oracle canary IDs"
    );
  }
  return resolve(fixtureDirectory, oracleRequestRoot);
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
    JSON.stringify(lock.worker.closure.paths),
    JSON.stringify([...lock.worker.closure.paths].sort(compareUtf8)),
    "worker closure path order"
  );
  assertOrMeasure(
    workerClosure.sha256,
    lock.worker.closure.sha256,
    "worker closure SHA-256",
    "/worker/closure/sha256"
  );
  verifyFilesMatchGitHead(
    repositoryRoot,
    lock.worker.closure.paths.map((path) =>
      realpathSync(join(workerRoot, ...path.split("/")))
    ),
    "candidate worker closure",
    localHeadCommit
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

function foldAsciiCase(value) {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function isWithinRootIgnoringAsciiCase(path, root) {
  return isWithinRoot(foldAsciiCase(path), foldAsciiCase(root));
}

function acquireInvocationLock() {
  const contextRoot = resolveExisting(
    contextDirectory,
    ".context root",
    "directory"
  );
  const path = join(contextRoot, ".c1-tint-direct-build.invocation-lock");
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(
        `another invocation is active or left a stale lock at ${path}; verify no gate is running before removing it`
      );
    }
    throw error;
  }
  invocationLockDirectory = path;
}

function releaseInvocationLock() {
  if (!invocationLockDirectory) return;
  const path = invocationLockDirectory;
  invocationLockDirectory = undefined;
  rmdirSync(path);
}

function resolveLockCandidatePath(candidate) {
  const contextRoot = resolveExisting(
    contextDirectory,
    ".context root",
    "directory"
  );
  const absolute = resolve(candidate);
  if (
    absolute === contextDirectory ||
    !isWithinRoot(absolute, contextDirectory)
  ) {
    fail(
      "--emit-lock-candidate must name a file below the repository .context directory"
    );
  }
  const parent = resolveExisting(
    dirname(absolute),
    "lock candidate parent",
    "directory"
  );
  if (!isWithinRoot(parent, contextRoot)) {
    fail(
      "--emit-lock-candidate parent escapes the repository .context directory"
    );
  }
  const canonical = join(parent, basename(absolute));
  if (
    invocationLockDirectory &&
    isWithinRoot(canonical, invocationLockDirectory)
  ) {
    fail("--emit-lock-candidate may not target the invocation-lock directory");
  }
  let metadata;
  try {
    metadata = lstatSync(canonical);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (metadata) {
    fail(
      `--emit-lock-candidate refuses to overwrite existing ${
        metadata.isSymbolicLink() ? "symlink" : "path"
      }: ${canonical}`
    );
  }
  return canonical;
}

function escapeJsonPointer(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function setJsonPointer(target, pointer, value) {
  const parts = pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const key = parts.pop();
  let parent = target;
  for (const part of parts) {
    if (
      parent === null ||
      typeof parent !== "object" ||
      !Object.hasOwn(parent, part)
    ) {
      fail(`candidate measurement targets missing JSON pointer ${pointer}`);
    }
    parent = parent[part];
  }
  if (parent === null || typeof parent !== "object" || key === undefined) {
    fail(`candidate measurement targets invalid JSON pointer ${pointer}`);
  }
  parent[key] = value;
}

function diffJsonPointers(before, after, pointer = "") {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) return [pointer];
    if (before.length !== after.length) return [pointer];
    return before.flatMap((value, index) =>
      diffJsonPointers(value, after[index], `${pointer}/${index}`)
    );
  }
  const beforeObject =
    before !== null && typeof before === "object" ? before : undefined;
  const afterObject =
    after !== null && typeof after === "object" ? after : undefined;
  if (!beforeObject || !afterObject) return [pointer];
  const keys = [
    ...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)]),
  ].sort(compareUtf8);
  return keys.flatMap((key) => {
    const child = `${pointer}/${escapeJsonPointer(key)}`;
    if (!Object.hasOwn(beforeObject, key) || !Object.hasOwn(afterObject, key)) {
      return [child];
    }
    return diffJsonPointers(beforeObject[key], afterObject[key], child);
  });
}

function isAllowedCandidateChange(pointer) {
  const exact = new Set([
    "/worker/closure/sha256",
    "/oracle/requests/root",
    "/oracle/requests/files",
    "/oracle/requests/bytes",
    "/oracle/requests/sha256",
    "/oracle/requests/paths",
    "/closures/compiled/files",
    "/closures/compiled/bytes",
    "/closures/compiled/sha256",
    "/build/outputs/arm64/bytes",
    "/build/outputs/arm64/sha256",
    "/build/outputs/x86_64/bytes",
    "/build/outputs/x86_64/sha256",
    "/build/outputs/universal/bytes",
    "/build/outputs/universal/sha256",
  ]);
  if (exact.has(pointer)) return true;
  const baselineInputIds = oracleInputIdsForLockShape(baselineLockShape);
  for (const input of oracleInputs.filter((candidate) => candidate.mutable)) {
    const inputPointer = `/oracle/inputs/${input.id}`;
    if (
      pointer === `${inputPointer}/bytes` ||
      pointer === `${inputPointer}/sha256`
    ) {
      return true;
    }
    if (!baselineInputIds.includes(input.id) && pointer === inputPointer) {
      return true;
    }
  }
  for (const repository of mutableCompiledRepositories) {
    for (const field of ["files", "bytes", "sha256"]) {
      if (
        pointer === `/closures/compiled/repositories/${repository}/${field}`
      ) {
        return true;
      }
    }
  }
  const baselineFixtureIds = oracleFixtureIdsForLockShape(baselineLockShape);
  for (const id of oracleFixtureIds) {
    const canary = `/oracle/canaries/${escapeJsonPointer(id)}`;
    if (
      id === "semantic-active-resource" &&
      pointer === `${canary}/ok` &&
      lock.oracle.canaries[id]?.ok === false &&
      oracleFixtures.find((fixture) => fixture.id === id)?.ok === true
    ) {
      return true;
    }
    if (
      pointer === `${canary}/requestSha256` ||
      pointer === `${canary}/responseBytes` ||
      pointer === `${canary}/responseSha256`
    ) {
      return true;
    }
    if (!baselineFixtureIds.includes(id) && pointer === canary) {
      return true;
    }
  }
  return false;
}

function createLockCandidate() {
  const requiredMeasurements = [
    "/worker/closure/sha256",
    "/oracle/requests/files",
    "/oracle/requests/bytes",
    "/oracle/requests/sha256",
    "/closures/compiled/files",
    "/closures/compiled/bytes",
    "/closures/compiled/sha256",
    "/build/outputs/arm64/bytes",
    "/build/outputs/arm64/sha256",
    "/build/outputs/x86_64/bytes",
    "/build/outputs/x86_64/sha256",
    "/build/outputs/universal/bytes",
    "/build/outputs/universal/sha256",
  ];
  for (const input of oracleInputs.filter((candidate) => candidate.mutable)) {
    requiredMeasurements.push(
      `/oracle/inputs/${input.id}/bytes`,
      `/oracle/inputs/${input.id}/sha256`
    );
  }
  for (const repository of mutableCompiledRepositories) {
    for (const field of ["files", "bytes", "sha256"]) {
      requiredMeasurements.push(
        `/closures/compiled/repositories/${repository}/${field}`
      );
    }
  }
  assertEqual(
    JSON.stringify([...candidateMeasurements.keys()].sort(compareUtf8)),
    JSON.stringify([...requiredMeasurements].sort(compareUtf8)),
    "complete candidate measurement set"
  );
  assertEqual(
    JSON.stringify(Object.keys(candidateCanaries ?? {})),
    JSON.stringify(oracleFixtureIds),
    "candidate oracle canary IDs"
  );

  const proposed = structuredClone(lock);
  proposed.oracle.inputs = Object.fromEntries(
    oracleInputs.map((input) => [
      input.id,
      structuredClone(lock.oracle.inputs[input.id] ?? { path: input.path }),
    ])
  );
  proposed.oracle.requests.root = oracleRequestRoot;
  proposed.oracle.requests.paths = [...oracleRequestPaths];
  proposed.oracle.canaries = structuredClone(candidateCanaries);
  for (const [pointer, value] of candidateMeasurements) {
    setJsonPointer(proposed, pointer, value);
  }
  const changes = diffJsonPointers(lock, proposed);
  const forbidden = changes.filter(
    (pointer) => !isAllowedCandidateChange(pointer)
  );
  if (forbidden.length > 0) {
    fail(`lock candidate changed forbidden fields: ${forbidden.join(", ")}`);
  }
  return { proposed, changes };
}

function verifySourceLockIdentity() {
  assertEqual(
    sha256File(join(fixtureDirectory, "provenance", "source-lock.json")),
    baseLockSha256,
    "source lock identity across gate"
  );
}

function writeLockCandidate(path) {
  const verifiedPath = resolveLockCandidatePath(path);
  if (pathEntryExists(artifactsDirectory)) {
    fail(
      "lock candidate refuses to coexist with a published .artifacts directory"
    );
  }
  verifySourceLockIdentity();
  const { proposed, changes } = createLockCandidate();
  const contents = Buffer.from(
    `${JSON.stringify(proposed, null, 2)}\n`,
    "utf8"
  );
  verifyFilesMatchGitHead(
    repositoryRoot,
    [
      fileURLToPath(import.meta.url),
      join(fixtureDirectory, "provenance", "source-lock.json"),
    ],
    "candidate runner and source lock final check",
    localHeadCommit
  );
  verifySourceLockIdentity();
  if (pathEntryExists(artifactsDirectory)) {
    fail("lock candidate publication raced with a .artifacts directory");
  }
  writeFileSync(verifiedPath, contents, { flag: "wx" });
  return {
    path: verifiedPath,
    bytes: contents.length,
    sha256: sha256Buffer(contents),
    baseLockSha256,
    changedPointers: changes,
  };
}

function portableRelative(root, path, label) {
  if (!isWithinRoot(path, root)) fail(`${label} escaped its source root`);
  const portable = relative(root, path).split(sep).join("/");
  validateRelativePath(portable, label);
  return portable;
}

function verifyFilesMatchGitHead(root, paths, label, revision) {
  if (!candidateMode) return;
  if (!revision || !/^[a-f0-9]{40,64}$/u.test(revision)) {
    fail(`${label} omitted an exact Git revision`);
  }
  const canonicalRoot = realpathSync(root);
  const gitOptions = {
    env: {
      ...process.env,
      GIT_LITERAL_PATHSPECS: "1",
      GIT_NO_LAZY_FETCH: "1",
    },
  };
  const repository = resolveExisting(
    stdoutText(
      systemTools.git,
      ["-C", canonicalRoot, "rev-parse", "--show-toplevel"],
      `${label} Git root`,
      gitOptions
    ),
    `${label} Git root`,
    "directory"
  );
  assertEqual(repository, canonicalRoot, `${label} exact Git root`);
  assertEqual(
    stdoutText(
      systemTools.git,
      ["-C", canonicalRoot, "rev-parse", "HEAD^{commit}"],
      `${label} current Git revision`,
      gitOptions
    ),
    revision,
    `${label} stable Git revision`
  );
  const relativePaths = [...new Set(paths)]
    .map((path) => {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        fail(`${label} contains a non-regular worktree path: ${path}`);
      }
      const relativePath = portableRelative(canonicalRoot, path, label);
      if (/[\0\r\n]/u.test(relativePath)) {
        fail(`${label} contains a control character in ${relativePath}`);
      }
      return relativePath;
    })
    .sort(compareUtf8);
  if (relativePaths.length === 0) {
    fail(`${label} omitted every path from its scoped Git check`);
  }
  const indexResult = checkedCommand(
    systemTools.git,
    [
      "-C",
      canonicalRoot,
      "ls-files",
      "--stage",
      "-z",
      "--error-unmatch",
      "--",
      ...relativePaths,
    ],
    `${label} index entries`,
    gitOptions
  );
  const entries = new Map();
  for (const rawEntry of indexResult.stdout.toString("utf8").split("\0")) {
    if (!rawEntry) continue;
    const tab = rawEntry.indexOf("\t");
    const header = rawEntry.slice(0, tab).split(" ");
    const path = rawEntry.slice(tab + 1);
    if (
      tab < 0 ||
      header.length !== 3 ||
      !["100644", "100755"].includes(header[0]) ||
      !/^[a-f0-9]{40,64}$/u.test(header[1]) ||
      header[2] !== "0" ||
      entries.has(path)
    ) {
      fail(`${label} has an invalid, unmerged, or duplicate index entry`);
    }
    entries.set(path, { mode: header[0], oid: header[1] });
  }
  assertEqual(
    JSON.stringify([...entries.keys()].sort(compareUtf8)),
    JSON.stringify(relativePaths),
    `${label} exact stage-zero regular-file index paths`
  );
  checkedCommand(
    systemTools.git,
    [
      "-C",
      canonicalRoot,
      "diff-index",
      "--cached",
      "--quiet",
      revision,
      "--",
      ...relativePaths,
    ],
    `${label} index against HEAD`,
    gitOptions
  );
  checkedCommand(
    systemTools.git,
    ["-C", canonicalRoot, "diff-files", "--quiet", "--", ...relativePaths],
    `${label} worktree against index`,
    gitOptions
  );
  const observed = checkedCommand(
    systemTools.git,
    ["-C", canonicalRoot, "hash-object", "--no-filters", "--stdin-paths"],
    `${label} worktree blob hashes`,
    {
      ...gitOptions,
      input: Buffer.from(`${relativePaths.join("\n")}\n`, "utf8"),
    }
  )
    .stdout.toString("utf8")
    .trim()
    .split("\n");
  assertEqual(
    observed.length,
    relativePaths.length,
    `${label} worktree blob count`
  );
  for (let index = 0; index < relativePaths.length; index += 1) {
    const relativePath = relativePaths[index];
    assertEqual(
      observed[index],
      entries.get(relativePath).oid,
      `${label} ${relativePath} bytes at HEAD`
    );
    const executable =
      (lstatSync(join(canonicalRoot, ...relativePath.split("/"))).mode &
        0o111) !==
      0;
    assertEqual(
      executable,
      entries.get(relativePath).mode === "100755",
      `${label} ${relativePath} executable mode at HEAD`
    );
  }
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

function verifyClosure(
  paths,
  inputs,
  expected,
  label,
  { mutableRepositories = [], mutableCombined = false, pointer } = {}
) {
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
    if (candidateMode && mutableRepositories.includes(group.name)) {
      const gitRoot = group.name === "worker" ? repositoryRoot : group.root;
      const revision =
        group.name === "worker"
          ? localHeadCommit
          : {
              dawn: lock.dawn.commit,
              abseil: lock.dependencies.abseil.chromiumCheckoutCommit,
              jsoncpp: lock.dependencies.jsoncpp.commit,
            }[group.name];
      verifyFilesMatchGitHead(
        gitRoot,
        repositoryPaths,
        `${label} ${group.name}`,
        revision
      );
    }
    const summary = summarizeAbsoluteFiles(
      group.root,
      repositoryPaths,
      `${label} ${group.name}`
    );
    for (const key of ["files", "bytes", "sha256"]) {
      const mutable = mutableRepositories.includes(group.name);
      assertOrMeasure(
        summary[key],
        expectedRepository[key],
        `${label} ${group.name} ${key}`,
        mutable ? `${pointer}/repositories/${group.name}/${key}` : undefined
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
    assertOrMeasure(
      combined[key],
      expected[key],
      `${label} combined ${key}`,
      mutableCombined ? `${pointer}/${key}` : undefined
    );
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
    "compiled closure",
    {
      mutableRepositories: mutableCompiledRepositories,
      mutableCombined: true,
      pointer: "/closures/compiled",
    }
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
  assertOrMeasure(
    observed.bytes,
    expectedOutput.bytes,
    `${architecture} binary bytes`,
    `/build/outputs/${architecture}/bytes`
  );
  assertOrMeasure(
    observed.sha256,
    expectedOutput.sha256,
    `${architecture} binary SHA-256`,
    `/build/outputs/${architecture}/sha256`
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

function assertExactJSON(actual, expected, label) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), label);
}

function assertSchema(validate, value, label) {
  if (!validate(value)) {
    fail(
      `${label} failed schema validation: ${JSON.stringify(validate.errors)}`
    );
  }
}

function maskMslNonCode(source) {
  let state = "code";
  let quote;
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (character === "/" && next === "/") {
        output += "  ";
        index += 1;
        state = "line-comment";
      } else if (character === "/" && next === "*") {
        output += "  ";
        index += 1;
        state = "block-comment";
      } else if (character === '"' || character === "'") {
        output += " ";
        quote = character;
        state = "quoted";
      } else {
        output += character;
      }
      continue;
    }
    if (state === "line-comment") {
      output += character === "\n" ? "\n" : " ";
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else {
        output += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (character === "\\" && next !== undefined) {
      output += next === "\n" ? " \n" : "  ";
      index += 1;
    } else if (character === quote) {
      output += " ";
      state = "code";
      quote = undefined;
    } else {
      output += character === "\n" ? "\n" : " ";
    }
  }
  return output;
}

function verifyMslMaskSelfCanary() {
  const source =
    "// VGPU_LINE_DECOY\n" +
    "/* VGPU_BLOCK_DECOY */\n" +
    'constant char* text = "VGPU_STRING_DECOY";\n' +
    "constant char value = 'Q';\n" +
    "[[VGPU_REAL_ATTRIBUTE]]\n";
  const masked = maskMslNonCode(source);
  for (const decoy of [
    "VGPU_LINE_DECOY",
    "VGPU_BLOCK_DECOY",
    "VGPU_STRING_DECOY",
  ]) {
    if (masked.includes(decoy)) fail(`MSL lexical mask exposed ${decoy}`);
  }
  const characterOffset = source.indexOf("'Q'") + 1;
  if (
    masked[characterOffset] !== " " ||
    !masked.includes("[[VGPU_REAL_ATTRIBUTE]]")
  ) {
    fail("MSL lexical mask hid code or exposed a character literal");
  }
}

function assertMslIncludes(response, fragments, label) {
  if (typeof response?.result?.msl !== "string") {
    fail(`${label} omitted successful MSL output`);
  }
  const code = maskMslNonCode(response.result.msl);
  for (const fragment of fragments) {
    if (!code.includes(fragment)) {
      fail(`${label} MSL omitted ${JSON.stringify(fragment)}`);
    }
  }
}

function verifyOracleBranchEvidence(id, response) {
  switch (id) {
    case "noop":
    case "generate-failure":
      assertExactJSON(
        {
          interface: response.result?.interface,
          workgroup: response.result?.resolvedWorkgroupSize,
          bindings: response.result?.bindings,
          internalBindings: response.result?.internalBindings,
          sizeRegions: response.result?.storageBufferSizeRegions,
        },
        {
          interface: { kind: "compute" },
          workgroup: { x: 1, y: 1, z: 1 },
          bindings: [],
          internalBindings: [],
          sizeRegions: [],
        },
        `${id} empty compute evidence`
      );
      assertMslIncludes(
        response,
        [
          `kernel void ${
            id === "noop" ? "vgpu_noop" : "vgpu_writer_failure"
          }() {`,
        ],
        id
      );
      break;
    case "runtime-array":
      assertExactJSON(
        {
          interface: response.result?.interface,
          workgroup: response.result?.resolvedWorkgroupSize,
          bindings: response.result?.bindings,
          internalBindings: response.result?.internalBindings,
          sizeRegions: response.result?.storageBufferSizeRegions,
        },
        {
          interface: { kind: "compute" },
          workgroup: { x: 1, y: 1, z: 1 },
          bindings: [
            {
              group: 0,
              binding: 0,
              slots: [
                {
                  mode: "direct",
                  resourceClass: "buffer",
                  component: "buffer",
                  index: 0,
                  count: 1,
                },
              ],
            },
          ],
          internalBindings: [
            {
              role: "immediate-data",
              slots: [
                {
                  mode: "direct",
                  resourceClass: "buffer",
                  component: "buffer",
                  index: 30,
                  count: 1,
                },
              ],
            },
          ],
          sizeRegions: [{ stage: "compute", immediateDataByteOffset: 4 }],
        },
        `${id} runtime-array transport evidence`
      );
      assertMslIncludes(
        response,
        ["[[buffer(0)]]", "[[buffer(30)]]", "tint_storage_buffer_sizes"],
        id
      );
      break;
    case "wgsl-error": {
      const diagnostic = response.diagnostics?.find(
        (candidate) =>
          candidate.code === "VGPU-NATIVE-WGSL-INVALID" &&
          candidate.phase === "wgsl" &&
          candidate.severity === "error"
      );
      if (!diagnostic) fail(`${id} omitted its WGSL validation diagnostic`);
      assertExactJSON(
        diagnostic.location,
        {
          kind: "generated-wgsl",
          virtualPath: "resolved/imported-error.wgsl",
          start: { line: 3, column: 10 },
          end: { line: 3, column: 13 },
          origin: { input: "helper-wgsl", precision: "module" },
        },
        `${id} attributed diagnostic location`
      );
      break;
    }
    case "inventory-invalid-wgsl":
      assertExactJSON(
        { ok: response.ok, diagnostics: response.diagnostics },
        {
          ok: false,
          diagnostics: [
            {
              code: "VGPU-NATIVE-WGSL-INVALID",
              severity: "error",
              phase: "wgsl",
              message:
                "cannot convert value of type 'abstract-float' to type 'u32'",
              location: {
                kind: "generated-wgsl",
                virtualPath: "Intermediate/inventory-invalid.wgsl",
                start: { line: 1, column: 60 },
                end: { line: 1, column: 63 },
              },
            },
          ],
        },
        `${id} exact invalid inventory evidence`
      );
      break;
    case "inventory-empty-module":
    case "inventory-library-only":
      assertExactJSON(
        {
          ok: response.ok,
          diagnostics: response.diagnostics,
          result: response.result,
        },
        { ok: true, diagnostics: [], result: { entryPoints: [] } },
        `${id} exact empty inventory evidence`
      );
      break;
    case "inventory-multi-stage":
      assertExactJSON(
        {
          ok: response.ok,
          diagnostics: response.diagnostics,
          result: response.result,
        },
        {
          ok: true,
          diagnostics: [],
          result: {
            entryPoints: [
              { stage: "vertex", wgsl: "alpha" },
              { stage: "vertex", wgsl: "zebra" },
              { stage: "fragment", wgsl: "beta" },
              { stage: "fragment", wgsl: "gamma" },
              { stage: "compute", wgsl: "zed" },
            ],
          },
        },
        `${id} exact multi-stage inventory evidence`
      );
      break;
    case "semantic-active-override":
      assertExactJSON(
        { ok: response.ok, diagnostics: response.diagnostics },
        {
          ok: false,
          diagnostics: [
            {
              code: "VGPU-NATIVE-TINT-SEMANTIC-OVERRIDE-UNSUPPORTED",
              severity: "error",
              phase: "inspect",
              message:
                "selected program uses overrides outside the fixed-resource profile",
            },
          ],
        },
        `${id} exact active override rejection evidence`
      );
      break;
    case "semantic-active-resource":
      assertExactJSON(
        response,
        readJSON(
          resolve(
            fixtureDirectory,
            "../c1-semantic-bridge/fixtures/semantic-extraction/responses/active-resource.json"
          )
        ),
        `${id} exact active resource graph evidence`
      );
      break;
    case "semantic-compute-interface":
      assertExactJSON(
        {
          ok: response.ok,
          diagnostics: response.diagnostics,
          result: response.result,
        },
        {
          ok: true,
          diagnostics: [],
          result: {
            entryPoints: [
              {
                stage: "compute",
                wgsl: "compute_builtins",
                semanticInterface: {
                  kind: "compute",
                  inputs: [
                    {
                      type: { scalar: "u32", width: 3 },
                      invariant: false,
                      builtin: "global_invocation_id",
                    },
                    {
                      type: { scalar: "u32", width: 3 },
                      invariant: false,
                      builtin: "local_invocation_id",
                    },
                    {
                      type: { scalar: "u32", width: 1 },
                      invariant: false,
                      builtin: "local_invocation_index",
                    },
                    {
                      type: { scalar: "u32", width: 3 },
                      invariant: false,
                      builtin: "num_workgroups",
                    },
                    {
                      type: { scalar: "u32", width: 3 },
                      invariant: false,
                      builtin: "workgroup_id",
                    },
                  ],
                  outputs: [],
                },
                bindings: [],
                samplingPairs: [],
                overrides: [],
                workgroupSize: { x: 1, y: 1, z: 1 },
              },
            ],
            bindings: [],
            overrides: [],
            types: {},
            layouts: {},
          },
        },
        `${id} exact compute extraction evidence`
      );
      break;
    case "semantic-render-interface":
      assertExactJSON(
        {
          ok: response.ok,
          diagnostics: response.diagnostics,
          result: response.result,
        },
        {
          ok: true,
          diagnostics: [],
          result: {
            entryPoints: [
              {
                stage: "vertex",
                wgsl: "vertex_main",
                semanticInterface: {
                  kind: "vertex",
                  inputs: [
                    {
                      type: { scalar: "f32", width: 2 },
                      invariant: false,
                      location: 3,
                    },
                    {
                      type: { scalar: "f32", width: 4 },
                      invariant: false,
                      location: 7,
                    },
                    {
                      type: { scalar: "u32", width: 1 },
                      invariant: false,
                      builtin: "instance_index",
                    },
                    {
                      type: { scalar: "u32", width: 1 },
                      invariant: false,
                      builtin: "vertex_index",
                    },
                  ],
                  outputs: [
                    {
                      type: { scalar: "f32", width: 2 },
                      invariant: false,
                      location: 2,
                      interpolation: {
                        type: "linear",
                        sampling: "centroid",
                      },
                    },
                    {
                      type: { scalar: "u32", width: 1 },
                      invariant: false,
                      location: 5,
                      interpolation: { type: "flat", sampling: "first" },
                    },
                    {
                      type: { scalar: "f32", width: 1 },
                      invariant: false,
                      location: 6,
                      interpolation: {
                        type: "perspective",
                        sampling: "center",
                      },
                    },
                    {
                      type: { scalar: "f32", width: 4 },
                      invariant: true,
                      builtin: "position",
                    },
                  ],
                },
                bindings: [],
                samplingPairs: [],
                overrides: [],
              },
              {
                stage: "fragment",
                wgsl: "fragment_main",
                semanticInterface: {
                  kind: "fragment",
                  inputs: [
                    {
                      type: { scalar: "f32", width: 2 },
                      invariant: false,
                      location: 2,
                      interpolation: {
                        type: "linear",
                        sampling: "centroid",
                      },
                    },
                    {
                      type: { scalar: "u32", width: 1 },
                      invariant: false,
                      location: 5,
                      interpolation: { type: "flat", sampling: "first" },
                    },
                    {
                      type: { scalar: "f32", width: 1 },
                      invariant: false,
                      location: 6,
                      interpolation: {
                        type: "perspective",
                        sampling: "center",
                      },
                    },
                    {
                      type: { scalar: "bool", width: 1 },
                      invariant: false,
                      builtin: "front_facing",
                    },
                    {
                      type: { scalar: "f32", width: 4 },
                      invariant: false,
                      builtin: "position",
                    },
                    {
                      type: { scalar: "u32", width: 1 },
                      invariant: false,
                      builtin: "sample_index",
                    },
                    {
                      type: { scalar: "u32", width: 1 },
                      invariant: false,
                      builtin: "sample_mask",
                    },
                  ],
                  outputs: [
                    {
                      type: { scalar: "f32", width: 4 },
                      invariant: false,
                      location: 1,
                    },
                    {
                      type: { scalar: "f32", width: 4 },
                      invariant: false,
                      location: 4,
                    },
                    {
                      type: { scalar: "f32", width: 1 },
                      invariant: false,
                      builtin: "frag_depth",
                    },
                    {
                      type: { scalar: "u32", width: 1 },
                      invariant: false,
                      builtin: "sample_mask",
                    },
                  ],
                },
                bindings: [],
                samplingPairs: [],
                overrides: [],
              },
            ],
            bindings: [],
            overrides: [],
            types: {},
            layouts: {},
          },
        },
        `${id} exact render extraction evidence`
      );
      break;
    case "vertex-sparse":
      assertExactJSON(
        response.result?.interface,
        {
          kind: "vertex",
          attributes: [
            { semantic: { location: 3 }, metal: { attribute: 3 } },
            { semantic: { location: 7 }, metal: { attribute: 7 } },
          ],
        },
        `${id} minimal Metal interface map`
      );
      assertMslIncludes(
        response,
        [
          "[[attribute(3)]]",
          "[[attribute(7)]]",
          "[[vertex_id]]",
          "[[instance_id]]",
          "[[user(locn2)]] [[centroid_no_perspective]]",
          "[[invariant]]",
        ],
        id
      );
      break;
    case "fragment-sparse":
      assertExactJSON(
        response.result?.interface,
        {
          kind: "fragment",
          colorOutputs: [
            { semantic: { location: 1 }, metal: { color: 1 } },
            { semantic: { location: 4 }, metal: { color: 4 } },
          ],
        },
        `${id} minimal Metal interface map`
      );
      assertMslIncludes(
        response,
        [
          "[[color(1)]]",
          "[[color(4)]]",
          "[[front_facing]]",
          "[[sample_id]]",
          "[[sample_mask]]",
          "[[depth(any)]]",
          "[[user(locn2)]] [[centroid_no_perspective]]",
        ],
        id
      );
      break;
    case "compute-builtins":
      assertExactJSON(
        response.result?.interface,
        { kind: "compute" },
        `${id} minimal Metal interface map`
      );
      assertMslIncludes(
        response,
        [
          "[[thread_position_in_grid]]",
          "[[thread_position_in_threadgroup]]",
          "[[thread_index_in_threadgroup]]",
          "[[threadgroups_per_grid]]",
          "[[threadgroup_position_in_grid]]",
        ],
        id
      );
      break;
    case "dual-source":
      assertExactJSON(
        response.result?.interface,
        {
          kind: "fragment",
          colorOutputs: [
            {
              semantic: { location: 0, blendSource: 0 },
              metal: { color: 0, index: 0 },
            },
            {
              semantic: { location: 0, blendSource: 1 },
              metal: { color: 0, index: 1 },
            },
          ],
        },
        `${id} minimal Metal interface map`
      );
      assertMslIncludes(
        response,
        ["[[color(0)]] [[index(0)]]", "[[color(0)]] [[index(1)]]"],
        id
      );
      break;
    case "scalar-fragment":
      assertExactJSON(
        response.result?.interface,
        {
          kind: "fragment",
          colorOutputs: [{ semantic: { location: 3 }, metal: { color: 3 } }],
        },
        `${id} minimal Metal interface map`
      );
      assertMslIncludes(response, ["[[user(locn9)]]", "[[color(3)]]"], id);
      break;
    case "interface-mismatch": {
      const mismatch = response.diagnostics?.find(
        (diagnostic) =>
          diagnostic.code === "VGPU-NATIVE-TINT-INTERFACE" &&
          diagnostic.phase === "inspect" &&
          diagnostic.severity === "error"
      );
      if (!mismatch) {
        fail(`${id} omitted the expected semantic-interface diagnostic`);
      }
      break;
    }
  }
}

function verifyRequestParity(builds, universal, oracle, protocols, validators) {
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
  const measuredCanaries = {};
  const requestHashes = new Set();
  const emittedNames = new Set();
  for (const fixture of oracleFixtures) {
    const { id } = fixture;
    const expected = lock.oracle.canaries[id];
    if (!candidateMode && !expected) {
      fail(`oracle canary ${id} is not locked`);
    }
    if (!candidateMode) {
      assertEqual(expected.ok, fixture.ok, `${id} locked success state`);
    }
    const fixtureBytes = readFileSync(join(requestDirectory, fixture.path));
    let decodedRequest;
    try {
      decodedRequest = JSON.parse(fixtureBytes.toString("utf8"));
    } catch (error) {
      fail(`${id} request is not valid JSON: ${error.message}`);
    }
    const contractId = decodedRequest?.contractId;
    const contractValidators = validators[contractId];
    if (!contractValidators) {
      fail(`${id} selects unsupported oracle contract ${String(contractId)}`);
    }
    assertSchema(contractValidators.request, decodedRequest, `${id} request`);
    let request = fixtureBytes;
    let prepareResponse;
    let assertResponseSemantics;
    switch (contractId) {
      case compilerContractId: {
        protocols.compiler.assertRequestSemantics(decodedRequest);
        const emittedName = decodedRequest.entryPoint.metal;
        if (emittedNames.has(emittedName)) {
          fail(`${id} duplicates another oracle emitted entry-point name`);
        }
        emittedNames.add(emittedName);
        prepareResponse = (response) =>
          protocols.compiler.attachDiagnosticOrigins(decodedRequest, response);
        assertResponseSemantics = (response) =>
          protocols.compiler.assertResponseSemantics(decodedRequest, response);
        break;
      }
      case inventoryContractId: {
        protocols.inventory.assertInventoryRequestSemantics(decodedRequest);
        const encodedRequest =
          protocols.inventory.encodeInventoryRequest(decodedRequest);
        request = Buffer.from(encodedRequest, "utf8");
        prepareResponse = (response) => response;
        assertResponseSemantics = (response) =>
          protocols.inventory.assertInventoryResponseSemantics(
            decodedRequest,
            encodedRequest,
            response
          );
        break;
      }
      case semanticExtractionContractId: {
        protocols.semanticExtraction.assertSemanticExtractionExecutableProfile(
          decodedRequest
        );
        const encodedRequest =
          protocols.semanticExtraction.encodeSemanticExtractionRequest(
            decodedRequest
          );
        request = Buffer.from(encodedRequest, "utf8");
        prepareResponse = (response) => response;
        assertResponseSemantics = (response) =>
          protocols.semanticExtraction.assertSemanticExtractionResponseSemantics(
            decodedRequest,
            encodedRequest,
            response
          );
        break;
      }
      default:
        fail(`${id} selects unsupported oracle contract ${String(contractId)}`);
    }
    const requestSha256 = sha256Buffer(request);
    if (requestHashes.has(requestSha256)) {
      fail(`${id} duplicates another oracle request byte for byte`);
    }
    requestHashes.add(requestSha256);
    if (!candidateMode) {
      assertEqual(
        requestSha256,
        expected.requestSha256,
        `${id} request SHA-256`
      );
    }
    const reference = runWorker(
      oracle.executable,
      "native",
      request,
      `${id} monolithic oracle`
    );
    const responseSha256 = sha256Buffer(reference.bytes);
    if (!candidateMode) {
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
    }
    assertEqual(reference.decoded.ok, fixture.ok, `${id} oracle ok`);
    assertSchema(
      contractValidators.response,
      reference.decoded,
      `${id} raw oracle response`
    );
    const referenceForSemantics = prepareResponse(reference.decoded);
    assertSchema(
      contractValidators.response,
      referenceForSemantics,
      `${id} semantic oracle response`
    );
    assertResponseSemantics(referenceForSemantics);
    verifyOracleBranchEvidence(id, referenceForSemantics);
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
      assertSchema(
        contractValidators.response,
        result.decoded,
        `${id} ${variant} raw response`
      );
      const resultForSemantics = prepareResponse(result.decoded);
      assertSchema(
        contractValidators.response,
        resultForSemantics,
        `${id} ${variant} semantic response`
      );
      assertResponseSemantics(resultForSemantics);
    }
    measuredCanaries[id] = {
      requestSha256,
      responseBytes: reference.bytes.length,
      responseSha256,
      ok: fixture.ok,
    };
    results[id] = {
      requestSha256,
      responseBytes: reference.bytes.length,
      responseSha256,
      directVariants: directVariants.length,
      oracleMatched: true,
      ok: reference.decoded.ok,
    };
  }
  candidateCanaries = measuredCanaries;
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
  assertOrMeasure(
    statSync(output.a).size,
    lock.build.outputs.universal.bytes,
    "universal binary bytes",
    "/build/outputs/universal/bytes"
  );
  assertOrMeasure(
    aHash,
    lock.build.outputs.universal.sha256,
    "universal binary SHA-256",
    "/build/outputs/universal/sha256"
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
    if (pathEntryExists(artifactsDirectory)) {
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
    verifySourceLockIdentity();
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
    const parent = options.effectiveScratchRoot;
    mkdirSync(parent, { recursive: true });
    return mkdtempSync(join(parent, "c1-tint-direct-build-"));
  }
  return mkdtempSync(
    join(options.effectiveScratchRoot, "vgpu-c1-tint-direct-build-")
  );
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

function verifyBuildClosureParity(builds) {
  const reference = builds.arm64.a.graph.sourceInputs;
  for (const architecture of ["arm64", "x86_64"]) {
    for (const copy of ["a", "b"]) {
      assertEqual(
        JSON.stringify(builds[architecture][copy].graph.sourceInputs),
        JSON.stringify(reference),
        `${architecture}/${copy} source closure parity`
      );
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const pureHelp =
    argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h");
  if (pureHelp) {
    usage(process.stdout);
    return;
  }
  acquireInvocationLock();
  const candidateIntent = detectCandidateIntent(argv);
  if (candidateIntent) {
    localHeadCommit = stdoutText(
      systemTools.git,
      ["-C", repositoryRoot, "rev-parse", "HEAD^{commit}"],
      "candidate repository HEAD",
      { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }
    );
  }
  if (candidateIntent) {
    if (pathEntryExists(artifactsDirectory)) {
      fail(
        "--emit-lock-candidate requires .artifacts to be absent and never deletes it"
      );
    }
  } else {
    // Any invalid, failed, or interrupted publication invocation must invalidate an older PASS.
    rmSync(artifactsDirectory, { recursive: true, force: true });
  }
  const lockPath = join(fixtureDirectory, "provenance", "source-lock.json");
  const lockBytes = readFileSync(lockPath);
  baseLockSha256 = sha256Buffer(lockBytes);
  lock = JSON.parse(lockBytes.toString("utf8"));
  defaultWorkerRoot = resolve(fixtureDirectory, lock.worker.defaultRoot);
  const options = parseArguments(argv);
  candidateMode = options.emitLockCandidate !== undefined;
  assertEqual(candidateMode, candidateIntent, "lock candidate invocation mode");
  validateScratchRoot(options);
  candidateMeasurements.clear();
  candidateCanaries = undefined;
  verifyFilesMatchGitHead(
    repositoryRoot,
    [fileURLToPath(import.meta.url), lockPath],
    "candidate runner and source lock",
    localHeadCommit
  );
  const ajvModule = await import("ajv/dist/2020.js");
  if (typeof ajvModule.default !== "function") {
    fail("Ajv 2020 module omitted its default constructor");
  }
  Ajv2020 = ajvModule.default;
  requestDirectory = selectOracleRequestRoot();
  const inputs = verifySourceInputs(options);
  const compilerModule = await import(
    pathToFileURL(inputs.oracle.files.nativeCompiler).href
  );
  if (typeof compilerModule.compileTintPrototype !== "function") {
    fail("locked native compiler helper omitted compileTintPrototype");
  }
  const protocolModule = await import(
    pathToFileURL(inputs.oracle.files.protocol).href
  );
  if (
    typeof protocolModule.attachDiagnosticOrigins !== "function" ||
    typeof protocolModule.assertRequestSemantics !== "function" ||
    typeof protocolModule.assertResponseSemantics !== "function" ||
    protocolModule.COMPILER_CONTRACT !== compilerContractId
  ) {
    fail("locked protocol helper omitted semantic validators");
  }
  const inventoryProtocolModule = await import(
    pathToFileURL(inputs.oracle.files.inventoryProtocol).href
  );
  if (
    typeof inventoryProtocolModule.encodeInventoryRequest !== "function" ||
    typeof inventoryProtocolModule.assertInventoryRequestSemantics !==
      "function" ||
    typeof inventoryProtocolModule.assertInventoryResponseSemantics !==
      "function" ||
    inventoryProtocolModule.INVENTORY_CONTRACT !== inventoryContractId
  ) {
    fail("locked inventory protocol helper omitted semantic validators");
  }
  const semanticExtractionProtocolModule = await import(
    pathToFileURL(inputs.oracle.files.semanticExtractionProtocol).href
  );
  if (
    typeof semanticExtractionProtocolModule.encodeSemanticExtractionRequest !==
      "function" ||
    typeof semanticExtractionProtocolModule.assertSemanticExtractionExecutableProfile !==
      "function" ||
    typeof semanticExtractionProtocolModule.assertSemanticExtractionResponseSemantics !==
      "function" ||
    semanticExtractionProtocolModule.SEMANTIC_EXTRACTION_CONTRACT !==
      semanticExtractionContractId
  ) {
    fail("locked semantic extraction protocol helper omitted validators");
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
    verifyBuildClosureParity(builds);

    const universal = createUniversal(builds, buildRoot);
    process.stderr.write(
      "C1 direct Tint build: compare direct workers with monolithic oracle\n"
    );
    const requests = verifyRequestParity(
      builds,
      universal,
      oracle,
      {
        compiler: protocolModule,
        inventory: inventoryProtocolModule,
        semanticExtraction: semanticExtractionProtocolModule,
      },
      inputs.oracle.validators
    );
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
      status: candidateMode ? "lock-candidate-generated" : "passed",
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
    if (candidateMode) {
      report.lockCandidate = writeLockCandidate(options.emitLockCandidate);
    } else {
      verifySourceLockIdentity();
      publishArtifacts(builds, universal, report, notices);
    }
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
  process.exitCode = 1;
} finally {
  try {
    releaseInvocationLock();
  } catch (error) {
    process.stderr.write(
      `C1 direct Tint build: failed to release invocation lock: ${
        error.stack ?? error.message ?? String(error)
      }\n`
    );
    process.exitCode = 1;
  }
}
