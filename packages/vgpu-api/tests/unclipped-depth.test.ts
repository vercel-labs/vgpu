import { expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { createMockAdapter, init, draw, target } from "../src/mock.ts";

const SOLID = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }
`;

function initWithDepthClipControl() {
  return init({ adapter: createMockAdapter({ features: ["depth-clip-control"] }), requiredFeatures: ["depth-clip-control"] });
}

test("unclippedDepth reaches the render pipeline primitive state", async () => {
  const gpu = await initWithDepthClipControl();
  const colorTarget = target(gpu, { size: [4, 4], depth: true });

  draw(gpu, { shader: SOLID, label: "unclipped", unclippedDepth: true }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.primitive).toEqual({ topology: "triangle-list", unclippedDepth: true });
  gpu.dispose();
});

test("absent or false unclippedDepth keeps byte-identical primitive descriptors", async () => {
  const gpu = await initWithDepthClipControl();
  const colorTarget = target(gpu, { size: [4, 4] });

  draw(gpu, { shader: SOLID, label: "absent" }).draw(colorTarget);
  draw(gpu, { shader: SOLID, label: "explicit-false", unclippedDepth: false }).draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  // Byte-identical descriptors share one cached pipeline; the only descriptor has no unclippedDepth member.
  expect(mock.calls.createRenderPipeline).toBe(1);
  expect(mock.createRenderPipelineDescriptors.at(-1)?.primitive).toEqual({ topology: "triangle-list" });
  gpu.dispose();
});

test("explicit false shares the pipeline cache key with the absent option", async () => {
  const gpu = await initWithDepthClipControl();
  const colorTarget = target(gpu, { size: [4, 4] });

  draw(gpu, { shader: SOLID, label: "plain" }).draw(colorTarget);
  draw(gpu, { shader: SOLID, label: "false", unclippedDepth: false }).draw(colorTarget);
  draw(gpu, { shader: SOLID, label: "true", unclippedDepth: true }).draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  // plain and explicit-false share one pipeline; unclippedDepth: true compiles a distinct one.
  expect(mock.calls.createRenderPipeline).toBe(2);
  gpu.dispose();
});

test("non-boolean unclippedDepth fails at draw construction", async () => {
  const gpu = await initWithDepthClipControl();
  for (const value of ["yes", 1, {}, [], null]) {
    expect(() => draw(gpu, { shader: SOLID, label: "bad", unclippedDepth: value as never })).toThrowError(/VGPU-UNCLIPPED-DEPTH-INVALID|expected a boolean/);
  }
  gpu.dispose();
});

test("unclippedDepth: true without the depth-clip-control feature throws with the init guidance", async () => {
  const gpu = await init();
  expect(gpu.device.features.has("depth-clip-control")).toBe(false);
  let error: unknown;
  try { draw(gpu, { shader: SOLID, label: "no-feature", unclippedDepth: true }); }
  catch (thrown) { error = thrown; }
  expect(error).toMatchObject({
    code: "VGPU-UNCLIPPED-DEPTH-INVALID",
    message: expect.stringContaining(`init({ requiredFeatures: ["depth-clip-control"] })`),
  });
  // false stays valid on a device without the feature; it behaves exactly like the absent option.
  expect(() => draw(gpu, { shader: SOLID, label: "false-ok", unclippedDepth: false })).not.toThrow();
  gpu.dispose();
});

test("unclippedDepth composes with cull and frontFace in the primitive state", async () => {
  const gpu = await initWithDepthClipControl();
  const colorTarget = target(gpu, { size: [4, 4], depth: true });

  draw(gpu, { shader: SOLID, label: "combo", cull: "back", frontFace: "cw", unclippedDepth: true }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.primitive).toEqual({ topology: "triangle-list", cullMode: "back", frontFace: "cw", unclippedDepth: true });
  gpu.dispose();
});
