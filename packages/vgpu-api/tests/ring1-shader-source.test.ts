import { expect, test } from "vitest";
import { init, compute, draw, effect } from "../src/mock.ts";
import { drawReflection } from "../src/draw.ts";
import { effectDraw } from "../src/effect.ts";

const FRAGMENT = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, params.value, 1.0);
}
`;

const DRAW = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(params.value); }
`;

const COMPUTE = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@compute @workgroup_size(1) fn main() { _ = params.value; }
`;

test("effect(gpu, ...) accepts string and ShaderSource with identical reflection", async () => {
  const gpu = await init();
  const fromString = effect(gpu, FRAGMENT, { label: "shader" });
  const fromArtifact = effect(gpu, { version: 1, wgsl: FRAGMENT }, { label: "shader" });

  expect(drawReflection(effectDraw(fromArtifact)).bindings.map(({ name, mangledName, group, binding, kind }) => ({ name, mangledName, group, binding, kind })))
    .toEqual(drawReflection(effectDraw(fromString)).bindings.map(({ name, mangledName, group, binding, kind }) => ({ name, mangledName, group, binding, kind })));
  gpu.dispose();
});

test("draw(gpu, ...) accepts ShaderSource and keeps Draw internals string-only", async () => {
  const gpu = await init();
  const drawable = draw(gpu, { shader: { version: 1, wgsl: DRAW }, label: "artifact-draw" });

  expect(drawReflection(drawable).bindings[0]).toMatchObject({ name: "params", group: 0, binding: 0 });
  gpu.dispose();
});

test("compute(gpu, ...) accepts ShaderSource", async () => {
  const gpu = await init();
  const job = compute(gpu, { version: 1, wgsl: COMPUTE }, { label: "artifact-compute" });

  job.set({ params: { value: 1 } });
  gpu.dispose();
});

test("malformed ShaderSource without version throws VGPU-SHADER-SOURCE-INVALID", async () => {
  const gpu = await init();

  expect(() => effect(gpu, { wgsl: FRAGMENT } as never)).toThrowError(
    /VGPU-SHADER-SOURCE-INVALID: expected WGSL or \{ version, wgsl \}, got .* Fix: configure @vgpu\/wgsl loader-vite or loader-webpack\./,
  );
  gpu.dispose();
});

test("unsupported ShaderSource version throws VGPU-SHADER-SOURCE-INVALID", async () => {
  const gpu = await init();

  expect(() => effect(gpu, { version: 2, wgsl: FRAGMENT } as never)).toThrowError(
    "VGPU-SHADER-SOURCE-INVALID: unsupported ShaderSource v2; expected v1. Fix: update vgpu or regenerate it.",
  );
  gpu.dispose();
});
