import { prepareShader } from "@vgpu/wgsl/prepare";
import { describe, expect, test } from "vitest";
import { bundle, draw, effect, frame, init, target, type Draw, type Effect } from "../../src/node.ts";

const LIVE_COLOR = `
struct Params { color: vec4f }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main() -> @location(0) vec4f { return params.color; }
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("bundle lifetime GPU acceptance", () => {
  test.each(["draw", "effect"] as const)("saved native bundle keeps the last live %s update after facade and consumer disposal", async kind => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: [4, 4], format: "rgba8unorm" });
      const drawable = renderConsumer(kind, gpu, { color: [1, 0, 0, 1] });
      const recorded = bundle(gpu, { target: output, label: "live-color-bundle" }, (recorder) => recorder.draw(drawable));

      frame(gpu, (currentFrame) => currentFrame.pass(output, (pass) => pass.bundles(recorded)));
      expect(rgbaAt(await output.color.read({ mipLevel: 0, region: "all" }), 4, 2, 2)).toEqual([255, 0, 0, 255]);

      drawable.set({ params: { color: [0, 1, 0, 1] } });
      const pending = frame(gpu);
      pending.pass(output, (pass) => pass.bundles(recorded));
      const savedNative = recorded.gpu;
      recorded.dispose();
      pending.submit();
      await pending.done;
      expect(rgbaAt(await output.color.read({ mipLevel: 0, region: "all" }), 4, 2, 2)).toEqual([0, 255, 0, 255]);

      drawable.dispose();
      const encoder = gpu.gpu.createCommandEncoder();
      const pass = encoder.beginRenderPass(output.renderPassDescriptor({ clear: [0, 0, 0, 1] }));
      pass.executeBundles([savedNative]);
      pass.end();
      gpu.gpu.queue.submit([encoder.finish()]);
      await gpu.gpu.queue.onSubmittedWorkDone();
      expect(rgbaAt(await output.color.read({ mipLevel: 0, region: "all" }), 4, 2, 2)).toEqual([0, 255, 0, 255]);
    } finally {
      gpu.dispose();
    }
  });

  test("consumer disposal stales managed replay but preserves pending and saved native bundle output", async () => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: [4, 4], format: "rgba8unorm" });
      const drawable = effect(gpu, LIVE_COLOR, { label: "retired-color", set: { params: { color: [0, 0, 1, 1] } } });
      const recorded = bundle(gpu, { target: output, label: "retired-color-bundle" }, recorder => recorder.draw(drawable));
      const savedNative = recorded.gpu;
      const pending = frame(gpu);
      pending.pass(output, pass => pass.bundles(recorded));

      drawable.dispose();
      expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(recorded)))).toThrowError(
        expect.objectContaining({ code: "VGPU-R3-BUNDLE-STALE" }),
      );
      recorded.dispose();
      pending.submit();
      await pending.done;
      expect(rgbaAt(await output.color.read({ mipLevel: 0, region: "all" }), 4, 2, 2)).toEqual([0, 0, 255, 255]);

      const encoder = gpu.gpu.createCommandEncoder();
      const pass = encoder.beginRenderPass(output.renderPassDescriptor({ clear: [0, 0, 0, 1] }));
      pass.executeBundles([savedNative]);
      pass.end();
      gpu.gpu.queue.submit([encoder.finish()]);
      await gpu.gpu.queue.onSubmittedWorkDone();
      expect(rgbaAt(await output.color.read({ mipLevel: 0, region: "all" }), 4, 2, 2)).toEqual([0, 0, 255, 255]);
    } finally {
      gpu.dispose();
    }
  });
});

function renderConsumer(kind: "draw" | "effect", gpu: Awaited<ReturnType<typeof init>>, params: { color: readonly number[] }): Draw | Effect {
  if (kind === "effect") return effect(gpu, LIVE_COLOR, { label: "live-effect-color", set: { params } });
  return draw(gpu, {
    label: "live-draw-color",
    shader: `
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
${LIVE_COLOR}`,
    set: { params },
  });
}

function rgbaAt(pixels: Uint8Array, width: number, x: number, y: number): readonly [number, number, number, number] {
  const offset = 4 * (y * width + x);
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}
