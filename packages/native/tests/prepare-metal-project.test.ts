import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { prepareMetalProject } from "../src/tooling/prepare-project.ts";
import {
  projectConfiguration,
  projectFixture,
} from "./project-operation-fixture.ts";

test("pre-aborted preparation leaves existing output untouched before any compiler can run", async () => {
  const input = await projectFixture();
  try {
    await mkdir(input.outputPath, { recursive: true });
    const marker = join(input.outputPath, "keep.txt");
    await writeFile(marker, "Existing application output");
    const reason = new Error("Cancelled before preparation");
    await expect(
      prepareMetalProject({
        configurationPath: input.configurationPath,
        workerPath: join(input.directory, "missing-worker"),
        signal: AbortSignal.abort(reason),
      })
    ).rejects.toBe(reason);
    expect(await readdir(input.outputPath)).toEqual(["keep.txt"]);
    expect(await readFile(marker, "utf8")).toBe("Existing application output");
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("an unsafe authored output component fails before worker invocation and preserves source files", async () => {
  const input = await projectFixture();
  try {
    await symlink(
      join(input.directory, "shaders"),
      join(input.directory, "Link")
    );
    await writeFile(
      input.configurationPath,
      JSON.stringify({
        ...projectConfiguration,
        output: "Link/../Generated/AppShaders",
      })
    );
    const shader = await readFile(join(input.directory, "shaders/count.wgsl"));
    await expect(
      prepareMetalProject({
        configurationPath: input.configurationPath,
        workerPath: join(input.directory, "missing-worker"),
      })
    ).rejects.toMatchObject({
      name: "MetalOutputBoundaryError",
      code: "unsafe-output",
    });
    expect(await readFile(join(input.directory, "shaders/count.wgsl"))).toEqual(
      shader
    );
    expect(await readdir(input.directory)).toEqual([
      "Link",
      "shaders",
      "vgpu.native.json",
    ]);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("the pre-compilation boundary protects imported modules outside the configured entry directory", async () => {
  const input = await projectFixture();
  try {
    const shared = join(input.directory, "shared");
    await mkdir(shared);
    const helper = join(shared, "dimensions.wgsl");
    await writeFile(helper, "export const width: u32 = 2u;");
    const entry = join(input.directory, "shaders/count.wgsl");
    await writeFile(
      entry,
      (
        await readFile(entry, "utf8")
      ).replace("./dimensions.wgsl", "../shared/dimensions.wgsl")
    );
    await writeFile(
      input.configurationPath,
      JSON.stringify({ ...projectConfiguration, output: "shared" })
    );
    await expect(
      prepareMetalProject({
        configurationPath: input.configurationPath,
        workerPath: join(input.directory, "missing-worker"),
      })
    ).rejects.toMatchObject({
      name: "MetalOutputBoundaryError",
      code: "unsafe-output",
    });
    expect(await readdir(shared)).toEqual(["dimensions.wgsl"]);
    expect(await readFile(helper, "utf8")).toBe(
      "export const width: u32 = 2u;"
    );
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("capture cancellation returns no partial preparation and starts no worker or output writes", async () => {
  const input = await projectFixture();
  try {
    const controller = new AbortController();
    const reason = new Error("Cancel captured preparation");
    await expect(
      prepareMetalProject({
        configurationPath: input.configurationPath,
        workerPath: join(input.directory, "missing-worker"),
        signal: controller.signal,
        onDependency() {
          controller.abort(reason);
        },
      })
    ).rejects.toBe(reason);
    expect(await readdir(input.directory)).toEqual([
      "shaders",
      "vgpu.native.json",
    ]);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});
