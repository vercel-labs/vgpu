import { prepareShader } from "@vgpu/wgsl/prepare";
import { describe, expect, test } from "vitest";
import { evaluateShaderModule } from "../../../wgsl/tests/helpers/evaluate-shader-module.ts";
import { shaderSourceModuleWithPackedImports } from "../../../wgsl/src/loader-shared/emit.ts";
import { compute, draw, effect, frame, init, storage, target } from "../../src/node.ts";
import type { ShaderSource } from "../../../wgsl/src/types.ts";

// Large enough for the loader to select packed metadata; the `plain` mode emits the same source literally.
const SOURCE = `
struct LargeParams {
  m0: mat4x4f,
  m1: array<vec4f, 4>,
  m2: vec4f,
  m3: mat4x4f,
  m4: array<vec4f, 4>,
  m5: vec4f,
  m6: mat4x4f,
  m7: array<vec4f, 4>,
}
@group(0) @binding(0) var<uniform> params0: LargeParams;
@group(0) @binding(1) var<uniform> params1: LargeParams;
@group(0) @binding(2) var<uniform> params2: LargeParams;
@group(0) @binding(3) var<uniform> params3: LargeParams;
@group(0) @binding(4) var<storage, read_write> output: array<vec4f>;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(params0.m0[1].y, params1.m1[0].z, params2.m5.w, params3.m6[0].x);
}

@compute @workgroup_size(1) fn cs_main() {
  output[0] = vec4f(params0.m0[0].x, params1.m1[2].y, params2.m2.z, params3.m3[3].w);
  output[1] = vec4f(params0.m4[1].x, params1.m5.y, params2.m6[2].z, params3.m7[3].w);
}
`;
const PATH = "<native-shader-snapshot-reuse>";

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("reused prepared shader snapshots on a real GPU", () => {
  test("loader literal, loader packed, prepareShader() and mutable copies render identically", async () => {
    const artifacts = await fourArtifacts();
    const gpu = await init();
    try {
      const results = [];
      for (const [name, artifact] of Object.entries(artifacts)) results.push({ name, ...(await render(gpu, artifact)) });
      for (const result of results) {
        expect(result.compute, result.name).toEqual([1, 29, 42, 65, 74, 91, 110, 135]);
        expect(result.effect, result.name).toEqual([6, 22, 93, 100]);
        expect(result.drawA, result.name).toEqual([6, 22, 93, 100]);
        expect(result.drawB, result.name).toEqual([1006, 1022, 1093, 1100]);
        expect(result, result.name).toEqual({ ...results[0], name: result.name });
      }
    } finally {
      gpu.dispose();
    }
  });
});

async function fourArtifacts(): Promise<Record<string, ShaderSource>> {
  const packedCode = shaderSourceModuleWithPackedImports(SOURCE, PATH, [], { kind: "standard" });
  const literalCode = shaderSourceModuleWithPackedImports(SOURCE, PATH, [], { kind: "plain" });
  expect(packedCode).toContain("decodePackedMetadata");
  expect(literalCode).not.toContain("decodePackedMetadata");
  const prepared = prepareShader({ wgsl: SOURCE, functionExports: [] }, PATH);
  const artifacts = {
    "loader literal": await evaluateShaderModule(literalCode),
    "loader packed": await evaluateShaderModule(packedCode),
    "prepareShader()": prepared,
    "mutable structuredClone": structuredClone(prepared),
  };
  for (const [name, artifact] of Object.entries(artifacts)) {
    expect(artifact, name).toStrictEqual(prepared);
    expect(Object.isFrozen(artifact.reflection), name).toBe(name !== "mutable structuredClone");
  }
  return artifacts;
}

async function render(gpu: Awaited<ReturnType<typeof init>>, shader: ShaderSource) {
  const set = (base: number) => {
    const value = {
      m0: sequence(base + 1, 16),
      m1: vectors(base + 20),
      m2: sequence(base + 40, 4),
      m3: sequence(base + 50, 16),
      m4: vectors(base + 70),
      m5: sequence(base + 90, 4),
      m6: sequence(base + 100, 16),
      m7: vectors(base + 120),
    };
    return { params0: value, params1: value, params2: value, params3: value };
  };

  const output = storage(gpu, 8 * Float32Array.BYTES_PER_ELEMENT);
  const kernel = compute(gpu, shader, { entry: "cs_main", set: { ...set(0), output } });
  await kernel.compile();
  kernel.dispatch(1);
  await gpu.settled();

  const effectColor = target(gpu, { size: [1, 1], format: "rgba32float", label: "snapshot-reuse-effect" });
  const colorA = target(gpu, { size: [1, 1], format: "rgba32float", label: "snapshot-reuse-a" });
  const colorB = target(gpu, { size: [1, 1], format: "rgba32float", label: "snapshot-reuse-b" });
  const fullscreen = effect(gpu, shader, { entry: { fragment: "fs_main" }, set: set(0) });
  // Two draws from one artifact in one frame, with different uniform values.
  const drawA = draw(gpu, { shader, entry: { vertex: "vs_main", fragment: "fs_main" }, vertices: 3, set: set(0), label: "snapshot-reuse-a" });
  const drawB = draw(gpu, { shader, entry: { vertex: "vs_main", fragment: "fs_main" }, vertices: 3, set: set(1000), label: "snapshot-reuse-b" });
  await Promise.all([fullscreen.compile(effectColor), drawA.compile(colorA), drawB.compile(colorB)]);
  await frame(gpu, (current) => {
    current.pass(effectColor, fullscreen);
    current.pass(colorA, drawA);
    current.pass(colorB, drawB);
  }).done;

  return {
    compute: [...new Float32Array(await output.read())],
    effect: await pixel(effectColor),
    drawA: await pixel(colorA),
    drawB: await pixel(colorB),
  };
}

async function pixel(color: ReturnType<typeof target>): Promise<number[]> {
  return [...(await color.color.readFloats({ mipLevel: 0, region: "all" })).subarray(0, 4)];
}

function sequence(start: number, length: number): number[] {
  return Array.from({ length }, (_, index) => start + index);
}

function vectors(start: number): number[][] {
  return Array.from({ length: 4 }, (_, vector) => sequence(start + vector * 4, 4));
}
