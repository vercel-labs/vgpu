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
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { runConsumer } from "./native-support.ts";
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

test("an offline installed public vgpu diagnoses, checks, builds, verifies, and consumes documented shaders", async () => {
  expect(process.versions.node).toBe("22.19.0");
  expect(process.platform).toBe("darwin");
  const workflowDeadline = Date.now() + 240_000;
  const { command, checked } = boundedCommands(workflowDeadline);
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
    const outputParent = dirname(output);
    const retainedStage = join(outputParent, ".vgpu-native-stage");
    const retainedJournal = join(outputParent, ".vgpu-native-publication.json");
    for (const path of [retainedStage, retainedJournal])
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(retainedStage);
    const retainedSentinel = join(retainedStage, "handwritten.txt");
    await writeFile(
      retainedSentinel,
      "Unknown staging evidence; preserve me\n",
      {
        flag: "wx",
      }
    );
    await writeFile(retainedJournal, "{}\n", { flag: "wx" });
    for (const path of [retainedJournal, retainedSentinel]) {
      const metadata = await lstat(path, { bigint: true });
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1n);
    }
    expect(await readFile(retainedJournal, "utf8")).toBe("{}\n");
    const retainedTreeBefore = await treeEvidence(project);
    const retainedIdentities = await Promise.all(
      [
        outputParent,
        output,
        join(output, "Sources"),
        join(output, "Sources/AppShaders"),
        join(output, "Sources/AppShaders/Resources"),
        ...payloadManifest.map(({ path }) => join(output, path)),
        join(output, ".vgpu-native-output.json"),
        retainedStage,
        retainedJournal,
        retainedSentinel,
      ].map(async (path) => {
        const { dev, ino, mode, nlink, size } = await lstat(path, {
          bigint: true,
        });
        return { path, metadata: { dev, ino, mode, nlink, size } };
      })
    );
    const publicationConflict = await command(
      process.execPath,
      [bin, "native", "build", "--config", "../project/vgpu.native.json"],
      runtime,
      doctorEnvironment
    );
    console.info(
      "Installed retained publication actual result",
      JSON.stringify(publicationConflict)
    );
    expect(publicationConflict.code, JSON.stringify(publicationConflict)).toBe(
      1
    );
    expect(publicationConflict.signal).toBeNull();
    expect(publicationConflict.stdout).toBe("");
    expect(publicationConflict.stderr).toContain(
      "Metal publication not-published: Unrecognized publication recovery record"
    );
    expect(await treeEvidence(project)).toEqual(retainedTreeBefore);
    for (const { path, metadata } of retainedIdentities)
      expect(await lstat(path, { bigint: true })).toMatchObject(metadata);
    expect((await readdir(outputParent)).sort()).toEqual([
      ".vgpu-native-publication.json",
      ".vgpu-native-stage",
      "AppShaders",
    ]);
    expect(await readdir(scratch)).toEqual([]);
    expect(await treeEvidence(nativeRoot)).toEqual(nativeBefore);
    expect(await treeEvidence(publicRoot)).toEqual(publicBefore);
    expect(await fileEvidence(sentinel)).toEqual(sentinelBefore);
    expect(await readdir(runtime)).toEqual(["vgpu.native.json"]);
    for (const [filename, before] of archiveEvidence)
      expect(await fileEvidence(join(archives, filename))).toEqual(before);
    expect(
      publicationConflict.stderr,
      JSON.stringify(publicationConflict)
    ).toBe(
      `Native publication: not-published\n[error] conflict: Metal publication not-published: Unrecognized publication recovery record\nInspect retained paths (not cleanup authority):\n  ${retainedStage}\n  ${retainedJournal}\n`
    );
    const missingVerifyTemp = join(fixture, "missing-verify-temp");
    for (const path of [missingDeveloper, missingVerifyTemp])
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    const verify = await command(
      process.execPath,
      [bin, "native", "verify", "--config", "../project/vgpu.native.json"],
      runtime,
      {
        ...doctorEnvironment,
        DEVELOPER_DIR: missingDeveloper,
        TMPDIR: missingVerifyTemp,
      }
    );
    console.info("Installed verify actual result", JSON.stringify(verify));
    expect(verify.code, JSON.stringify(verify)).toBe(0);
    expect(verify.signal).toBeNull();
    expect(verify.stderr).toBe("");
    expect(verify.stdout).toBe(
      `Native package: current\nModule: AppShaders\nOutput: ${output}\nInput fingerprint: ${fingerprint}\n`
    );
    for (const path of [missingDeveloper, missingVerifyTemp])
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await treeEvidence(project)).toEqual(retainedTreeBefore);
    for (const { path, metadata } of retainedIdentities)
      expect(await lstat(path, { bigint: true })).toMatchObject(metadata);
    expect((await readdir(outputParent)).sort()).toEqual([
      ".vgpu-native-publication.json",
      ".vgpu-native-stage",
      "AppShaders",
    ]);
    expect(await readdir(scratch)).toEqual([]);
    expect(await treeEvidence(nativeRoot)).toEqual(nativeBefore);
    expect(await treeEvidence(publicRoot)).toEqual(publicBefore);
    expect(await fileEvidence(sentinel)).toEqual(sentinelBefore);
    expect(await readdir(runtime)).toEqual(["vgpu.native.json"]);
    for (const [filename, before] of archiveEvidence)
      expect(await fileEvidence(join(archives, filename))).toEqual(before);
    const helperSource = join(project, "shaders/dimensions.wgsl");
    const helperBefore = await readFile(helperSource);
    const helperChanged = Buffer.concat([
      helperBefore,
      Buffer.from("\n// Changed imported source, same shader behavior.\n"),
    ]);
    await writeFile(helperSource, helperChanged);
    const staleProjectBefore = await treeEvidence(project);
    const stale = await command(
      process.execPath,
      [bin, "native", "verify", "--config", "../project/vgpu.native.json"],
      runtime,
      {
        ...doctorEnvironment,
        DEVELOPER_DIR: missingDeveloper,
        TMPDIR: missingVerifyTemp,
      }
    );
    console.info("Installed stale verify actual result", JSON.stringify(stale));
    expect(stale.code, JSON.stringify(stale)).toBe(1);
    expect(stale.signal).toBeNull();
    expect(stale.stdout).toBe("");
    expect(stale.stderr).toBe(
      "Generated output is stale; build the Metal package again\n"
    );
    expect(await treeEvidence(project)).toEqual(staleProjectBefore);
    for (const { path, metadata } of retainedIdentities)
      expect(await lstat(path, { bigint: true })).toMatchObject(metadata);
    expect((await readdir(outputParent)).sort()).toEqual([
      ".vgpu-native-publication.json",
      ".vgpu-native-stage",
      "AppShaders",
    ]);
    for (const path of [missingDeveloper, missingVerifyTemp])
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(scratch)).toEqual([]);
    expect(await treeEvidence(nativeRoot)).toEqual(nativeBefore);
    expect(await treeEvidence(publicRoot)).toEqual(publicBefore);
    expect(await fileEvidence(sentinel)).toEqual(sentinelBefore);
    expect(await readdir(runtime)).toEqual(["vgpu.native.json"]);
    for (const [filename, before] of archiveEvidence)
      expect(await fileEvidence(join(archives, filename))).toEqual(before);
    expect(await readFile(helperSource)).toEqual(helperChanged);
    await writeFile(helperSource, helperBefore);
    expect(await treeEvidence(project)).toEqual(retainedTreeBefore);
    const generatedSwift = join(
      output,
      "Sources/AppShaders/Shaders.generated.swift"
    );
    const swiftBefore = await readFile(generatedSwift);
    const swiftComment = Buffer.from(
      "\n// Test-owned generated output alteration.\n"
    );
    const swiftChanged = Buffer.concat([swiftBefore, swiftComment]);
    await writeFile(generatedSwift, swiftChanged);
    const alteredProjectBefore = await treeEvidence(project);
    const alteredIdentities = retainedIdentities.map(({ path, metadata }) => ({
      path,
      metadata:
        path === generatedSwift
          ? { ...metadata, size: metadata.size + BigInt(swiftComment.length) }
          : metadata,
    }));
    for (const { path, metadata } of alteredIdentities)
      expect(await lstat(path, { bigint: true })).toMatchObject(metadata);
    const invalidOutput = await command(
      process.execPath,
      [bin, "native", "verify", "--config", "../project/vgpu.native.json"],
      runtime,
      {
        ...doctorEnvironment,
        DEVELOPER_DIR: missingDeveloper,
        TMPDIR: missingVerifyTemp,
      }
    );
    console.info(
      "Installed integrity verify actual result",
      JSON.stringify(invalidOutput)
    );
    expect(invalidOutput.code, JSON.stringify(invalidOutput)).toBe(1);
    expect(invalidOutput.signal).toBeNull();
    expect(invalidOutput.stdout).toBe("");
    expect(invalidOutput.stderr).toBe(
      "Generated file has changed: Sources/AppShaders/Shaders.generated.swift\n"
    );
    expect(await treeEvidence(project)).toEqual(alteredProjectBefore);
    for (const { path, metadata } of alteredIdentities)
      expect(await lstat(path, { bigint: true })).toMatchObject(metadata);
    expect((await readdir(outputParent)).sort()).toEqual([
      ".vgpu-native-publication.json",
      ".vgpu-native-stage",
      "AppShaders",
    ]);
    const unchangedRecord = await readFile(
      join(output, ".vgpu-native-output.json")
    );
    expect(unchangedRecord).toEqual(recordBytes);
    expect(createHash("sha256").update(unchangedRecord).digest("hex")).toBe(
      recordHash
    );
    for (const path of [missingDeveloper, missingVerifyTemp])
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(scratch)).toEqual([]);
    expect(await treeEvidence(nativeRoot)).toEqual(nativeBefore);
    expect(await treeEvidence(publicRoot)).toEqual(publicBefore);
    expect(await fileEvidence(sentinel)).toEqual(sentinelBefore);
    expect(await readdir(runtime)).toEqual(["vgpu.native.json"]);
    for (const [filename, before] of archiveEvidence)
      expect(await fileEvidence(join(archives, filename))).toEqual(before);
    expect(await readFile(generatedSwift)).toEqual(swiftChanged);
    await writeFile(generatedSwift, swiftBefore);
    expect(await treeEvidence(project)).toEqual(retainedTreeBefore);
    for (const { path, metadata } of retainedIdentities)
      expect(await lstat(path, { bigint: true })).toMatchObject(metadata);
    expect(await readFile(countSource, "utf8")).toBe(countBefore);
    const invalidBuildSource = countBefore.replace(
      "100u + index",
      "vec2u(100u)"
    );
    await writeFile(countSource, invalidBuildSource);
    const invalidBuildTreeBefore = await treeEvidence(project);
    const invalidBuild = await command(
      process.execPath,
      [bin, "native", "build", "--config", "../project/vgpu.native.json"],
      runtime,
      { ...doctorEnvironment, DEVELOPER_DIR: missingDeveloper }
    );
    console.info(
      "Installed invalid build actual result",
      JSON.stringify(invalidBuild)
    );
    expect(invalidBuild.code, JSON.stringify(invalidBuild)).toBe(1);
    expect(invalidBuild.signal).toBeNull();
    expect(invalidBuild.stdout).toBe("");
    expect(invalidBuild.stderr).toContain("vec2<u32>");
    expect(invalidBuild.stderr).toMatch(/cannot assign[^\n]*to 'u32'/u);
    expect(await treeEvidence(project)).toEqual(invalidBuildTreeBefore);
    for (const { path, metadata } of retainedIdentities)
      expect(await lstat(path, { bigint: true })).toMatchObject(metadata);
    expect((await readdir(outputParent)).sort()).toEqual([
      ".vgpu-native-publication.json",
      ".vgpu-native-stage",
      "AppShaders",
    ]);
    const invalidBuildRecord = await readFile(
      join(output, ".vgpu-native-output.json")
    );
    expect(invalidBuildRecord).toEqual(recordBytes);
    expect(createHash("sha256").update(invalidBuildRecord).digest("hex")).toBe(
      recordHash
    );
    for (const path of [missingDeveloper, missingVerifyTemp])
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(scratch)).toEqual([]);
    expect(await treeEvidence(nativeRoot)).toEqual(nativeBefore);
    expect(await treeEvidence(publicRoot)).toEqual(publicBefore);
    expect(await fileEvidence(sentinel)).toEqual(sentinelBefore);
    expect(await readdir(runtime)).toEqual(["vgpu.native.json"]);
    for (const [filename, before] of archiveEvidence)
      expect(await fileEvidence(join(archives, filename))).toEqual(before);
    expect(invalidBuild.stderr, JSON.stringify(invalidBuild)).toBe(
      invalid.stderr
    );
    expect(await readFile(countSource, "utf8")).toBe(invalidBuildSource);
    await writeFile(countSource, countBefore);
    expect(await treeEvidence(project)).toEqual(retainedTreeBefore);
    for (const { path, metadata } of retainedIdentities)
      expect(await lstat(path, { bigint: true })).toMatchObject(metadata);
    const consumerFiles: Record<string, Uint8Array> = {};
    expect(payloadManifest).toHaveLength(3);
    for (const { path, sha256 } of payloadManifest) {
      const filename = join(output, path);
      const bytes = await readFile(filename);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
      const original = retainedIdentities.find(
        (entry) => entry.path === filename
      );
      expect(original).toBeDefined();
      expect(BigInt(bytes.length)).toBe(original!.metadata.size);
      consumerFiles[path] = Uint8Array.from(bytes);
    }
    const computeSwift = [
      ...(
        await readFile(
          new URL(
            "../../../docs/topics/native/macos/metal/compute/native-macos-metal-compute-dispatch.docs.md",
            import.meta.url
          ),
          "utf8"
        )
      ).matchAll(/```swift\n([\s\S]*?)\n```/gu),
    ].map((match) => match[1]!);
    const uniformSwift = [
      ...(
        await readFile(
          new URL(
            "../../../docs/topics/native/macos/metal/native-macos-metal-uniforms.docs.md",
            import.meta.url
          ),
          "utf8"
        )
      ).matchAll(/```swift\n([\s\S]*?)\n```/gu),
    ].map((match) => match[1]!);
    expect(computeSwift).toHaveLength(4);
    expect(uniformSwift).toHaveLength(3);
    const consumerSource = `import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
${computeSwift[0]}
${uniformSwift[0]}
${uniformSwift[1]}
var countValues: [UInt32] = []
var pixelValues: [Float] = []
do {
  precondition(Count.workgroupSize.width == 2 && Count.workgroupSize.height == 1 && Count.workgroupSize.depth == 1)
  let outputBuffer = device.makeBuffer(length: 8, options: .storageModeShared)!
  let bindings = Count.Bindings(output: ShaderBufferRange(buffer: outputBuffer, offset: 0, length: 8))
  let command = device.makeCommandQueue()!.makeCommandBuffer()!
  let encoder = command.makeComputeCommandEncoder()!
${computeSwift[3]}
  encoder.endEncoding()
  command.commit()
  command.waitUntilCompleted()
  precondition(command.status == .completed, String(describing: command.error))
  countValues = (0..<2).map { outputBuffer.contents().load(fromByteOffset: $0 * 4, as: UInt32.self).littleEndian }
}
do {
  let functions = try Gradient.load(device: device)
  let vertices = MTLVertexDescriptor()
  vertices.attributes[0].format = .float2
  vertices.attributes[0].offset = 0
  vertices.attributes[0].bufferIndex = 0
  vertices.layouts[0].stride = 8
  vertices.layouts[0].stepFunction = .perVertex
  let descriptor = MTLRenderPipelineDescriptor()
  descriptor.vertexFunction = functions.vertex
  descriptor.fragmentFunction = functions.fragment
  descriptor.vertexDescriptor = vertices
  descriptor.colorAttachments[0].pixelFormat = .rgba32Float
  let pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
  let positions: [Float] = [-1, -1, 3, -1, -1, 3]
  let vertexBuffer = positions.withUnsafeBufferPointer { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count * 4, options: .storageModeShared)! }
  let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba32Float, width: 1, height: 1, mipmapped: false)
  textureDescriptor.storageMode = .private
  textureDescriptor.usage = [.renderTarget]
  let texture = device.makeTexture(descriptor: textureDescriptor)!
  let readback = device.makeBuffer(length: 256, options: .storageModeShared)!
  let command = device.makeCommandQueue()!.makeCommandBuffer()!
  let pass = MTLRenderPassDescriptor()
  pass.colorAttachments[0].texture = texture
  pass.colorAttachments[0].loadAction = .clear
  pass.colorAttachments[0].storeAction = .store
  let encoder = command.makeRenderCommandEncoder(descriptor: pass)!
  encoder.setRenderPipelineState(pipeline)
  encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)
${uniformSwift[2]}
  encoder.endEncoding()
  let blit = command.makeBlitCommandEncoder()!
  blit.copy(from: texture, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0), sourceSize: MTLSize(width: 1, height: 1, depth: 1), to: readback, destinationOffset: 0, destinationBytesPerRow: 256, destinationBytesPerImage: 256)
  blit.endEncoding()
  command.commit()
  command.waitUntilCompleted()
  precondition(command.status == .completed, String(describing: command.error))
  pixelValues = (0..<4).map { readback.contents().load(fromByteOffset: $0 * 4, as: Float.self) }
}
let result: [String: Any] = ["count": countValues, "pixels": pixelValues]
print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`;
    // Reserve the helper's four configured child waits (105 s) plus cleanup margin.
    expect(workflowDeadline - Date.now()).toBeGreaterThanOrEqual(120_000);
    const consumerOutput = await runConsumer(
      { AppShaders: { files: consumerFiles } },
      consumerSource,
      undefined,
      { isolatedDistribution: true }
    );
    console.info("Installed candidate GPU actual result", consumerOutput);
    const gpu = JSON.parse(consumerOutput);
    expect(Object.keys(gpu).sort()).toEqual(["count", "pixels"]);
    expect(gpu.count).toEqual([100, 101]);
    expect(gpu.pixels).toHaveLength(4);
    for (const [index, expected] of [0.28, 0.44, 0.8, 1].entries()) {
      expect(Number.isFinite(gpu.pixels[index])).toBe(true);
      expect(gpu.pixels[index]).toBeCloseTo(expected, 6);
    }
    expect(await treeEvidence(project)).toEqual(retainedTreeBefore);
    for (const { path, metadata } of retainedIdentities)
      expect(await lstat(path, { bigint: true })).toMatchObject(metadata);
    const consumedRecord = await readFile(
      join(output, ".vgpu-native-output.json")
    );
    expect(consumedRecord).toEqual(recordBytes);
    expect(createHash("sha256").update(consumedRecord).digest("hex")).toBe(
      recordHash
    );
    expect((await readdir(outputParent)).sort()).toEqual([
      ".vgpu-native-publication.json",
      ".vgpu-native-stage",
      "AppShaders",
    ]);
    for (const path of [missingDeveloper, missingVerifyTemp])
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(scratch)).toEqual([]);
    expect(await treeEvidence(nativeRoot)).toEqual(nativeBefore);
    expect(await treeEvidence(publicRoot)).toEqual(publicBefore);
    expect(await fileEvidence(sentinel)).toEqual(sentinelBefore);
    expect(await readdir(runtime)).toEqual(["vgpu.native.json"]);
    for (const [filename, before] of archiveEvidence)
      expect(await fileEvidence(join(archives, filename))).toEqual(before);
    // Explicit fault instrumentation of this one installed command, not ordinary loader qualification.
    expect(workflowDeadline - Date.now()).toBeGreaterThanOrEqual(105_000);
    const originalProjectNames = (await readdir(project)).sort();
    const lostConfiguration = join(project, "lost-ack.native.json");
    const lostParent = join(project, "LostAck");
    const lostOutput = join(lostParent, "AppShaders");
    const lostStage = join(lostParent, ".vgpu-native-stage");
    const lostJournal = join(lostParent, ".vgpu-native-publication.json");
    const faultEvidence = join(fixture, "publication-fault");
    await mkdir(faultEvidence);
    await mkdir(lostParent);
    const lostConfigurationBytes = Buffer.from(
      JSON.stringify({
        ...JSON.parse(
          await readFile(join(project, "vgpu.native.json"), "utf8")
        ),
        output: "LostAck/AppShaders",
      })
    );
    await writeFile(lostConfiguration, lostConfigurationBytes, { flag: "wx" });
    const lostConfigurationIdentity = await lstat(lostConfiguration, {
      bigint: true,
    });
    const lostParentIdentity = await lstat(lostParent, { bigint: true });
    expect(await readdir(lostParent)).toEqual([]);
    const preload = new URL(
      "./fixtures/publication-cli-fault-injection.mjs",
      import.meta.url
    );
    const observerSource = new URL(
      "./fixtures/publication-rename-conflict.c",
      import.meta.url
    );
    const faultSources = [
      fileURLToPath(preload),
      fileURLToPath(observerSource),
    ];
    const faultSourceEvidence = await Promise.all(
      faultSources.map(fileEvidence)
    );
    const observer = join(faultEvidence, "rename-observer.dylib");
    await boundedCommands(
      Math.min(workflowDeadline, Date.now() + 30_000)
    ).checked(
      "/usr/bin/xcrun",
      [
        "--sdk",
        "macosx",
        "clang",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-mmacosx-version-min=14.0",
        "-dynamiclib",
        fileURLToPath(observerSource),
        "-o",
        observer,
      ],
      fixture,
      doctorEnvironment
    );
    const observerBefore = await fileEvidence(observer);
    const paused = join(faultEvidence, "paused");
    const resume = join(faultEvidence, "resume");
    const completed = join(faultEvidence, "completed");
    const faultDeadline = Math.min(workflowDeadline, Date.now() + 60_000);
    let faultResult: Result | undefined;
    let faultError: unknown;
    let faultSettled = false;
    const faultOperation = boundedCommands(faultDeadline)
      .command(
        process.execPath,
        [
          "--import",
          preload.href,
          bin,
          "native",
          "build",
          "--config",
          "../project/lost-ack.native.json",
        ],
        runtime,
        {
          ...doctorEnvironment,
          VGPU_CLI_FAULT_PARENT_PID: String(process.pid),
          VGPU_CLI_FAULT_SETTINGS: JSON.stringify({
            bin,
            configurationPath: lostConfiguration,
            configurationArgument: "../project/lost-ack.native.json",
            parentPath: lostParent,
            scratch,
            evidence: faultEvidence,
            observer,
          }),
        }
      )
      .then(
        (result) => {
          faultResult = result;
          faultSettled = true;
        },
        (cause: unknown) => {
          faultError = cause;
          faultSettled = true;
        }
      );
    try {
      let reachedPause = false;
      while (Date.now() < faultDeadline) {
        if (faultSettled)
          throw new Error(
            `Setup: fault-injected command closed before rename pause: ${String(
              faultError ?? JSON.stringify(faultResult)
            )}`
          );
        const marker = await readFile(paused, "utf8").catch(
          (cause: NodeJS.ErrnoException) => {
            if (cause.code !== "ENOENT") throw cause;
            return undefined;
          }
        );
        if (marker !== undefined) {
          expect(marker).toBe("before-rename\n");
          reachedPause = true;
          break;
        }
        await delay(5);
      }
      if (!reachedPause)
        throw new Error("Setup: real helper never reached the rename pause");
      const entry = JSON.parse(
        await readFile(join(faultEvidence, "entry.json"), "utf8")
      );
      const publisher = JSON.parse(
        await readFile(join(faultEvidence, "publisher.json"), "utf8")
      );
      expect(entry).toEqual({
        pid: expect.any(Number),
        parentPid: process.pid,
        argv: [
          process.execPath,
          bin,
          "native",
          "build",
          "--config",
          "../project/lost-ack.native.json",
        ],
      });
      expect(publisher).toMatchObject({
        pid: expect.any(Number),
        sanitized: true,
      });
      expect(publisher.args).toEqual([
        "vgpu-publication-staging/v1",
        lostParent,
        "AppShaders",
        "AppShaders",
        expect.stringMatching(/^[a-f0-9]{32}$/u),
        "publish-project",
        lostConfiguration,
      ]);
      for (const path of [
        lostOutput,
        resume,
        completed,
        join(faultEvidence, "publisher-close.json"),
        join(faultEvidence, "reconciliation.json"),
      ])
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      const journal = await boundedFaultFile(lostJournal);
      expect(isUtf8(journal.bytes)).toBe(true);
      expect((await readdir(lostParent)).sort()).toEqual([
        ".vgpu-native-publication.json",
        ".vgpu-native-stage",
      ]);
      const stagedDirectories = [];
      for (const [path, children] of [
        ["", [".vgpu-native-output.json", "Package.swift", "Sources"]],
        ["Sources", ["AppShaders"]],
        ["Sources/AppShaders", ["Resources", "Shaders.generated.swift"]],
        ["Sources/AppShaders/Resources", ["Shaders.metallib"]],
      ] as const) {
        const metadata = await lstat(join(lostStage, path), { bigint: true });
        expect(metadata.isDirectory()).toBe(true);
        expect((await readdir(join(lostStage, path))).sort()).toEqual(children);
        stagedDirectories.push({ path, children, metadata });
      }
      const stagedFiles = [];
      for (const [role, path] of [
        ["package-manifest", "Package.swift"],
        ["swift-source", "Sources/AppShaders/Shaders.generated.swift"],
        ["metal-library", "Sources/AppShaders/Resources/Shaders.metallib"],
        ["output-record", ".vgpu-native-output.json"],
      ] as const)
        stagedFiles.push({
          role,
          path,
          ...(await boundedFaultFile(join(lostStage, path))),
        });
      const originalStage = stagedDirectories[0]!.metadata;
      const preparedJournal = JSON.parse(journal.bytes.toString("utf8"));
      expect(preparedJournal).toEqual({
        schemaVersion: 1,
        kind: "vgpu-native-publication",
        phase: "prepared",
        transactionId: publisher.args[4],
        parent: {
          device: lostParentIdentity.dev.toString(),
          inode: lostParentIdentity.ino.toString(),
        },
        destinationName: "AppShaders",
        moduleName: "AppShaders",
        publication: { renameMode: "excl", expectedDestination: "missing" },
        stage: {
          name: ".vgpu-native-stage",
          device: originalStage.dev.toString(),
          inode: originalStage.ino.toString(),
        },
        recordSHA256: createHash("sha256")
          .update(stagedFiles[3]!.bytes)
          .digest("hex"),
        files: stagedFiles.map(({ role, path, bytes }) => ({
          role,
          path,
          length: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })),
      });
      expect(isUtf8(stagedFiles[3]!.bytes)).toBe(true);
      expect(JSON.parse(stagedFiles[3]!.bytes.toString("utf8"))).toMatchObject({
        schemaVersion: 1,
        format: "vgpu-metal-package/v1",
        moduleName: "AppShaders",
        ownerConfiguration: "../../lost-ack.native.json",
        files: stagedFiles
          .slice(0, 3)
          .map(({ path, bytes }) => ({
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      });
      await writeFile(resume, "resume\n", { flag: "wx" });
      await faultOperation;
      if (faultError) throw faultError;
      if (!faultResult)
        throw new Error("Setup: fault command has no settled result");
      console.info(
        "Fault-injected installed publication actual result",
        JSON.stringify(faultResult)
      );
      expect(await readFile(completed, "utf8")).toMatch(/^0 \d+\n$/u);
      const publisherClose = JSON.parse(
        await readFile(join(faultEvidence, "publisher-close.json"), "utf8")
      );
      expect(publisherClose).toEqual({
        pid: publisher.pid,
        code: 97,
        signal: null,
      });
      const reconciliation = JSON.parse(
        await readFile(join(faultEvidence, "reconciliation.json"), "utf8")
      );
      expect(reconciliation).toEqual({
        executable: publisher.executable,
        pid: expect.any(Number),
        args: [
          "vgpu-publication-staging/v1",
          lostParent,
          "AppShaders",
          "AppShaders",
          publisher.args[4],
          "reconcile-missing",
          lostParentIdentity.dev.toString(),
          lostParentIdentity.ino.toString(),
        ],
        afterPublisherClose: publisherClose,
        injected: false,
      });
      expect(reconciliation.pid).not.toBe(publisher.pid);
      expect(
        JSON.parse(
          await readFile(
            join(faultEvidence, "reconciliation-close.json"),
            "utf8"
          )
        )
      ).toEqual({ pid: reconciliation.pid, code: 0, signal: null });
      expect((await readdir(faultEvidence)).sort()).toEqual([
        "completed",
        "entry.json",
        "paused",
        "publisher-close.json",
        "publisher.json",
        "reconciliation-close.json",
        "reconciliation.json",
        "rename-observer.dylib",
        "resume",
      ]);
      for (const { path, children, metadata } of stagedDirectories) {
        expect((await readdir(join(lostOutput, path))).sort()).toEqual(
          children
        );
        expect(
          await lstat(join(lostOutput, path), { bigint: true })
        ).toMatchObject({
          dev: metadata.dev,
          ino: metadata.ino,
          mode: metadata.mode,
          nlink: metadata.nlink,
        });
      }
      for (const { path, bytes, metadata } of stagedFiles) {
        const retained = await boundedFaultFile(join(lostOutput, path));
        expect(retained.bytes).toEqual(bytes);
        expect(retained.metadata).toMatchObject({
          dev: metadata.dev,
          ino: metadata.ino,
          mode: metadata.mode,
          nlink: metadata.nlink,
          size: metadata.size,
        });
      }
      const journalAfter = await boundedFaultFile(lostJournal);
      expect(journalAfter.bytes).toEqual(journal.bytes);
      expect(journalAfter.metadata).toMatchObject({
        dev: journal.metadata.dev,
        ino: journal.metadata.ino,
        mode: journal.metadata.mode,
        nlink: journal.metadata.nlink,
        size: journal.metadata.size,
      });
      expect((await readdir(lostParent)).sort()).toEqual([
        ".vgpu-native-publication.json",
        "AppShaders",
      ]);
      await expect(lstat(lostStage)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await lstat(lostParent, { bigint: true })).toMatchObject({
        dev: lostParentIdentity.dev,
        ino: lostParentIdentity.ino,
        mode: lostParentIdentity.mode,
      });
      expect(await readFile(lostConfiguration)).toEqual(lostConfigurationBytes);
      expect(await lstat(lostConfiguration, { bigint: true })).toMatchObject({
        dev: lostConfigurationIdentity.dev,
        ino: lostConfigurationIdentity.ino,
        mode: lostConfigurationIdentity.mode,
        nlink: lostConfigurationIdentity.nlink,
        size: lostConfigurationIdentity.size,
      });
      expect((await readdir(project)).sort()).toEqual(
        [...originalProjectNames, "LostAck", "lost-ack.native.json"].sort()
      );
      expect(
        await Promise.all(
          originalProjectNames.map(async (name) => [
            name,
            await treeEvidence(join(project, name)),
          ])
        )
      ).toEqual(retainedTreeBefore);
      for (const { path, metadata } of retainedIdentities)
        expect(await lstat(path, { bigint: true })).toMatchObject(metadata);
      for (const path of [missingDeveloper, missingVerifyTemp])
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(scratch)).toEqual([]);
      expect(await treeEvidence(nativeRoot)).toEqual(nativeBefore);
      expect(await treeEvidence(publicRoot)).toEqual(publicBefore);
      expect(await fileEvidence(sentinel)).toEqual(sentinelBefore);
      expect(await readdir(runtime)).toEqual(["vgpu.native.json"]);
      for (const [filename, before] of archiveEvidence)
        expect(await fileEvidence(join(archives, filename))).toEqual(before);
      expect(await Promise.all(faultSources.map(fileEvidence))).toEqual(
        faultSourceEvidence
      );
      expect(await fileEvidence(observer)).toEqual(observerBefore);
      // Only the receipt-backed formatting assertion below is the intended RED.
      expect(faultResult.code, JSON.stringify(faultResult)).toBe(1);
      expect(faultResult.signal).toBeNull();
      expect(faultResult.stdout).toBe("");
      expect(faultResult.stderr).toContain("Native publication: published\n");
      expect(faultResult.stderr).toContain(
        "[error] helper-failed: Metal publication published: Invalid publication staging helper response\n"
      );
      expect(faultResult.stderr).toContain(
        `Inspect retained paths (not cleanup authority):\n  ${lostJournal}\n  ${lostOutput}\n`
      );
      expect(faultResult.stderr, JSON.stringify(faultResult)).toBe(
        `Native publication: published\nConfirmation: reconciled\n[error] helper-failed: Metal publication published: Invalid publication staging helper response\nInspect retained paths (not cleanup authority):\n  ${lostJournal}\n  ${lostOutput}\n`
      );
      // A later ordinary invocation recognizes evidence; it does not inherit the earlier receipt.
      const interruptedProjectBefore = await treeEvidence(project);
      const interruptedFaultBefore = await treeEvidence(faultEvidence);
      const interruptedIdentities = await Promise.all(
        [
          ...retainedIdentities.map(({ path }) => path),
          lostConfiguration,
          lostParent,
          lostJournal,
          ...stagedDirectories.map(({ path }) => join(lostOutput, path)),
          ...stagedFiles.map(({ path }) => join(lostOutput, path)),
          faultEvidence,
          ...(
            await readdir(faultEvidence)
          ).map((name) => join(faultEvidence, name)),
        ].map(async (path) => {
          const metadata = await lstat(path, { bigint: true });
          return {
            path,
            metadata: {
              dev: metadata.dev,
              ino: metadata.ino,
              mode: metadata.mode,
              nlink: metadata.nlink,
              size: metadata.size,
            },
          };
        })
      );
      expect(
        Object.keys(doctorEnvironment).filter((name) =>
          /^(?:VGPU_CLI_FAULT_|DYLD_|LD_)/u.test(name)
        )
      ).toEqual([]);
      expect(workflowDeadline - Date.now()).toBeGreaterThanOrEqual(75_000);
      const interrupted = await boundedCommands(
        Math.min(workflowDeadline, Date.now() + 60_000)
      ).command(
        process.execPath,
        [bin, "native", "build", "--config", "../project/lost-ack.native.json"],
        runtime,
        doctorEnvironment
      );
      console.info(
        "Installed recognized interruption actual result",
        JSON.stringify(interrupted)
      );
      expect(await treeEvidence(project)).toEqual(interruptedProjectBefore);
      expect(await treeEvidence(faultEvidence)).toEqual(interruptedFaultBefore);
      for (const { path, metadata } of interruptedIdentities)
        expect(await lstat(path, { bigint: true })).toMatchObject(metadata);
      expect((await boundedFaultFile(lostJournal)).bytes).toEqual(
        journal.bytes
      );
      for (const { path, bytes } of stagedFiles)
        expect((await boundedFaultFile(join(lostOutput, path))).bytes).toEqual(
          bytes
        );
      expect((await readdir(lostParent)).sort()).toEqual([
        ".vgpu-native-publication.json",
        "AppShaders",
      ]);
      await expect(lstat(lostStage)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await Promise.all(
          originalProjectNames.map(async (name) => [
            name,
            await treeEvidence(join(project, name)),
          ])
        )
      ).toEqual(retainedTreeBefore);
      for (const path of [missingDeveloper, missingVerifyTemp])
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(scratch)).toEqual([]);
      expect(await treeEvidence(nativeRoot)).toEqual(nativeBefore);
      expect(await treeEvidence(publicRoot)).toEqual(publicBefore);
      expect(await fileEvidence(sentinel)).toEqual(sentinelBefore);
      expect(await readdir(runtime)).toEqual(["vgpu.native.json"]);
      for (const [filename, before] of archiveEvidence)
        expect(await fileEvidence(join(archives, filename))).toEqual(before);
      expect(await Promise.all(faultSources.map(fileEvidence))).toEqual(
        faultSourceEvidence
      );
      for (const [path, evidence] of sourceEvidence)
        expect(await fileEvidence(path)).toEqual(evidence);
      // Honest already-GREEN coverage: this result concerns only the new invocation.
      expect(interrupted.code, JSON.stringify(interrupted)).toBe(1);
      expect(interrupted.signal).toBeNull();
      expect(interrupted.stdout).toBe("");
      expect(interrupted.stderr).toBe(
        `Native publication: not-published\n[error] interrupted-transaction: Metal publication not-published: Interrupted publication ${preparedJournal.transactionId} for ${lostOutput}\nInspect retained paths (not cleanup authority):\n  ${lostJournal}\n`
      );
    } finally {
      // The public process-group deadline owns shutdown, even if barrier/evidence setup fails.
      await faultOperation;
    }
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

async function boundedFaultFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat({ bigint: true });
    expect(metadata.isFile()).toBe(true);
    expect(metadata.nlink).toBe(1n);
    expect(metadata.size).toBeGreaterThan(0n);
    expect(metadata.size).toBeLessThanOrEqual(65536n);
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    expect(BigInt(length)).toBe(metadata.size);
    return { bytes: buffer.subarray(0, length), metadata };
  } finally {
    await file.close();
  }
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
