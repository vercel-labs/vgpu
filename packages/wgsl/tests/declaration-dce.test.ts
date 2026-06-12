import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

const helperPattern = (name: string) => new RegExp(`fn _vgsl_[0-9a-f]{8}__${name}\\b`);
const constPattern = (name: string) => new RegExp(`const _vgsl_[0-9a-f]{8}__${name}\\b`);
const structPattern = (name: string) => new RegExp(`struct _vgsl_[0-9a-f]{8}__${name}\\b`);

test("unused imported @vgpu/wgsl-std declarations are removed", async () => {
  const colorStd = readFileSync(join(process.cwd(), "packages/wgsl-std/src/color/index.wgsl"), "utf8");
  const resolved = await resolveShader({
    entry: "/main.wgsl",
    packageMap: { "@vgpu/wgsl-std/color": "/std/color.wgsl" },
    validate: false,
    modules: {
      "/main.wgsl": `import { srgbToLinear3 } from "@vgpu/wgsl-std/color";
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(srgbToLinear3(vec3f(0.5)), 1.0); }`,
      "/std/color.wgsl": colorStd,
    },
  });

  expect(resolved.wgsl).toMatch(helperPattern("srgbToLinear3"));
  expect(resolved.wgsl).toMatch(helperPattern("srgbToLinear"));
  expect(resolved.wgsl).not.toMatch(helperPattern("linearToSrgb3"));
  expect(resolved.wgsl).not.toMatch(helperPattern("luminance"));
});

test("unused imported std-style declarations are removed", async () => {
  const resolved = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    modules: {
      "/main.wgsl": `import { usedColor } from "./std.wgsl";
@fragment fn fs_main() -> @location(0) vec4f { return usedColor(); }`,
      "/std.wgsl": `export fn usedColor() -> vec4f { return vec4f(1.0); }
export fn unusedColor() -> vec4f { return vec4f(0.0); }
export const unusedConstant: f32 = 42.0;`,
    },
  });

  expect(resolved.wgsl).toMatch(helperPattern("usedColor"));
  expect(resolved.wgsl).not.toMatch(helperPattern("unusedColor"));
  expect(resolved.wgsl).not.toMatch(constPattern("unusedConstant"));
});

test("transitive helper dependencies are retained", async () => {
  const resolved = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    modules: {
      "/main.wgsl": `import { exposed } from "./lib.wgsl";
@fragment fn fs_main() -> @location(0) vec4f { return exposed(); }`,
      "/lib.wgsl": `export fn exposed() -> vec4f { return helper(); }
fn helper() -> vec4f { return vec4f(channel()); }
fn channel() -> f32 { return 1.0; }
fn unusedHelper() -> vec4f { return vec4f(0.0); }`,
    },
  });

  expect(resolved.wgsl).toMatch(helperPattern("exposed"));
  expect(resolved.wgsl).toMatch(helperPattern("helper"));
  expect(resolved.wgsl).toMatch(helperPattern("channel"));
  expect(resolved.wgsl).not.toMatch(helperPattern("unusedHelper"));
});

test("structs aliases and constants referenced by reachable declarations are retained", async () => {
  const resolved = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    modules: {
      "/main.wgsl": `import { makePayload } from "./types.wgsl";
@compute @workgroup_size(1) fn main() { let payload = makePayload(); }`,
      "/types.wgsl": `struct Payload { value: f32 }
alias PayloadAlias = Payload;
const scale: f32 = 2.0;
export fn makePayload() -> PayloadAlias { return PayloadAlias(scale); }
struct UnusedPayload { value: f32 }
alias UnusedAlias = UnusedPayload;`,
    },
  });

  expect(resolved.wgsl).toMatch(structPattern("Payload"));
  expect(resolved.wgsl).toMatch(/alias _vgsl_[0-9a-f]{8}__PayloadAlias\b/);
  expect(resolved.wgsl).toMatch(constPattern("scale"));
  expect(resolved.wgsl).not.toMatch(structPattern("UnusedPayload"));
  expect(resolved.wgsl).not.toMatch(/UnusedAlias/);
});

test("bindings overrides and entry points are never removed", async () => {
  const resolved = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    modules: {
      "/main.wgsl": `import { buffer } from "./resource.wgsl";
override WorkgroupSize: u32 = 1u;
@compute @workgroup_size(WorkgroupSize) fn main() { buffer.value = WorkgroupSize; }`,
      "/resource.wgsl": `struct Buffer { value: u32 }
@group(0) @binding(0) export var<storage, read_write> buffer: Buffer;
fn unusedHelper() {}`,
    },
  });

  expect(resolved.wgsl).toContain("fn main(");
  expect(resolved.wgsl).toContain("@group(0) @binding(0)");
  expect(resolved.wgsl).toMatch(/var<storage, read_write> _vgsl_[0-9a-f]{8}__buffer/);
  expect(resolved.wgsl).toContain("override WorkgroupSize");
  expect(resolved.wgsl).toMatch(structPattern("Buffer"));
  expect(resolved.wgsl).not.toMatch(helperPattern("unusedHelper"));
});

test("declaration DCE runs before minify and keeps used imports", async () => {
  const resolved = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    minify: true,
    modules: {
      "/main.wgsl": `import { usedColor } from "./std.wgsl";
@fragment fn fs_main() -> @location(0) vec4f { return usedColor(); }`,
      "/std.wgsl": `export fn usedColor() -> vec4f { return vec4f(1.0); }
export fn unusedColor() -> vec4f { return vec4f(0.0); }`,
    },
  });

  expect(resolved.wgsl).toMatch(/fn [a-z]+\(\)-> vec4f\{return vec4f\(1.0\);}/);
  expect(resolved.wgsl).not.toContain("unusedColor");
  expect(resolved.wgsl.length).toBeLessThan(120);
});

test("declaration DCE preserves deterministic output and cache keys", async () => {
  const opts = {
    entry: "/main.wgsl",
    validate: false,
    modules: {
      "/main.wgsl": `import { used } from "./std.wgsl";
@compute @workgroup_size(1) fn main() { used(); }`,
      "/std.wgsl": `export fn used() {}
export fn unusedA() {}
export fn unusedB() { unusedA(); }`,
    },
  };

  const first = await resolveShader(opts);
  const second = await resolveShader(opts);
  expect(first.wgsl).toBe(second.wgsl);
  expect(first.cacheKey).toEqual(second.cacheKey);
  expect(first.wgsl).not.toMatch(helperPattern("unusedA"));
  expect(first.wgsl).not.toMatch(helperPattern("unusedB"));
});
