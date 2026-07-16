import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

const ENTRY_WITH_BINDING = `
import { NoiseConfig, sampleNoise } from "./noise.wgsl";
@group(0) @binding(0) var<uniform> cfg: NoiseConfig;
@fragment fn main() -> @location(0) vec4f {
  return vec4f(sampleNoise(cfg), 0.0, 0.0, 1.0);
}
`;

const PURE_MODULE = `
export struct NoiseConfig { seed: f32 }
export fn sampleNoise(cfg: NoiseConfig) -> f32 { return cfg.seed; }
`;

test("resolver rejects @group/@binding declarations in imported modules", async () => {
  await expect(resolveShader({
    entry: "/entry.wgsl",
    validate: false,
    modules: {
      "/entry.wgsl": "import { seed } from './noise.wgsl'; @fragment fn main() -> @location(0) vec4f { return vec4f(seed.x); }",
      "/noise.wgsl": "struct Seed { x: f32 }\n@group(0) @binding(0) var<uniform> seed: Seed;",
    },
  })).rejects.toMatchObject({
    code: "VGPU-RESOLVE-MODULE-BINDING",
    message: "VGPU-RESOLVE-MODULE-BINDING: /noise.wgsl declara '@group(0) @binding(0) seed'.\n" +
      "Los módulos no pueden declarar bindings — exportá el struct y declaralo en tu entry:\n" +
      "  export struct NoiseConfig { seed: u32 }\n" +
      "  // en tu entry: @group(0) @binding(0) var<uniform> cfg: NoiseConfig;",
    line: 2,
    column: 1,
  });
});

test("entry bindings remain legal and source-facing", async () => {
  const resolved = await resolveShader({
    entry: "/entry.wgsl",
    validate: false,
    modules: { "/entry.wgsl": ENTRY_WITH_BINDING, "/noise.wgsl": PURE_MODULE },
  });

  expect(resolved.reflection.bindings).toEqual([
    expect.objectContaining({ name: "cfg", mangledName: "cfg", group: 0, binding: 0 }),
  ]);
});

test("pure imported modules that export structs and functions resolve", async () => {
  const resolved = await resolveShader({
    entry: "/entry.wgsl",
    validate: false,
    modules: { "/entry.wgsl": ENTRY_WITH_BINDING, "/noise.wgsl": PURE_MODULE },
  });

  expect(resolved.wgsl).toContain("struct _vgsl_");
  expect(resolved.wgsl).toContain("fn _vgsl_");
});

test("function-local @group/@binding-like tokens are not treated as module bindings", async () => {
  const resolved = await resolveShader({
    entry: "/entry.wgsl",
    validate: false,
    modules: {
      "/entry.wgsl": "import { helper } from './helper.wgsl'; fn main(){ helper(); }",
      "/helper.wgsl": "export fn helper(){ @group(0) @binding(0) var impossible: u32; }",
    },
  });

  expect(resolved.wgsl).toContain("fn _vgsl_");
});
