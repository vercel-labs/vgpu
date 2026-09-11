import { execFile } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { readMetalConfiguration } from "../src/tooling/configuration.ts";

const guide = await readFile(
  new URL(
    "../../../docs/topics/native/macos/metal/tooling/native-macos-metal-tooling-configuration.docs.md",
    import.meta.url
  ),
  "utf8"
);
const example = JSON.parse(
  [...guide.matchAll(/```json\n([\s\S]*?)\n```/gu)][0][1]
);

test("the documented native configuration resolves source and output paths beside its own file without writing output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vgpu native config "));
  try {
    const file = join(directory, "vgpu.native.json");
    await writeFile(file, JSON.stringify(example));
    const loaded = await readMetalConfiguration(file);
    expect(loaded.filePath).toBe(file);
    expect(loaded.configuration).toEqual(example);
    expect(loaded.outputPath).toBe(join(directory, "Generated/AppShaders"));
    expect(loaded.sourcePaths).toEqual([
      join(directory, "shaders/gradient.wgsl"),
      join(directory, "shaders/count.wgsl"),
    ]);
    expect(await readdir(directory)).toEqual(["vgpu.native.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown configuration fields are rejected at every configured object boundary", async () => {
  for (const value of [
    { ...example, worker: "/some/compiler" },
    { ...example, programs: [{ ...example.programs[0], kind: "effect" }] },
    {
      ...example,
      programs: [
        {
          ...example.programs[0],
          entryPoints: { ...example.programs[0].entryPoints, typo: "main" },
        },
      ],
    },
  ]) {
    await expect(loadValue(value)).rejects.toMatchObject({
      name: "MetalConfigurationError",
      code: "invalid-configuration",
    });
  }
});

test("generated Swift names must be safe and unambiguous before shader resolution", async () => {
  for (const value of [
    { ...example, moduleName: "Metal" },
    { ...example, moduleName: "bad-name" },
    { ...example, programs: [{ ...example.programs[0], name: "String" }] },
    { ...example, programs: [{ ...example.programs[0], name: "AppShaders" }] },
    {
      ...example,
      programs: [
        example.programs[0],
        { ...example.programs[1], name: "gradient" },
      ],
    },
  ]) {
    await expect(loadValue(value)).rejects.toMatchObject({
      name: "MetalConfigurationError",
      code: "invalid-configuration",
    });
  }
});

test("the initial configuration version and field values fail closed", async () => {
  for (const value of [
    { ...example, schemaVersion: 2 },
    { ...example, programs: [] },
    {
      ...example,
      programs: [{ ...example.programs[0], entryPoints: { compute: 1 } }],
    },
    {
      ...example,
      programs: [
        { ...example.programs[0], entryPoints: { vertex: "vertex_main" } },
      ],
    },
    {
      ...example,
      programs: [
        {
          ...example.programs[0],
          entryPoints: {
            ...example.programs[0].entryPoints,
            compute: "count_main",
          },
        },
      ],
    },
    { ...example, output: "" },
    { ...example, output: "/absolute/output" },
    { ...example, output: "C:\\output" },
    { ...example, output: "Generated\u0000/AppShaders" },
    { ...example, programs: [{ ...example.programs[0], source: false }] },
    {
      ...example,
      programs: [
        {
          ...example.programs[0],
          source: "https://example.invalid/shader.wgsl",
        },
      ],
    },
  ]) {
    await expect(loadValue(value)).rejects.toMatchObject({
      name: "MetalConfigurationError",
      code: "invalid-configuration",
    });
  }
});

test("malformed JSON and invalid UTF-8 have configuration diagnostics with their file path", async () => {
  const encoded = JSON.stringify({ ...example, output: "INVALID_BYTE" });
  const split = encoded.indexOf("INVALID_BYTE");
  for (const bytes of [
    Buffer.from("{broken json"),
    Buffer.concat([
      Buffer.from(encoded.slice(0, split)),
      Buffer.from([0xff]),
      Buffer.from(encoded.slice(split + "INVALID_BYTE".length)),
    ]),
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "vgpu-native-config-"));
    try {
      const file = join(directory, "vgpu.native.json");
      await writeFile(file, bytes);
      await expect(readMetalConfiguration(file)).rejects.toMatchObject({
        name: "MetalConfigurationError",
        code: "invalid-configuration",
        filePath: file,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("unavailable and non-file configuration paths have read diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vgpu-native-config-"));
  try {
    for (const file of [join(directory, "missing.json"), directory]) {
      await expect(readMetalConfiguration(file)).rejects.toMatchObject({
        name: "MetalConfigurationError",
        code: "configuration-unavailable",
        filePath: file,
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration reads reject files beyond the documented one-MiB limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vgpu-native-config-"));
  try {
    const file = join(directory, "vgpu.native.json");
    const json = JSON.stringify(example);
    await writeFile(file, json.padEnd(1024 * 1024 + 1, " "));
    await expect(readMetalConfiguration(file)).rejects.toMatchObject({
      name: "MetalConfigurationError",
      code: "invalid-configuration",
      message: expect.stringContaining("one MiB"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration reads accept valid JSON at exactly the one-MiB limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vgpu-native-config-"));
  try {
    const file = join(directory, "vgpu.native.json");
    const bytes = Buffer.from(JSON.stringify(example).padEnd(1024 * 1024, " "));
    expect(bytes.length).toBe(1024 * 1024);
    await writeFile(file, bytes);
    const loaded = await readMetalConfiguration(file);
    expect(loaded.configuration).toEqual(example);
    expect(loaded.filePath).toBe(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "a real FIFO configuration rejects promptly without waiting for a writer",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "vgpu-native-config-"));
    let rescue: ReturnType<typeof setTimeout> | undefined;
    try {
      const file = join(directory, "vgpu.native.json");
      await promisify(execFile)("mkfifo", [file], { timeout: 1000 });
      let neededWriter = false;
      // If opening regresses to blocking mode, release the reader so a failing
      // test does not leave a pending filesystem request in the test worker.
      rescue = setTimeout(() => {
        neededWriter = true;
        const descriptor = openSync(
          file,
          constants.O_RDWR | constants.O_NONBLOCK
        );
        closeSync(descriptor);
      }, 1000);
      await expect(readMetalConfiguration(file)).rejects.toMatchObject({
        name: "MetalConfigurationError",
        code: "configuration-unavailable",
        filePath: file,
        message: expect.stringContaining("regular file"),
      });
      expect(neededWriter).toBe(false);
    } finally {
      clearTimeout(rescue);
      await rm(directory, { recursive: true, force: true });
    }
  }
);

async function loadValue(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "vgpu-native-config-"));
  try {
    const file = join(directory, "vgpu.native.json");
    await writeFile(file, JSON.stringify(value));
    return await readMetalConfiguration(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
