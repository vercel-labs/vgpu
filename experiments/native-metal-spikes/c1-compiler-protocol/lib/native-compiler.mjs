import { spawn, spawnSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { jsonAllocationUnits, TINT_REVISION } from "./protocol.mjs";

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 160 * 1024 * 1024,
    timeout: 60_000,
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

export function compileTintPrototype({
  fixtureDirectory,
  releaseRoot,
  compatInclude,
  jsoncppRoot,
  scratch,
}) {
  if (!jsoncppRoot) {
    throw new Error("C1 compiler protocol: JsonCpp source root is required");
  }
  const provenance = readJSON(
    join(
      fixtureDirectory,
      "..",
      "c1-tint-standalone",
      "provenance",
      "releases.json"
    )
  );
  const release = provenance.releases?.find(
    (candidate) => candidate.commit === TINT_REVISION
  );
  const expectedLibraryHash = release?.files?.["lib/libwebgpu_dawn.a"]?.sha256;
  const expectedCompilerHeaderHash = provenance.supplementalSource?.sha256;
  const expectedIncludeTree = release?.includeTree;
  if (
    !expectedLibraryHash ||
    !expectedCompilerHeaderHash ||
    expectedIncludeTree?.algorithm !==
      "relative-path-nul-file-sha256-lines-v1" ||
    !Number.isSafeInteger(expectedIncludeTree.files) ||
    !/^[a-f0-9]{64}$/u.test(expectedIncludeTree.sha256 ?? "")
  ) {
    throw new Error(
      "C1 compiler protocol: pinned Dawn provenance is incomplete"
    );
  }

  const includeRoot = join(releaseRoot, "include");
  const tintInclude = join(includeRoot, "src", "tint");
  const library = join(releaseRoot, "lib", "libwebgpu_dawn.a");
  if (!existsSync(tintInclude) || !existsSync(library)) {
    throw new Error(
      "C1 compiler protocol: release root lacks Tint headers or libwebgpu_dawn.a"
    );
  }
  if (sha256File(library) !== expectedLibraryHash) {
    throw new Error(
      `C1 compiler protocol: libwebgpu_dawn.a does not match ${TINT_REVISION}`
    );
  }
  const includeTree = sha256FileTree(includeRoot);
  if (
    includeTree.files !== expectedIncludeTree.files ||
    includeTree.sha256 !== expectedIncludeTree.sha256
  ) {
    throw new Error(
      `C1 compiler protocol: include tree does not match ${TINT_REVISION}`
    );
  }

  const compilerHeader = compatInclude
    ? join(compatInclude, "src", "utils", "compiler.h")
    : join(includeRoot, "src", "utils", "compiler.h");
  if (!existsSync(compilerHeader)) {
    throw new Error(
      "C1 compiler protocol: the pinned archive requires its exact --compat-include overlay"
    );
  }
  if (sha256File(compilerHeader) !== expectedCompilerHeaderHash) {
    throw new Error(
      `C1 compiler protocol: compiler.h does not match ${TINT_REVISION}`
    );
  }
  if (compatInclude) {
    const overlayFiles = regularFileTree(compatInclude).map(
      ({ relativePath }) => relativePath.split(sep).join("/")
    );
    if (
      overlayFiles.length !== 1 ||
      overlayFiles[0] !== "src/utils/compiler.h"
    ) {
      throw new Error(
        "C1 compiler protocol: --compat-include must contain only src/utils/compiler.h"
      );
    }
  }

  const jsoncppProvenance = readJSON(
    join(fixtureDirectory, "provenance", "jsoncpp-1.9.8.json")
  );
  if (
    jsoncppProvenance.version !== "1.9.8" ||
    jsoncppProvenance.commit !== "8519b8381f3c741ad1421f88237b1deda0b11412" ||
    typeof jsoncppProvenance.archive?.url !== "string" ||
    !Number.isSafeInteger(jsoncppProvenance.archive.bytes) ||
    jsoncppProvenance.archive.bytes <= 0 ||
    !/^[a-f0-9]{64}$/u.test(jsoncppProvenance.archive.sha256 ?? "") ||
    jsoncppProvenance.license?.spdx !== "MIT" ||
    !Number.isSafeInteger(jsoncppProvenance.license.bytes) ||
    jsoncppProvenance.license.bytes <= 0 ||
    !/^[a-f0-9]{64}$/u.test(jsoncppProvenance.license.sha256 ?? "") ||
    jsoncppProvenance.compiledClosure?.algorithm !==
      "relative-path-nul-file-sha256-lines-v1" ||
    !Array.isArray(jsoncppProvenance.compiledClosure.paths) ||
    jsoncppProvenance.compiledClosure.paths.length !==
      jsoncppProvenance.compiledClosure.files ||
    !/^[a-f0-9]{64}$/u.test(jsoncppProvenance.compiledClosure.sha256 ?? "")
  ) {
    throw new Error(
      "C1 compiler protocol: pinned JsonCpp provenance is incomplete"
    );
  }
  const jsoncppClosure = sha256SelectedFiles(
    jsoncppRoot,
    jsoncppProvenance.compiledClosure.paths
  );
  if (
    jsoncppClosure.files !== jsoncppProvenance.compiledClosure.files ||
    jsoncppClosure.sha256 !== jsoncppProvenance.compiledClosure.sha256
  ) {
    throw new Error(
      `C1 compiler protocol: JsonCpp source closure does not match ${jsoncppProvenance.commit}`
    );
  }
  const trackedLicense = join(
    fixtureDirectory,
    "provenance",
    jsoncppProvenance.license.trackedPath
  );
  if (
    sha256File(join(jsoncppRoot, jsoncppProvenance.license.sourcePath)) !==
      jsoncppProvenance.license.sha256 ||
    sha256File(trackedLicense) !== jsoncppProvenance.license.sha256 ||
    lstatSync(join(jsoncppRoot, jsoncppProvenance.license.sourcePath)).size !==
      jsoncppProvenance.license.bytes ||
    lstatSync(trackedLicense).size !== jsoncppProvenance.license.bytes
  ) {
    throw new Error("C1 compiler protocol: JsonCpp license provenance drifted");
  }

  const prototypeDirectory = join(fixtureDirectory, "prototype");
  const source = join(prototypeDirectory, "main.cc");
  const codecSource = join(prototypeDirectory, "json-codec.cc");
  const materializerSource = join(
    prototypeDirectory,
    "override-materializer.cc"
  );
  const sourceText = [
    "main.cc",
    "json-codec.cc",
    "json-codec.h",
    "request.h",
    "override-materializer.cc",
    "override-materializer.h",
  ]
    .map((name) => readFileSync(join(prototypeDirectory, name), "utf8"))
    .join("\n");
  for (const forbidden of [
    "tint::GenerateBindings",
    "api/helpers/generate_bindings",
    '"needsStorageBufferSizes"',
    '"interfaceLocations"',
  ]) {
    if (sourceText.includes(forbidden)) {
      throw new Error(
        `C1 compiler protocol: prototype contains forbidden contract surface ${forbidden}`
      );
    }
  }
  for (const required of [
    "kImmediateDataIndex = 30",
    "kStorageBufferSizesOffset = 4",
    "writer_options.immediate_binding_point",
    "tint::msl::writer::Generate",
    "ExtractSemanticInterface",
    "generated->needs_storage_buffer_sizes",
    '"semanticInterface"',
    '"vgpu-native-tint-semantic-extraction/v1"',
    "WriteSemanticExtractionSuccess",
    "RequestOperation::kSemanticExtraction",
    "GetResourceBindings",
    'builder["rejectDupKeys"] = true',
    "kMaxRequestBytes = 128U * 1024U * 1024U",
  ]) {
    if (!sourceText.includes(required)) {
      throw new Error(
        `C1 compiler protocol: prototype omitted required invariant ${required}`
      );
    }
  }

  const executable = join(scratch, "vgpu-tint-compiler-prototype");
  const result = runCommand("/usr/bin/xcrun", [
    "clang++",
    "-std=c++20",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-Werror",
    source,
    codecSource,
    materializerSource,
    join(jsoncppRoot, "src", "lib_json", "json_reader.cpp"),
    join(jsoncppRoot, "src", "lib_json", "json_value.cpp"),
    join(jsoncppRoot, "src", "lib_json", "json_writer.cpp"),
    `-I${join(jsoncppRoot, "include")}`,
    `-I${join(jsoncppRoot, "src", "lib_json")}`,
    ...(compatInclude ? [`-I${compatInclude}`] : []),
    `-I${tintInclude}`,
    `-I${includeRoot}`,
    // Link the exact archive whose provenance was verified above. Using
    // -L/-l would let an unverified dylib with the same basename win the
    // linker's search order.
    library,
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
    executable,
  ]);
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `C1 compiler protocol: prototype compilation failed: ${result.stderr.trim()}`
    );
  }
  return { executable, sha256: sha256File(executable) };
}

const MAX_WORKER_STDOUT_BYTES = 160 * 1024 * 1024;
const MAX_WORKER_STDERR_BYTES = 64 * 1024;

export function startTintWorker({ executable, timeoutMs = 60_000, signal }) {
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let error;
  let killTimer;
  let terminating = false;
  const terminate = (reason) => {
    error ??= reason;
    if (terminating) return;
    terminating = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      killTimer.unref();
    }
  };
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_WORKER_STDOUT_BYTES) {
      terminate(new Error("worker stdout exceeded 160 MiB"));
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_WORKER_STDERR_BYTES) {
      terminate(new Error("worker stderr exceeded 64 KiB"));
      return;
    }
    stderr.push(chunk);
  });
  child.on("error", (cause) => {
    error ??= cause;
  });
  // A handled EPIPE is reported by write(); it must not become an uncaught
  // process-level error while a malformed worker invocation is shutting down.
  child.stdin.on("error", () => {});

  const timeout = setTimeout(
    () => terminate(new Error(`worker timed out after ${timeoutMs} ms`)),
    timeoutMs
  );
  timeout.unref();
  const abort = () => terminate(new Error("worker invocation was cancelled"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  const result = new Promise((resolveResult) => {
    child.on("close", (status, closeSignal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      if (!isUtf8(stdoutBuffer)) {
        error ??= new Error("worker stdout is not valid UTF-8");
      }
      if (!isUtf8(stderrBuffer)) {
        error ??= new Error("worker stderr is not valid UTF-8");
      }
      resolveResult({
        status,
        signal: closeSignal,
        error,
        stdout: stdoutBuffer.toString("utf8"),
        stderr: stderrBuffer.toString("utf8"),
      });
    });
  });

  return {
    child,
    result,
    write(bytes) {
      const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      return new Promise((resolveWrite, rejectWrite) => {
        let accepted;
        accepted = child.stdin.write(chunk, (writeError) => {
          if (writeError) rejectWrite(writeError);
          else resolveWrite({ backpressured: !accepted });
        });
      });
    },
    end() {
      child.stdin.end();
    },
    terminate,
  };
}

export async function invokeRawTintPrototype({
  executable,
  request,
  signal,
  timeoutMs,
}) {
  const encoded = Buffer.from(JSON.stringify(request), "utf8");
  if (
    encoded.length > 128 * 1024 * 1024 ||
    jsonAllocationUnits(request) > 262_144
  ) {
    throw new Error(
      "C1 compiler protocol: request exceeds worker framing limits"
    );
  }
  const worker = startTintWorker({ executable, signal, timeoutMs });
  try {
    await worker.write(encoded);
    worker.end();
  } catch (error) {
    worker.terminate(error);
  }
  return worker.result;
}

/**
 * Accepts stdout only after the process boundary and response schema have both
 * been validated. Callers must still apply request-specific semantic checks.
 */
export function decodeTintWorkerResponse(attempt, validateResponse) {
  if (typeof validateResponse !== "function") {
    throw new TypeError("a response-schema validator is required");
  }
  if (
    attempt.error ||
    attempt.signal ||
    attempt.status !== 0 ||
    attempt.stderr !== ""
  ) {
    const reason =
      attempt.error?.message ??
      (attempt.signal
        ? `signal ${attempt.signal}`
        : attempt.stderr !== ""
        ? "unexpected stderr"
        : attempt.status === null
        ? "missing exit status"
        : `exit ${attempt.status}`);
    throw new Error(`untrusted compiler worker output: ${reason}`);
  }
  let response;
  try {
    response = JSON.parse(attempt.stdout);
  } catch (cause) {
    throw new Error("compiler worker did not emit exactly one JSON value", {
      cause,
    });
  }
  if (validateResponse(response) === false) {
    throw new Error("compiler worker response failed schema validation");
  }
  return response;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256FileTree(root) {
  const files = regularFileTree(root);
  const hash = createHash("sha256");
  for (const file of files) {
    const portablePath = file.relativePath.split(sep).join("/");
    hash.update(portablePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(sha256File(file.path), "utf8");
    hash.update("\n", "utf8");
  }
  return { files: files.length, sha256: hash.digest("hex") };
}

function sha256SelectedFiles(root, paths) {
  const hash = createHash("sha256");
  for (const relativePath of paths) {
    if (
      typeof relativePath !== "string" ||
      relativePath.startsWith("/") ||
      relativePath.includes("\\") ||
      relativePath
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(
        "C1 compiler protocol: JsonCpp provenance contains an unsafe path"
      );
    }
    const path = join(root, ...relativePath.split("/"));
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `C1 compiler protocol: JsonCpp closure path is not a regular file ${relativePath}`
      );
    }
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(sha256File(path), "utf8");
    hash.update("\n", "utf8");
  }
  return { files: paths.length, sha256: hash.digest("hex") };
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
        throw new Error(
          `C1 compiler protocol: dependency tree contains a non-file entry ${entry.name}`
        );
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

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
