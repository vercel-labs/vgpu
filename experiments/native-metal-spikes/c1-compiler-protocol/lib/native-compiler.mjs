import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { TINT_REVISION } from "./protocol.mjs";

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
  scratch,
}) {
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

  const source = join(fixtureDirectory, "prototype", "main.cc");
  const sourceText = readFileSync(source, "utf8");
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
    "generated->needs_storage_buffer_sizes",
    "GetResourceBindings",
  ]) {
    if (!sourceText.includes(required)) {
      throw new Error(
        `C1 compiler protocol: prototype omitted required invariant ${required}`
      );
    }
  }

  const executable = join(scratch, "vgpu-tint-compiler-prototype");
  const result = runCommand("xcrun", [
    "clang++",
    "-std=c++20",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-Werror",
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
    executable,
  ]);
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `C1 compiler protocol: prototype compilation failed: ${result.stderr.trim()}`
    );
  }
  return { executable, sha256: sha256File(executable) };
}

export function invokeTintPrototype({ executable, request, scratch, id }) {
  const safeId = id.replaceAll(/[^A-Za-z0-9_-]/gu, "-");
  const sourcePath = join(scratch, `${safeId}.wgsl`);
  const mappingPath = join(scratch, `${safeId}.bindings.txt`);
  writeFileSync(sourcePath, request.source.text);
  writeFileSync(
    mappingPath,
    `${request.metal.bindings
      .flatMap((binding) =>
        binding.slots.map(
          (slot) =>
            `${binding.group} ${binding.binding} ${slot.resourceClass} ${slot.component} ${slot.index} ${slot.count}`
        )
      )
      .join("\n")}\n`
  );

  const args = [
    "--source",
    sourcePath,
    "--source-name",
    request.source.virtualPath,
    "--stage",
    request.entryPoint.stage,
    "--entry-point",
    request.entryPoint.wgsl,
    "--emitted-name",
    request.entryPoint.metal,
    "--mapping",
    mappingPath,
  ];
  for (const feature of request.languageFeatures) {
    args.push("--feature", feature);
  }
  for (const override of request.overrides) {
    args.push(
      "--override",
      override.name,
      override.value.type,
      overridePayload(override.value)
    );
  }
  return runCommand(executable, args);
}

function overridePayload(value) {
  if (value.type === "f16" || value.type === "f32") return value.bits;
  return String(value.value);
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
