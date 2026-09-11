import {
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { checkMetalProject } from "../src/tooling/check-project.ts";
import { projectFixture } from "./project-operation-fixture.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("check validates the documented configured render and compute programs with no output or Apple toolchain", async () => {
  const input = await projectFixture();
  const previous = process.env.DEVELOPER_DIR;
  try {
    process.env.DEVELOPER_DIR = join(
      input.directory,
      "missing-apple-toolchain"
    );
    const checked = await checkMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    expect(checked).toEqual({
      configurationPath: input.configurationPath,
      moduleName: "AppShaders",
      programs: [
        { name: "Count", stages: ["compute"] },
        { name: "Gradient", stages: ["vertex", "fragment"] },
      ],
      inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(Object.isFrozen(checked)).toBe(true);
    expect(Object.isFrozen(checked.programs)).toBe(true);
    expect(
      checked.programs.every(
        (program) => Object.isFrozen(program) && Object.isFrozen(program.stages)
      )
    ).toBe(true);
    expect(await readdir(input.directory)).toEqual([
      "shaders",
      "vgpu.native.json",
    ]);
  } finally {
    if (previous === undefined) delete process.env.DEVELOPER_DIR;
    else process.env.DEVELOPER_DIR = previous;
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("check owns caller options and validates the captured source after its entry and configuration files change", async () => {
  const input = await projectFixture();
  try {
    const dependencies: string[] = [];
    const options = {
      configurationPath: input.configurationPath,
      workerPath,
      signal: new AbortController().signal,
      onDependency(path: string) {
        dependencies.push(path);
        unlinkSync(join(input.directory, "shaders/count.wgsl"));
        writeFileSync(
          input.configurationPath,
          "{changed after configuration capture"
        );
      },
    };
    const pending = checkMetalProject(options);
    options.configurationPath = join(input.directory, "missing.json");
    options.workerPath = join(input.directory, "missing-worker");
    options.signal = AbortSignal.abort();
    options.onDependency = () => {
      throw new Error("Replaced callback must not run");
    };
    const checked = await pending;
    expect(checked.moduleName).toBe("AppShaders");
    expect(checked.programs).toEqual([
      { name: "Count", stages: ["compute"] },
      { name: "Gradient", stages: ["vertex", "fragment"] },
    ]);
    expect(dependencies).toEqual([
      join(input.directory, "shaders/dimensions.wgsl"),
    ]);
    expect(await readdir(input.directory)).toEqual([
      "shaders",
      "vgpu.native.json",
    ]);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("check does not apply publication or verification checks to an unusable output path", async () => {
  const input = await projectFixture();
  try {
    await mkdir(dirname(input.outputPath), { recursive: true });
    const target = join(input.directory, "unavailable-output-target");
    await symlink(target, input.outputPath);
    expect(
      (
        await checkMetalProject({
          configurationPath: input.configurationPath,
          workerPath,
        })
      ).moduleName
    ).toBe("AppShaders");
    expect(await readlink(input.outputPath)).toBe(target);
    expect(await readdir(dirname(input.outputPath))).toEqual(["AppShaders"]);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("unsupported resources keep their compiler validation diagnostic and leave existing output alone", async () => {
  const input = await projectFixture();
  try {
    const source = join(input.directory, "shaders/gradient.wgsl");
    await writeFile(
      source,
      (
        await readFile(source, "utf8")
      ).replace("var<uniform>", "var<storage, read>")
    );
    await mkdir(input.outputPath, { recursive: true });
    const marker = join(input.outputPath, "application-owned.txt");
    await writeFile(marker, "Keep this output");
    await expect(
      checkMetalProject({
        configurationPath: input.configurationPath,
        workerPath,
      })
    ).rejects.toMatchObject({
      name: "MetalCompileError",
      stage: "validation",
      message: expect.stringContaining("resource bindings"),
    });
    expect(await readdir(input.outputPath)).toEqual(["application-owned.txt"]);
    expect(await readFile(marker, "utf8")).toBe("Keep this output");
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});
