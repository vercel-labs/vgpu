import { prepareShader } from "@vgpu/wgsl/prepare";
import { describe, expect, test } from "vitest";
import { compute, effect, frame, init, storage, target } from "../../src/node.ts";

const PREPARED_F32 = `
struct Inner {
  direction: vec3f,
  weight: f32,
}
struct Params {
  head: f32,
  @align(32) @size(32) padded: f32,
  inner: Inner,
  basis: mat3x3f,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;

@compute @workgroup_size(1) fn cs_main() {
  output[0] = vec4f(params.head, params.padded, params.inner.direction.y, params.inner.weight);
  output[1] = vec4f(params.basis[0].x, params.basis[1].y, params.basis[2].z, params.basis[2].x);
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(params.inner.direction.x, params.padded, params.basis[1].z, params.head);
}
`;

const PREPARED_F16 = `
enable f16;
struct HalfInner {
  direction: vec3h,
  weight: f16,
}
struct HalfParams {
  @align(16) inner: HalfInner,
  @align(32) @size(32) scale: f16,
  basis: mat2x2h,
}
@group(0) @binding(0) var<uniform> params: HalfParams;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;

@compute @workgroup_size(1) fn cs_main() {
  output[0] = vec4f(f32(params.inner.direction.x), f32(params.inner.direction.z), f32(params.inner.weight), f32(params.scale));
  output[1] = vec4f(f32(params.basis[0].x), f32(params.basis[0].y), f32(params.basis[1].x), f32(params.basis[1].y));
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(f32(params.basis[0].x), f32(params.basis[1].y), f32(params.scale), f32(params.inner.weight));
}
`;

const PREPARED_F32_ARTIFACT = prepareShader(PREPARED_F32, "<native-prepared-layout:f32>");
const PREPARED_F16_ARTIFACT = prepareShader(PREPARED_F16, "<native-prepared-layout:f16>");

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("prepared shader layout packing on a real GPU", () => {
  test("compute and effect preserve nested, explicit and matrix layout bytes", async () => {
    const gpu = await init();
    try {
      await expectPreparedPacking(
        gpu,
        PREPARED_F32_ARTIFACT,
        {
          head: 1,
          padded: 2,
          inner: { direction: [3, 4, 5], weight: 6 },
          basis: [7, 8, 9, 10, 11, 12, 13, 14, 15],
        },
        [1, 2, 4, 6, 7, 11, 15, 13],
        [3, 2, 12, 1],
      );
    } finally {
      gpu.dispose();
    }
  });

  test("shader-f16 preserves the same prepared compute/effect boundary when supported", async ({ skip }) => {
    let gpu: Awaited<ReturnType<typeof init>>;
    try {
      gpu = await init({ requiredFeatures: ["shader-f16"] });
    } catch (error) {
      if (error instanceof Error && (error as Error & { readonly code?: string }).code === "VGPU-FEATURE-UNSUPPORTED") {
        skip(`shader-f16 unsupported by the native adapter: ${error.message}`);
      }
      throw error;
    }

    try {
      await expectPreparedPacking(
        gpu,
        PREPARED_F16_ARTIFACT,
        {
          inner: { direction: [1.5, 2.5, 3.5], weight: 4.5 },
          scale: 5.5,
          basis: [6.5, 7.5, 8.5, 9.5],
        },
        [1.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5],
        [6.5, 9.5, 5.5, 4.5],
      );
    } finally {
      gpu.dispose();
    }
  });
});

async function expectPreparedPacking(
  gpu: Awaited<ReturnType<typeof init>>,
  prepared: ReturnType<typeof prepareShader>,
  params: Record<string, unknown>,
  expectedCompute: readonly number[],
  expectedEffect: readonly number[],
): Promise<void> {
  const output = storage(gpu, expectedCompute.length * Float32Array.BYTES_PER_ELEMENT);
  const kernel = compute(gpu, prepared, { entry: "cs_main", set: { params, output } });
  await kernel.compile();
  kernel.dispatch(1);
  await gpu.settled();
  expect([...new Float32Array(await output.read())]).toEqual(expectedCompute);

  const color = target(gpu, { size: [1, 1], format: "rgba32float", label: "prepared-layout-color" });
  const shader = effect(gpu, prepared, { entry: { fragment: "fs_main" }, set: { params } });
  await shader.compile(color);
  await frame(gpu, (currentFrame) => currentFrame.pass(color, shader)).done;
  expect([...(await color.color.readFloats({ mipLevel: 0, region: "all" })).subarray(0, 4)]).toEqual(expectedEffect);
}
