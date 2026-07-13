import { expect, test } from "vitest";
import { createMockGpu, getMockDeviceInstrumentation } from "../test-utils/mock.ts";

const SHADER = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(params.value, uv.x, uv.y, 1.0);
}
`;

test("test-utils mock helper runs vgpu without loading Dawn", async () => {
  const gpu = await createMockGpu({ size: [4, 4] });
  try {
    const pass = gpu.pass(SHADER, { label: "mock-helper", set: { value: 1 } });
    const target = gpu.target({ size: [4, 4], format: "rgba8unorm" });
    gpu.frame((frame) => frame.pass({ target }, (encoder) => encoder.draw(pass)));
    const instrumentation = getMockDeviceInstrumentation(gpu);
    expect(instrumentation.calls.createRenderPipeline).toBe(1);
    expect(instrumentation.calls.createCommandEncoder).toBe(1);
  } finally {
    gpu.dispose();
  }
});
