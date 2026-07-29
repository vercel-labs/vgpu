import { expect, test } from "vitest";
import { createMockGpu, getMockDeviceInstrumentation } from "../test-utils/mock.ts";
import { effect, frame, target } from "../src/index.ts";

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
    const shader = effect(gpu, SHADER, { label: "mock-helper", set: { value: 1 } });
    const colorTarget = target(gpu, { size: [4, 4], format: "rgba8unorm" });
    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget }, (encoder) => encoder.draw(shader)));
    const instrumentation = getMockDeviceInstrumentation(gpu);
    expect(instrumentation.calls.createRenderPipeline).toBe(1);
    expect(instrumentation.calls.createCommandEncoder).toBe(1);
  } finally {
    gpu.dispose();
  }
});
