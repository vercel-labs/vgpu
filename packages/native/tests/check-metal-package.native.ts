import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  checkMetalPackage,
  compileMetalPackage,
  type CompileMetalPackageInput,
} from "../src/compile.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

const input: CompileMetalPackageInput = {
  moduleName: "AppShaders",
  programs: [
    {
      name: "Triangle",
      source: "shaders/main.wgsl",
      entryPoints: { vertex: "vertex_main", fragment: "fragment_main" },
    },
  ],
  modules: {
    "shaders/shared.wgsl":
      "export fn shared(v: vec2f) -> vec2f { return v * 0.5; }",
    "shaders/main.wgsl": `import { shared } from "./shared.wgsl";
@vertex fn vertex_main(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(shared(position), 0.0, 1.0); }
@fragment fn fragment_main(@builtin(position) position: vec4f) -> @location(0) vec4f { return vec4f(shared(position.xy), 0.0, 1.0); }`,
  },
  workerPath,
};

test("check translates imported WGSL with the pinned worker without an Apple toolchain or output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vgpu-native-check-"));
  const environment = {
    DEVELOPER_DIR: process.env.DEVELOPER_DIR,
    TMPDIR: process.env.TMPDIR,
  };
  try {
    // An unavailable developer directory makes accidental Apple compilation
    // fail. The pinned worker may use temporary files, but leaves no output.
    process.env.DEVELOPER_DIR = join(directory, "no-apple-toolchain");
    process.env.TMPDIR = directory;
    await expect(checkMetalPackage(input)).resolves.toEqual({
      moduleName: "AppShaders",
      programs: [{ name: "Triangle", stages: ["vertex", "fragment"] }],
    });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("check rejects generated Swift type collisions before Apple compilation", async () => {
  await expect(
    checkMetalPackage({
      ...input,
      modules: {
        "shaders/main.wgsl": `struct Triangle { color: vec4f }
@group(0) @binding(0) var<uniform> params: Triangle;
@vertex fn vertex_main(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0.0, 1.0); }
@fragment fn fragment_main() -> @location(0) vec4f { return params.color; }`,
      },
    })
  ).rejects.toMatchObject({
    stage: "validation",
    message: expect.stringContaining("containing declaration"),
  });
});

test("check and build reject the same unsupported render storage profile", async () => {
  const unsupported = {
    ...input,
    modules: {
      "shaders/main.wgsl": `struct Params { color: vec4f }
@group(0) @binding(0) var<storage, read> params: Params;
@vertex fn vertex_main(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0.0, 1.0); }
@fragment fn fragment_main() -> @location(0) vec4f { return params.color; }`,
    },
  };
  for (const operation of [checkMetalPackage, compileMetalPackage]) {
    await expect(operation(unsupported)).rejects.toMatchObject({
      stage: "validation",
      message: expect.stringContaining("resource bindings"),
    });
  }
});

test("check summarizes render and compute programs in deterministic order", async () => {
  const mixed = {
    ...input,
    programs: [
      ...input.programs,
      {
        name: "Count",
        source: "shaders/count.wgsl",
        entryPoints: { compute: "count_main" },
      },
    ],
    modules: {
      ...input.modules,
      "shaders/count.wgsl": `@group(0) @binding(0) var<storage, read_write> output: array<u32, 2>;
@compute @workgroup_size(1) fn count_main() { output[0] = 7u; output[1] = 9u; }`,
    },
  };
  const expected = {
    moduleName: "AppShaders",
    programs: [
      { name: "Count", stages: ["compute"] },
      { name: "Triangle", stages: ["vertex", "fragment"] },
    ],
  };
  expect(await checkMetalPackage(mixed)).toEqual(expected);
  expect(
    await checkMetalPackage({
      ...mixed,
      programs: mixed.programs.slice().reverse(),
      modules: Object.fromEntries(Object.entries(mixed.modules).reverse()),
    })
  ).toEqual(expected);
});

test("check snapshots the caller's own selected stages before asynchronous work", async () => {
  const mutable = {
    ...input,
    programs: [
      {
        ...input.programs[0],
        entryPoints: Object.assign(Object.create({ compute: "not_selected" }), {
          vertex: "vertex_main",
          fragment: "fragment_main",
        }),
      },
    ],
    modules: { ...input.modules },
  };
  const pending = checkMetalPackage(mutable);
  mutable.moduleName = "ChangedShaders";
  mutable.workerPath = "/missing/worker";
  mutable.programs[0].name = "ChangedProgram";
  mutable.programs[0].entryPoints.fragment = "not_an_entry";
  mutable.modules["shaders/shared.wgsl"] = "invalid WGSL";
  expect(await pending).toEqual({
    moduleName: "AppShaders",
    programs: [{ name: "Triangle", stages: ["vertex", "fragment"] }],
  });
});
