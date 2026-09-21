import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { GeneratedMetalPackage } from "../src/index.ts";

const execFileAsync = promisify(execFile);

async function command(
  executable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<string> {
  const result = await execFileAsync(executable, args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  return result.stdout;
}

export async function compileLibrary(sourceText: string): Promise<Uint8Array> {
  const directory = mkdtempSync(join(tmpdir(), "vgpu-metal-compiler-test-"));
  try {
    const source = join(directory, "fixture.metal");
    const air = join(directory, "fixture.air");
    const library = join(directory, "fixture.metallib");
    writeFileSync(source, sourceText);
    await command(
      "xcrun",
      [
        "-sdk",
        "macosx",
        "metal",
        "-std=macos-metal2.4",
        "-target",
        "air64-apple-macos14.0",
        "-c",
        source,
        "-o",
        air,
      ],
      { timeout: 45_000 }
    );
    await command("xcrun", ["-sdk", "macosx", "metallib", air, "-o", library], {
      timeout: 45_000,
    });
    return readFileSync(library);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function runConsumer(
  packages: Record<string, GeneratedMetalPackage>,
  source: string,
  beforeRun?: (binaryDirectory: string) => void,
  options: { isolatedDistribution?: boolean } = {}
): Promise<string> {
  const scratch = realpathSync(
    mkdtempSync(join(tmpdir(), "vgpu-metal-consumer-test-"))
  );
  const directory = join(scratch, "original");
  mkdirSync(directory);
  try {
    for (const [name, generated] of Object.entries(packages)) {
      for (const [relative, bytes] of Object.entries(generated.files)) {
        const destination = join(directory, name, relative);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
      }
    }
    const consumer = join(directory, "Consumer");
    mkdirSync(join(consumer, "Sources/Consumer"), { recursive: true });
    const names = Object.keys(packages);
    writeFileSync(
      join(consumer, "Package.swift"),
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "Consumer",
  platforms: [.macOS(.v14)],
  dependencies: [${names
    .map((name) => `.package(path: "../${name}")`)
    .join(", ")}],
  targets: [.executableTarget(name: "Consumer", dependencies: [${names
    .map((name) => `.product(name: "${name}", package: "${name}")`)
    .join(", ")}])]
)
`
    );
    writeFileSync(join(consumer, "Sources/Consumer/main.swift"), source);
    try {
      const poisonLog = join(scratch, "poison-tools-invoked");
      const environment = { ...process.env };
      if (options.isolatedDistribution) {
        // These guards intercept PATH lookup only. They do not prove a clean
        // machine, block absolute tool paths, or intercept xcrun's SDK lookup.
        const poison = join(scratch, "poison-tools");
        mkdirSync(poison);
        for (const tool of [
          "node",
          "npx",
          "pnpm",
          "vgpu-tint-compiler",
          "vgpu-tint-worker",
          "vgpu-tint-worker-arm64",
          "vgpu-tint-worker-x86_64",
          "vgpu-tint-worker-universal",
          "tint",
          "metal",
          "metallib",
        ]) {
          writeFileSync(
            join(poison, tool),
            '#!/bin/sh\nprintf "%s\\n" "$0" >> "$VGPU_NATIVE_POISON_LOG"\nexit 86\n',
            { mode: 0o755 }
          );
        }
        environment.PATH = `${poison}:${process.env.PATH ?? ""}`;
        environment.VGPU_NATIVE_POISON_LOG = poisonLog;
        for (const name of names) {
          const manifest = JSON.parse(
            await command(
              "swift",
              [
                "package",
                "--package-path",
                join(directory, name),
                "dump-package",
              ],
              {
                env: environment,
                timeout: 15_000,
              }
            )
          );
          assert.deepEqual(manifest.dependencies, []);
          assert.equal(manifest.products.length, 1);
          assert.equal(manifest.targets.length, 1);
          assert.deepEqual(manifest.targets[0].dependencies, []);
          assert.equal(manifest.targets[0].resources.length, 1);
        }
      }
      await command(
        "swift",
        ["build", "--package-path", consumer, "--product", "Consumer"],
        {
          env: environment,
          timeout: 60_000,
        }
      );
      let binaryDirectory = (
        await command(
          "swift",
          ["build", "--package-path", consumer, "--show-bin-path"],
          {
            env: environment,
            timeout: 15_000,
          }
        )
      ).trim();
      if (options.isolatedDistribution) {
        const relativeBinaryDirectory = relative(directory, binaryDirectory);
        assert(!relativeBinaryDirectory.startsWith(".."));
        const relocated = join(scratch, "relocated");
        renameSync(directory, relocated);
        assert.equal(existsSync(directory), false);
        binaryDirectory = join(relocated, relativeBinaryDirectory);
      }
      beforeRun?.(binaryDirectory);
      const output = (
        await command(join(binaryDirectory, "Consumer"), [], {
          env: environment,
          timeout: 15_000,
        })
      ).trim();
      if (options.isolatedDistribution)
        assert.equal(
          existsSync(poisonLog),
          false,
          "a generation tool was invoked after package generation"
        );
      return output;
    } catch (error) {
      const result = error as {
        stderr?: string | Buffer;
        stdout?: string | Buffer;
      };
      throw new Error(
        `Native consumer failed:\n${result.stdout ?? ""}\n${
          result.stderr ?? ""
        }`,
        { cause: error }
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
