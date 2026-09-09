import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { projectFixture } from "./project-operation-fixture.ts";

const workspace = fileURLToPath(new URL("../../..", import.meta.url));
const packages = [
  ["@vgpu/wgsl-std", "wgsl-std", "0.3.1"],
  ["@vgpu/wgsl", "wgsl", "0.3.1"],
  ["@vgpu/core", "core", "0.3.1"],
  ["@vgpu/adapter-mock", "adapter-mock", "0.3.1"],
  ["@vgpu/adapter-node", "adapter-node", "0.3.1"],
  ["vgpu", "vgpu-api", "0.3.1"],
  ["@vgpu/native", "native", "0.0.0"],
] as const;
const external = {
  "@modelcontextprotocol/core": "2.0.0",
  "@modelcontextprotocol/server": "2.0.0",
  "@webgpu/types": "0.1.69",
  ajv: "8.20.0",
  debug: "4.4.3",
  "fast-deep-equal": "3.1.3",
  "fast-uri": "3.1.5",
  "json-schema-traverse": "1.0.0",
  ms: "2.1.3",
  pixelmatch: "7.2.0",
  pngjs: "7.0.0",
  "require-from-string": "2.0.2",
  webgpu: "0.4.0",
  "wgpu-matrix": "3.4.2",
  zod: "4.4.3",
};

test("an offline installed public vgpu diagnoses, checks without Apple tools, and builds documented shaders", async () => {
  expect(process.versions.node).toBe("22.19.0");
  expect(process.platform).toBe("darwin");
  const { command, checked } = boundedCommands(Date.now() + 240_000);
  const pnpm = await realpath(process.env.npm_execpath!);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(?:NODE_PATH$|NODE_OPTIONS$|npm_config_|NPM_CONFIG_|DYLD_|LD_)/u.test(
          name
        )
    )
  );
  const assets = join(workspace, "packages/native/dist/compiler/assets");
  let ownsAssets = false;
  let unplacedProject: string | undefined;
  const sourceRoot = join(
    workspace,
    "tooling/native-tint-worker/c1-tint-direct-build"
  );
  const lock = JSON.parse(
    await readFile(join(sourceRoot, "provenance/source-lock.json"), "utf8")
  );
  const jsoncppRoot = join(
    workspace,
    "tooling/native-tint-worker/c1-compiler-protocol/provenance"
  );
  const jsoncpp = JSON.parse(
    await readFile(join(jsoncppRoot, "jsoncpp-1.9.8.json"), "utf8")
  );
  const accepted = [
    {
      path: "vgpu-tint-worker",
      source: join(sourceRoot, ".artifacts/bin/vgpu-tint-worker-universal"),
      ...lock.build.outputs.universal,
    },
    {
      path: "licenses/Dawn-Tint.txt",
      source: join(sourceRoot, "provenance", lock.dawn.license.trackedPath),
      ...lock.dawn.license,
    },
    {
      path: "licenses/Abseil.txt",
      source: join(
        sourceRoot,
        "provenance",
        lock.dependencies.abseil.license.trackedPath
      ),
      ...lock.dependencies.abseil.license,
    },
    {
      path: "licenses/JsonCpp.txt",
      source: join(jsoncppRoot, jsoncpp.license.trackedPath),
      ...jsoncpp.license,
    },
  ];
  const sourceEvidence = new Map<string, unknown>();
  const fixture = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-installed-doctor-"))
  );
  try {
    await expect(lstat(assets)).rejects.toMatchObject({ code: "ENOENT" });
    ownsAssets = true; // Only this exact initially absent generated subtree belongs to this run.
    for (const item of accepted) {
      const evidence = await fileEvidence(item.source);
      expect(evidence).toMatchObject({
        bytes: item.bytes,
        sha256: item.sha256,
      });
      sourceEvidence.set(item.source, evidence);
    }
    expect(
      (
        await checked(
          process.execPath,
          [pnpm, "--version"],
          workspace,
          environment
        )
      ).stdout.trim()
    ).toBe("9.15.4");
    const modules = await readFile(
      join(workspace, "node_modules/.modules.yaml"),
      "utf8"
    );
    const store = modules.match(/^storeDir: (.+)$/mu)?.[1];
    if (!store) throw new Error("Setup: workspace pnpm store is not recorded");
    const registry = (
      await checked(
        process.execPath,
        [pnpm, "config", "get", "registry"],
        workspace,
        environment
      )
    ).stdout.trim();
    const configuredCache = (
      await checked(
        process.execPath,
        [pnpm, "config", "get", "cache-dir"],
        workspace,
        environment
      )
    ).stdout.trim();
    const cache =
      configuredCache === "undefined"
        ? join(homedir(), "Library/Caches/pnpm")
        : configuredCache;
    const archives = join(fixture, "tarballs");
    await mkdir(archives);
    const dependencies: Record<string, string> = {};
    const overrides: Record<string, string> = { ...external };
    const archiveEvidence = new Map<string, unknown>();
    let internalEdges = 0;
    for (const [name, directory, version] of packages) {
      const location = join(workspace, "packages", directory);
      const manifest = JSON.parse(
        await readFile(join(location, "package.json"), "utf8")
      );
      expect(manifest).toMatchObject({ name, version });
      if (manifest.scripts?.build)
        await checked(
          process.execPath,
          [pnpm, "--dir", location, "run", "build"],
          workspace,
          environment
        );
      // Ordinary lifecycle-enabled pack is unchanged between RED and GREEN, including native prepack.
      await checked(
        process.execPath,
        [
          pnpm,
          "--dir",
          location,
          "--config.ignore-scripts=false",
          "pack",
          "--pack-destination",
          archives,
        ],
        workspace,
        environment
      );
      const filename = `${name
        .replace(/^@/u, "")
        .replaceAll("/", "-")}-${version}.tgz`;
      dependencies[name] = `file:./tarballs/${filename}`;
      const archive = join(archives, filename);
      archiveEvidence.set(filename, await fileEvidence(archive));
      const archived = JSON.parse(
        (
          await checked(
            "/usr/bin/tar",
            ["-xOf", archive, "package/package.json"],
            fixture,
            environment
          )
        ).stdout
      );
      expect(archived).toMatchObject({ name, version });
      for (const value of Object.values({
        ...archived.dependencies,
        ...archived.optionalDependencies,
      }))
        expect(value).not.toMatch(/^(?:workspace:|link:|file:)/u);
      for (const [dependency, value] of Object.entries({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      })) {
        if (typeof value !== "string" || !value.startsWith("workspace:"))
          continue;
        const target = packages.find(([candidate]) => candidate === dependency);
        if (!target)
          throw new Error(`Setup: missing local package ${dependency}`);
        overrides[`${name}>${dependency}`] = `file:./tarballs/${target[0]
          .replace(/^@/u, "")
          .replaceAll("/", "-")}-${target[2]}.tgz`;
        internalEdges++;
      }
    }
    expect(internalEdges).toBe(10);
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify(
        {
          name: "vgpu-installed-native-doctor-fixture",
          private: true,
          type: "module",
          packageManager: "pnpm@9.15.4",
          dependencies,
          pnpm: { overrides },
        },
        null,
        2
      )
    );
    await checked(
      process.execPath,
      [
        pnpm,
        "--dir",
        fixture,
        "--ignore-workspace",
        "install",
        "--offline",
        "--ignore-scripts",
        "--prod",
        "--no-frozen-lockfile",
        `--store-dir=${store}`,
        `--cache-dir=${cache}`,
        `--registry=${registry}`,
        "--package-import-method=copy",
        "--config.node-linker=isolated",
        "--config.virtual-store-dir=node_modules/.pnpm",
        "--config.link-workspace-packages=false",
        "--config.auto-install-peers=false",
        "--config.verify-store-integrity=true",
      ],
      fixture,
      environment
    );
    const installedLock = packageResolutions(
      await readFile(join(fixture, "pnpm-lock.yaml"), "utf8")
    );
    const repositoryLock = packageResolutions(
      await readFile(join(workspace, "pnpm-lock.yaml"), "utf8")
    );
    expect(installedLock.size).toBe(
      packages.length + Object.keys(external).length
    );
    for (const [name, version] of Object.entries(external)) {
      const key = `${name}@${version}`;
      expect(installedLock.get(key)?.integrity).toBe(
        repositoryLock.get(key)?.integrity
      );
      expect(installedLock.get(key)?.integrity).toMatch(/^sha512-/u);
    }
    for (const [name] of packages) {
      const filename = dependencies[name]!.split("/").at(-1)!;
      const matches = [...installedLock].filter(([key]) =>
        key.startsWith(`${name}@file:`)
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]![1].tarball?.replace("file:./", "file:")).toBe(
        `file:tarballs/${filename}`
      );
      const packageRoot = await realpath(join(fixture, "node_modules", name));
      inside(fixture, packageRoot);
      expect(
        JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
          .name
      ).toBe(name);
    }
    await assertContainedLinks(join(fixture, "node_modules"), fixture);
    const publicRoot = await realpath(join(fixture, "node_modules/vgpu"));
    const nativeRoot = await realpath(
      join(fixture, "node_modules/@vgpu/native")
    );
    const bin = await realpath(join(publicRoot, "bin/vgpu.js"));
    inside(fixture, bin);
    const runtime = join(fixture, "unrelated-cwd");
    const scratch = join(fixture, "operation-tmp");
    await mkdir(runtime);
    await mkdir(scratch);
    const sentinel = join(runtime, "vgpu.native.json");
    await writeFile(sentinel, "this is deliberately not JSON\n");
    const sentinelBefore = await fileEvidence(sentinel);
    const nativeBefore = await treeEvidence(nativeRoot);
    const publicBefore = await treeEvidence(publicRoot);
    const doctorEnvironment: NodeJS.ProcessEnv = {
      ...environment,
      PATH: [
        dirname(process.execPath),
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
      TMPDIR: scratch,
    };
    delete doctorEnvironment.NODE_PATH;
    delete doctorEnvironment.NODE_OPTIONS;
    console.info(
      "Installed doctor setup complete",
      JSON.stringify({
        node: process.versions.node,
        host: `${process.platform}/${process.arch}`,
        packages: packages.length,
        internalEdges,
        external: Object.keys(external).length,
        archives: Object.fromEntries(archiveEvidence),
      })
    );
    const doctor = await command(
      process.execPath,
      [bin, "native", "doctor"],
      runtime,
      doctorEnvironment
    );
    console.info("Installed doctor actual result", JSON.stringify(doctor));
    // The first behavior assertion is the actual public command, never a future asset/export prerequisite.
    expect(doctor.code, JSON.stringify(doctor)).toBe(0);
    expect(doctor.signal).toBeNull();
    expect(doctor.stderr).toBe("");
    expect(doctor.stdout.startsWith("Native toolchain: healthy\n")).toBe(true);
    expect(
      [
        ...doctor.stdout.matchAll(
          /^\[ok\] (node|host|xcode|sdk|swift|tint|metal): .+$/gmu
        ),
      ].map((match) => match[1])
    ).toEqual(["node", "host", "xcode", "sdk", "swift", "tint", "metal"]);
    expect(doctor.stdout).not.toMatch(/^\[(?:fail|skip)\]/mu);
    expect(doctor.stdout).toContain(`Node.js ${process.versions.node}`);
    expect(doctor.stdout).toContain(`process ${process.arch}`);
    expect(doctor.stdout).toContain(lock.dawn.commit);
    expect(doctor.stdout).toMatch(
      /Compiled and linked [1-9]\d* bytes with macos-metal2\.4 targeting macOS 14\./u
    );
    const nativeEntries = (
      await checked(
        "/usr/bin/tar",
        ["-tzf", join(archives, "vgpu-native-0.0.0.tgz")],
        fixture,
        environment
      )
    ).stdout
      .trim()
      .split("\n");
    expect(nativeEntries).toEqual(
      expect.arrayContaining([
        "package/dist/cli.js",
        "package/dist/cli.d.ts",
        "package/dist/tooling/publication-session.c",
        "package/dist/tooling/publication-staging.c",
        ...[
          "compiler-request",
          "compiler-response",
          "inventory-request",
          "origin-map",
          "semantic-request",
          "semantic-response",
        ].map((name) => `package/dist/compiler/schemas/${name}.json`),
      ])
    );
    expect(
      nativeEntries.filter((path) =>
        /(?:^|\/)(?:experiments|native-metal-spikes|\.context)(?:\/|$)|\.(?:tsbuildinfo|tgz|tar(?:\.gz)?|log)$|\/observed\.json$/u.test(
          path
        )
      )
    ).toEqual([]);
    for (const item of accepted) {
      const installed = join(
        nativeRoot,
        "dist/compiler/assets/darwin",
        item.path
      );
      expect(await fileEvidence(installed)).toMatchObject({
        bytes: item.bytes,
        sha256: item.sha256,
      });
      const packed = await command(
        "/usr/bin/tar",
        [
          "-xOf",
          join(archives, "vgpu-native-0.0.0.tgz"),
          `package/dist/compiler/assets/darwin/${item.path}`,
        ],
        fixture,
        environment,
        true
      );
      expect(packed.code).toBe(0);
      expect(createHash("sha256").update(packed.bytes).digest("hex")).toBe(
        item.sha256
      );
      expect(packed.bytes.byteLength).toBe(item.bytes);
    }
    expect(await readdir(scratch)).toEqual([]);
    const input = await projectFixture();
    unplacedProject = input.directory;
    const project = join(fixture, "project");
    const output = join(project, relative(input.directory, input.outputPath));
    await rename(input.directory, project);
    unplacedProject = undefined;
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, "Handwritten output sentinel; do not replace\n", {
      flag: "wx",
    });
    const outputBefore = await lstat(output, { bigint: true });
    expect(outputBefore.isFile()).toBe(true);
    const projectBefore = await treeEvidence(project);
    const missingDeveloper = join(fixture, "missing-apple-toolchain");
    await expect(lstat(missingDeveloper)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const check = await command(
      process.execPath,
      [bin, "native", "check", "--config", "../project/vgpu.native.json"],
      runtime,
      { ...doctorEnvironment, DEVELOPER_DIR: missingDeveloper }
    );
    console.info("Installed check actual result", JSON.stringify(check));
    // Actual installed behavior is the first check oracle, not a future export or renderer prerequisite.
    expect(check.code, JSON.stringify(check)).toBe(0);
    expect(check.signal).toBeNull();
    expect(check.stderr).toBe("");
    expect(check.stdout).toMatch(
      /^Native shaders: valid\nModule: AppShaders\n\[ok\] Count: compute\n\[ok\] Gradient: vertex, fragment\nInput fingerprint: [a-f0-9]{64}\n$/u
    );
    expect(await treeEvidence(project)).toEqual(projectBefore);
    expect(await lstat(output, { bigint: true })).toMatchObject({
      dev: outputBefore.dev,
      ino: outputBefore.ino,
      mode: outputBefore.mode,
      nlink: outputBefore.nlink,
      size: outputBefore.size,
    });
    await expect(lstat(missingDeveloper)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const countSource = join(project, "shaders/count.wgsl");
    const countBefore = await readFile(countSource, "utf8");
    expect(countBefore.split("100u + index")).toHaveLength(2);
    const outputEvidence = await fileEvidence(output);
    await writeFile(
      countSource,
      countBefore.replace("100u + index", "vec2u(100u)")
    );
    const changedProject = await treeEvidence(project);
    const invalid = await command(
      process.execPath,
      [bin, "native", "check", "--config", "../project/vgpu.native.json"],
      runtime,
      { ...doctorEnvironment, DEVELOPER_DIR: missingDeveloper }
    );
    console.info(
      "Installed invalid check actual result",
      JSON.stringify(invalid)
    );
    expect(invalid.code, JSON.stringify(invalid)).toBe(1);
    expect(invalid.signal).toBeNull();
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("vec2<u32>");
    expect(invalid.stderr).toMatch(/cannot assign[^\n]*to 'u32'/u);
    expect(await treeEvidence(project)).toEqual(changedProject);
    expect(await fileEvidence(output)).toEqual(outputEvidence);
    expect(await lstat(output, { bigint: true })).toMatchObject({
      dev: outputBefore.dev,
      ino: outputBefore.ino,
      mode: outputBefore.mode,
      nlink: outputBefore.nlink,
      size: outputBefore.size,
    });
    await expect(lstat(missingDeveloper)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(invalid.stderr, JSON.stringify(invalid)).toMatch(
      /^Native shaders: invalid\n\[error\] VGPU-NATIVE-WGSL-INVALID \(wgsl\): [^\n]+\n  Resolved WGSL: Intermediate\/resolved\.wgsl:[1-9]\d*:[1-9]\d*\n$/u
    );
    expect(invalid.stderr).not.toContain("shaders/count.wgsl");
    expect(invalid.stderr).not.toContain(project);
    expect(invalid.stderr).not.toContain(workspace);
    expect(invalid.stderr).not.toContain("Input fingerprint:");
    expect(await readFile(countSource, "utf8")).toBe(
      countBefore.replace("100u + index", "vec2u(100u)")
    );
    await writeFile(countSource, countBefore);
    expect(await treeEvidence(project)).toEqual(projectBefore);
    expect(await fileEvidence(output)).toEqual(outputEvidence);
    expect(await lstat(output, { bigint: true })).toMatchObject({
      dev: outputBefore.dev,
      ino: outputBefore.ino,
      mode: outputBefore.mode,
      nlink: outputBefore.nlink,
      size: outputBefore.size,
    });
    await unlink(output); // Only the verified test-owned sentinel is removed as arrangement.
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dirname(output))).toEqual([]);
    const inputBeforeBuild = [
      await fileEvidence(join(project, "vgpu.native.json")),
      await treeEvidence(join(project, "shaders")),
    ];
    const build = await command(
      process.execPath,
      [bin, "native", "build", "--config", "../project/vgpu.native.json"],
      runtime,
      doctorEnvironment
    );
    console.info("Installed build actual result", JSON.stringify(build));
    // Publication is observed through the real installed command before inspecting any result artifact.
    expect(build.code, JSON.stringify(build)).toBe(0);
    expect(build.signal).toBeNull();
    expect(build.stderr).toBe("");
    for (const [directory, children] of [
      ["", [".vgpu-native-output.json", "Package.swift", "Sources"]],
      ["Sources", ["AppShaders"]],
      ["Sources/AppShaders", ["Resources", "Shaders.generated.swift"]],
      ["Sources/AppShaders/Resources", ["Shaders.metallib"]],
    ] as const) {
      const path = join(output, directory);
      expect((await lstat(path)).isDirectory()).toBe(true);
      expect((await readdir(path)).sort()).toEqual(children);
    }
    const payloadManifest = [];
    for (const path of [
      "Package.swift",
      "Sources/AppShaders/Resources/Shaders.metallib",
      "Sources/AppShaders/Shaders.generated.swift",
    ]) {
      const filename = join(output, path);
      const metadata = await lstat(filename, { bigint: true });
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1n);
      expect(metadata.size).toBeGreaterThan(0n);
      const evidence = await fileEvidence(filename);
      payloadManifest.push({ path, sha256: evidence.sha256 });
    }
    const recordFile = await open(
      join(output, ".vgpu-native-output.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    let recordBytes: Buffer;
    try {
      const metadata = await recordFile.stat({ bigint: true });
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1n);
      expect(metadata.size).toBeGreaterThan(0n);
      expect(metadata.size).toBeLessThanOrEqual(65536n);
      const buffer = Buffer.alloc(65537);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await recordFile.read(
          buffer,
          length,
          buffer.length - length,
          length
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      expect(BigInt(length)).toBe(metadata.size);
      recordBytes = buffer.subarray(0, length);
    } finally {
      await recordFile.close();
    }
    expect(isUtf8(recordBytes)).toBe(true);
    const fingerprint = check.stdout.match(
      /^Input fingerprint: ([a-f0-9]{64})$/mu
    )![1];
    expect(JSON.parse(recordBytes.toString("utf8"))).toEqual({
      schemaVersion: 1,
      format: "vgpu-metal-package/v1",
      moduleName: "AppShaders",
      ownerConfiguration: "../../vgpu.native.json",
      inputFingerprint: fingerprint,
      files: payloadManifest,
    });
    const recordHash = createHash("sha256").update(recordBytes).digest("hex");
    expect(build.stdout).toBe(
      `Native package: published\nModule: AppShaders\nOutput: ${output}\nInput fingerprint: ${fingerprint}\nRecord SHA-256: ${recordHash}\n`
    );
    expect((await readdir(project)).sort()).toEqual([
      "Generated",
      "shaders",
      "vgpu.native.json",
    ]);
    expect(await readdir(dirname(output))).toEqual(["AppShaders"]);
    expect([
      await fileEvidence(join(project, "vgpu.native.json")),
      await treeEvidence(join(project, "shaders")),
    ]).toEqual(inputBeforeBuild);
    expect(await treeEvidence(nativeRoot)).toEqual(nativeBefore);
    expect(await treeEvidence(publicRoot)).toEqual(publicBefore);
    expect(await fileEvidence(sentinel)).toEqual(sentinelBefore);
    expect(await readdir(runtime)).toEqual(["vgpu.native.json"]);
    expect(await readdir(scratch)).toEqual([]);
    for (const [filename, before] of archiveEvidence)
      expect(await fileEvidence(join(archives, filename))).toEqual(before);
  } finally {
    const cleanupFailures: unknown[] = [];
    for (const [path, evidence] of sourceEvidence) {
      try {
        expect(await fileEvidence(path)).toEqual(evidence);
      } catch (cause) {
        cleanupFailures.push(cause);
      }
    }
    for (const path of [
      ...(ownsAssets ? [assets] : []),
      ...(unplacedProject ? [unplacedProject] : []),
      fixture,
    ]) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (cause) {
        cleanupFailures.push(cause);
      }
    }
    if (cleanupFailures.length)
      throw new AggregateError(
        cleanupFailures,
        "Installed-doctor source preservation or cleanup failed"
      );
  }
}, 300_000);

type Result = {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  bytes: Buffer;
};

function boundedCommands(deadline: number) {
  return { command, checked };

  async function checked(
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv
  ): Promise<Result> {
    const result = await command(executable, args, cwd, env);
    if (result.code !== 0 || result.signal)
      throw new Error(
        `Setup failed (${executable} ${args.join(" ")}): ${JSON.stringify(
          result
        )}`
      );
    return result;
  }

  async function command(
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    binary = false
  ): Promise<Result> {
    if (Date.now() >= deadline)
      throw new Error("Installed-doctor overall command deadline exceeded");
    return new Promise((resolveCommand, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let failure: unknown;
      const stop = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ESRCH")
              failure ??= cause;
          }
      };
      const timeout = setTimeout(() => {
        failure = new Error("Bounded installed-doctor command timed out");
        stop();
      }, Math.min(120_000, deadline - Date.now()));
      child.on("error", (cause) => {
        failure = cause;
      });
      for (const [stream, chunks] of [
        [child.stdout, stdout],
        [child.stderr, stderr],
      ] as const)
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) {
            failure = new Error(
              "Installed-doctor command exceeded output bound"
            );
            stop();
          } else chunks.push(Buffer.from(chunk));
        });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (failure) {
          reject(failure);
          return;
        }
        const bytes = Buffer.concat(stdout);
        resolveCommand({
          code,
          signal,
          stdout: binary ? "" : bytes.toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          bytes: binary ? bytes : Buffer.alloc(0),
        });
      });
    });
  }
}

function packageResolutions(
  yaml: string
): Map<string, { integrity?: string; tarball?: string }> {
  const section = yaml.split("\npackages:\n")[1]?.split("\nsnapshots:\n")[0];
  if (!section) throw new Error("Setup: missing pnpm lock packages section");
  return new Map(
    [...section.matchAll(/^  (.+):\n([\s\S]*?)(?=^  \S|$(?![\s\S]))/gmu)].map(
      (match) => [
        match[1]!.replace(/^'|'$/gu, ""),
        {
          integrity: match[2]!.match(/integrity: ([^,}\s]+)/u)?.[1],
          tarball: match[2]!.match(/tarball: ([^,}\s]+)/u)?.[1],
        },
      ]
    )
  );
}

function inside(root: string, path: string): void {
  const child = relative(root, path);
  expect(
    child === "" ||
      (!child.startsWith(`..${sep}`) &&
        child !== ".." &&
        !child.startsWith(sep))
  ).toBe(true);
}

async function assertContainedLinks(path: string, root: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    inside(root, await realpath(path));
    return;
  }
  if (metadata.isDirectory())
    for (const name of await readdir(path))
      await assertContainedLinks(join(path, name), root);
}

async function fileEvidence(path: string) {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isFile()) throw new Error(`Expected ordinary file: ${path}`);
  const bytes = await readFile(path);
  return {
    mode: Number(metadata.mode),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function treeEvidence(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (metadata.isDirectory())
    return Promise.all(
      (await readdir(path))
        .sort()
        .map(async (name) => [name, await treeEvidence(join(path, name))])
    );
  return fileEvidence(path);
}
