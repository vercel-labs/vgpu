import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkMetalProject } from "../src/tooling/check-project.ts";
import { projectFixture } from "./project-operation-fixture.ts";

test("a pre-aborted check stops before configuration reads or worker invocation", async () => {
  const input = await projectFixture();
  try {
    const reason = new Error("Cancelled before check");
    await expect(
      checkMetalProject({
        configurationPath: join(input.directory, "missing.json"),
        workerPath: join(input.directory, "missing-worker"),
        signal: AbortSignal.abort(reason),
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

test("cancelling source capture prevents checking a partial graph or invoking the worker", async () => {
  const input = await projectFixture();
  try {
    const controller = new AbortController();
    const reason = new Error("Cancelled during capture");
    await expect(
      checkMetalProject({
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

test("invalid configuration preserves its diagnostic before shader or worker failures", async () => {
  const input = await projectFixture();
  try {
    const original = await readFile(input.configurationPath, "utf8");
    await writeFile(input.configurationPath, original.slice(0, -1));
    await rm(join(input.directory, "shaders"), { recursive: true });
    await expect(
      checkMetalProject({
        configurationPath: input.configurationPath,
        workerPath: join(input.directory, "missing-worker"),
      })
    ).rejects.toMatchObject({
      name: "MetalConfigurationError",
      code: "invalid-configuration",
      filePath: input.configurationPath,
    });
    expect(await readdir(input.directory)).toEqual(["vgpu.native.json"]);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});
