import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { validateMetalProjectOutputBoundary } from "../src/tooling/project-output-boundary.ts";

test("authored output components cannot hide a symlink behind parent traversal", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-project-boundary-"))
  );
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    await writeFile(configurationPath, "{}");
    await mkdir(join(directory, "Target"));
    await writeFile(join(directory, "Target/sentinel"), "retain");
    await symlink(join(directory, "Target"), join(directory, "Link"));
    await expect(
      validateMetalProjectOutputBoundary({
        configurationPath,
        output: "Link/../Generated",
        sourcePaths: [],
      })
    ).rejects.toMatchObject({ code: "unsafe-output" });
    expect(await readFile(join(directory, "Target/sentinel"), "utf8")).toBe(
      "retain"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing prefix does not hide a later symlink or regular file after parent traversal", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-project-boundary-"))
  );
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    await writeFile(configurationPath, "{}");
    await symlink(join(directory, "absent"), join(directory, "Link"));
    await writeFile(join(directory, "File"), "retain");
    for (const output of [
      "Missing/../Link/../Generated",
      "Missing/deeper/../../File/../Generated",
    ]) {
      await expect(
        validateMetalProjectOutputBoundary({
          configurationPath,
          output,
          sourcePaths: [],
        })
      ).rejects.toMatchObject({ code: "unsafe-output" });
    }
    expect(await readFile(join(directory, "File"), "utf8")).toBe("retain");
    expect((await readdir(directory)).sort()).toEqual([
      "File",
      "Link",
      "vgpu.native.json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe relative parent traversal and missing directories resolve without writes", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu project boundary "))
  );
  try {
    await mkdir(join(directory, "project"));
    const configurationPath = join(directory, "project/vgpu.native.json");
    await writeFile(configurationPath, "{}");
    const source = join(directory, "project/input.wgsl");
    await writeFile(source, "// retain");
    for (const output of [
      "../Generated/AppShaders",
      "../Missing/../Generated/./AppShaders",
    ]) {
      await expect(
        validateMetalProjectOutputBoundary({
          configurationPath,
          output,
          sourcePaths: [source],
        })
      ).resolves.toBe(join(directory, "Generated/AppShaders"));
    }
    // Spaces and non-BMP characters are valid filesystem names, not invalid UTF-8.
    await expect(
      validateMetalProjectOutputBoundary({
        configurationPath,
        output: " ../🎨",
        sourcePaths: [source],
      })
    ).resolves.toBe(join(directory, "project/ ../🎨"));
    expect(await readdir(directory)).toEqual(["project"]);
    expect((await readdir(join(directory, "project"))).sort()).toEqual([
      "input.wgsl",
      "vgpu.native.json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all captured imports remain protected even if the caller mutates options during inspection", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-project-boundary-"))
  );
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    await writeFile(configurationPath, "{}");
    await mkdir(join(directory, "Imports"));
    const imported = join(directory, "Imports/helper.wgsl");
    await writeFile(imported, "// retain");
    const sourcePaths = [imported];
    const input = { configurationPath, output: "Imports", sourcePaths };
    const pending = validateMetalProjectOutputBoundary(input);
    sourcePaths.length = 0;
    input.output = "Safe";
    await expect(pending).rejects.toMatchObject({ code: "unsafe-output" });
    expect(await readFile(imported, "utf8")).toBe("// retain");
    for (const output of [".", "Imports/..", "../"]) {
      await expect(
        validateMetalProjectOutputBoundary({
          configurationPath,
          output,
          sourcePaths: [],
        })
      ).rejects.toMatchObject({ code: "unsafe-output" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the project boundary requires the original relative configuration spelling", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-project-boundary-"))
  );
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    await writeFile(configurationPath, "{}");
    for (const output of [
      join(directory, "Generated"),
      "Generated\\AppShaders",
      "",
      "https:Generated",
      "Generated\u0000Tail",
      "Generated\ud800",
    ]) {
      await expect(
        validateMetalProjectOutputBoundary({
          configurationPath,
          output,
          sourcePaths: [],
        })
      ).rejects.toMatchObject({ code: "unsafe-output" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
