import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { homedir } from "node:os";
import { expect, test } from "vitest";
import { validateMetalOutputBoundary } from "../src/tooling/output-boundary.ts";

test("the resolved-path preflight rejects spellings that would erase unchecked components", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-native-output-"))
  );
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    await writeFile(configurationPath, "{}");
    await symlink(directory, join(directory, "Link"));
    await expect(
      validateMetalOutputBoundary({
        configurationPath,
        outputPath: `${directory}/Link/../Output`,
        sourcePaths: [],
      })
    ).rejects.toMatchObject({ code: "unsafe-output" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")(
  "APFS volume aliases cannot hide protected physical ancestors or the home directory",
  async ({ skip }) => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "vgpu-native-output-"))
    );
    try {
      const alias = `/System/Volumes/Data${directory}`;
      let aliasesSameDirectory = false;
      try {
        const [original, aliased] = await Promise.all([
          stat(directory),
          stat(alias),
        ]);
        aliasesSameDirectory =
          original.dev === aliased.dev && original.ino === aliased.ino;
      } catch {
        /* This fixture needs the actual APFS Data-volume alias. */
      }
      if (!aliasesSameDirectory) skip();
      const configurationPath = join(directory, "vgpu.native.json");
      await writeFile(configurationPath, "{}");
      await expect(
        validateMetalOutputBoundary({
          configurationPath: join(alias, "vgpu.native.json"),
          outputPath: directory,
          sourcePaths: [],
        })
      ).rejects.toMatchObject({ code: "unsafe-output" });
      const outputPath = join(directory, "Sources");
      await mkdir(outputPath);
      await writeFile(join(outputPath, "helper.wgsl"), "// retain");
      await expect(
        validateMetalOutputBoundary({
          configurationPath,
          outputPath,
          sourcePaths: [join(alias, "Sources/helper.wgsl")],
        })
      ).rejects.toMatchObject({ code: "unsafe-output" });
      await expect(
        validateMetalOutputBoundary({
          configurationPath,
          outputPath: `/System/Volumes/Data${await realpath(homedir())}`,
          sourcePaths: [],
        })
      ).rejects.toMatchObject({ code: "unsafe-output" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("a missing output beneath a safe parent passes boundary checks without creating files", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu native output "))
  );
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    const source = join(directory, "entry.wgsl");
    await writeFile(configurationPath, "{}");
    await writeFile(source, "// source");
    await expect(
      validateMetalOutputBoundary({
        configurationPath,
        outputPath: join(directory, "Generated/AppShaders"),
        sourcePaths: [source],
      })
    ).resolves.toBeUndefined();
    expect((await readdir(directory)).sort()).toEqual([
      "entry.wgsl",
      "vgpu.native.json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("symlinked and non-directory output components fail without changing their targets", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-native-output-"))
  );
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    await writeFile(configurationPath, "{}");
    const target = join(directory, "Target");
    await mkdir(target);
    await writeFile(join(target, "sentinel"), "untouched");
    const link = join(directory, "Link");
    await symlink(target, link);
    const file = join(directory, "regular-file");
    await writeFile(file, "retain");
    for (const outputPath of [
      link,
      join(link, "missing/Output"),
      file,
      join(file, "Output"),
    ]) {
      await expect(
        validateMetalOutputBoundary({
          configurationPath,
          outputPath,
          sourcePaths: [],
        })
      ).rejects.toMatchObject({ code: "unsafe-output" });
    }
    expect(await readFile(file, "utf8")).toBe("retain");
    expect(await readFile(join(target, "sentinel"), "utf8")).toBe("untouched");
    expect(await readdir(target)).toEqual(["sentinel"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("boundary validation neither claims ownership nor changes an existing nonempty directory", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-native-output-"))
  );
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    await writeFile(configurationPath, "{}");
    const outputPath = join(directory, "Output");
    await mkdir(outputPath);
    await writeFile(join(outputPath, "handwritten.swift"), "// retain");
    await expect(
      validateMetalOutputBoundary({
        configurationPath,
        outputPath,
        sourcePaths: [],
      })
    ).resolves.toBeUndefined();
    expect(await readFile(join(outputPath, "handwritten.swift"), "utf8")).toBe(
      "// retain"
    );
    await expect(
      validateMetalOutputBoundary({
        configurationPath,
        outputPath,
        sourcePaths: [join(directory, "missing.wgsl")],
      })
    ).rejects.toMatchObject({
      code: "unsafe-output",
      message: expect.stringContaining("Input path"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("caller mutation cannot remove protected inputs after boundary validation starts", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-native-output-"))
  );
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    const outputPath = join(directory, "Sources");
    await writeFile(configurationPath, "{}");
    await mkdir(outputPath);
    const source = join(outputPath, "input.wgsl");
    await writeFile(source, "// retain");
    const sourcePaths = [source];
    const pending = validateMetalOutputBoundary({
      configurationPath,
      outputPath,
      sourcePaths,
    });
    sourcePaths.length = 0;
    await expect(pending).rejects.toMatchObject({ code: "unsafe-output" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem case aliases cannot hide a protected input ancestor", async ({
  skip,
}) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-native-output-"))
  );
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    await writeFile(configurationPath, "{}");
    const actualDirectory = join(directory, "ProtectedSources");
    await mkdir(actualDirectory);
    const source = join(actualDirectory, "helper.wgsl");
    await writeFile(source, "// retain");
    const alias = join(directory, "protectedsources");
    try {
      await realpath(alias);
    } catch {
      skip();
    }
    await expect(
      validateMetalOutputBoundary({
        configurationPath,
        outputPath: alias,
        sourcePaths: [source],
      })
    ).rejects.toMatchObject({ code: "unsafe-output" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every resolved source and the physical target of an input alias remain outside output", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-native-output-"))
  );
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    await writeFile(configurationPath, "{}");
    const outputPath = join(directory, "Generated");
    await mkdir(outputPath);
    const actual = join(outputPath, "helper.wgsl");
    const alias = join(directory, "helper.wgsl");
    await writeFile(actual, "// retain this source");
    await symlink(actual, alias);
    for (const sourcePaths of [[actual], [alias]]) {
      await expect(
        validateMetalOutputBoundary({
          configurationPath,
          outputPath,
          sourcePaths,
        })
      ).rejects.toMatchObject({ code: "unsafe-output" });
    }
    const configurationAlias = join(directory, "config-alias.json");
    await symlink(actual, configurationAlias);
    await expect(
      validateMetalOutputBoundary({
        configurationPath: configurationAlias,
        outputPath,
        sourcePaths: [],
      })
    ).rejects.toMatchObject({ code: "unsafe-output" });
    expect(await readdir(outputPath)).toEqual(["helper.wgsl"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("root, home, and configuration ancestors cannot become generated output", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-native-output-"))
  );
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    await writeFile(configurationPath, "{}");
    for (const outputPath of [
      parse(directory).root,
      await realpath(homedir()),
      directory,
      dirname(directory),
    ]) {
      await expect(
        validateMetalOutputBoundary({
          configurationPath,
          outputPath,
          sourcePaths: [],
        })
      ).rejects.toMatchObject({
        name: "MetalOutputBoundaryError",
        code: "unsafe-output",
        outputPath,
      });
    }
    expect(await readdir(directory)).toEqual(["vgpu.native.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
