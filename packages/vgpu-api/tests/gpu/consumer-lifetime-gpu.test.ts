import { prepareShader } from "@vgpu/wgsl/prepare";
import { describe, expect, test } from "vitest";
import { compute, draw, effect, frame, geometry, init, storage, target, texture, uniforms } from "../../src/node.ts";

const DRAW_SHADER = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(params.value, 0, 0, 1); }
`;

const EFFECT_SHADER = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0, params.value, 0, 1); }
`;

const COMPUTE_SHADER = `
struct Params { value: u32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(1) fn main() { output[0] += params.value; }
`;

const BORROWED_DRAW_SHADER = `
struct Params { tint: vec4f }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;
@vertex fn vs_main(@location(0) position: vec2f) -> @builtin(position) vec4f {
  return vec4f(position, 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f {
  return textureLoad(source, vec2i(0), 0) * params.tint;
}
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("consumer disposal native lifetime", () => {
  test("pending Draw, Effect and Compute commands preserve captured output after disposal", async () => {
    const gpu = await init();
    const errors: unknown[] = [];
    gpu.onError(error => errors.push(error));
    try {
      const first = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      const second = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      const effectOutput = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      const values = storage(gpu, 4);
      values.write(new Uint32Array([0]));
      const drawable = draw(gpu, { shader: prepareShader(DRAW_SHADER), label: "pending-draw", set: { params: { value: 0.25 } } });
      const fullscreen = effect(gpu, prepareShader(EFFECT_SHADER), { label: "pending-effect", set: { params: { value: 0.5 } } });
      const simulation = compute(gpu, prepareShader(COMPUTE_SHADER), { label: "pending-compute", set: { params: { value: 1 }, output: values } });
      await Promise.all([drawable.compile(first), fullscreen.compile(effectOutput), simulation.compile()]);

      const pending = frame(gpu);
      pending.pass(first, pass => pass.draw(drawable));
      drawable.set({ params: { value: 0.75 } });
      pending.pass(second, pass => pass.draw(drawable));
      pending.pass(effectOutput, pass => pass.draw(fullscreen));
      pending.computePass(pass => {
        pass.dispatch(simulation, 1);
        simulation.set({ params: { value: 2 } });
        pass.dispatch(simulation, 1);
      });
      drawable.dispose();
      fullscreen.dispose();
      simulation.dispose();
      pending.submit();
      await pending.done;

      expect(await Promise.all([first, second, effectOutput].map(readPixel))).toEqual([
        [64, 0, 0, 255],
        [191, 0, 0, 255],
        [0, 128, 0, 255],
      ]);
      expect(new Uint32Array(await values.read())[0]).toBe(3);
      await gpu.settled();
      expect(errors).toEqual([]);

      const canceledValues = storage(gpu, 4);
      canceledValues.write(new Uint32Array([7]));
      const canceledCompute = compute(gpu, prepareShader(COMPUTE_SHADER), { set: { params: { value: 9 }, output: canceledValues } });
      await canceledCompute.compile();
      const canceled = frame(gpu);
      canceled.computePass(pass => pass.dispatch(canceledCompute, 1));
      canceledCompute.dispose();
      canceled.cancel();
      await canceled.done;
      expect(new Uint32Array(await canceledValues.read())[0]).toBe(7);

      const canceledOutput = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      const canceledDraw = draw(gpu, { shader: prepareShader(DRAW_SHADER), set: { params: { value: 0.25 } } });
      frame(gpu, current => current.pass(canceledOutput, pass => pass.draw(canceledDraw)));
      await gpu.settled();
      expect(await readPixel(canceledOutput)).toEqual([64, 0, 0, 255]);
      canceledDraw.set({ params: { value: 0.75 } });
      const canceledFrame = frame(gpu);
      canceledFrame.pass(canceledOutput, pass => pass.draw(canceledDraw));
      canceledDraw.dispose();
      canceledFrame.cancel();
      await canceledFrame.done;
      expect(await readPixel(canceledOutput)).toEqual([64, 0, 0, 255]);
      expect(errors).toEqual([]);
    } finally {
      gpu.dispose();
    }
  });

  test("borrowed targets and buffers plus a shared-pipeline peer remain usable", async () => {
    const gpu = await init();
    const errors: unknown[] = [];
    gpu.onError(error => errors.push(error));
    try {
      const retiredOutput = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      const peerOutput = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      const borrowed = storage(gpu, 4);
      borrowed.write(new Uint32Array([4]));
      const retiredDraw = draw(gpu, { shader: prepareShader(DRAW_SHADER), label: "retired-owner", set: { params: { value: 0.25 } } });
      const peerDraw = draw(gpu, { shader: prepareShader(DRAW_SHADER), label: "live-peer", set: { params: { value: 0.5 } } });
      const retiredCompute = compute(gpu, prepareShader(COMPUTE_SHADER), { label: "retired-compute-owner", set: { params: { value: 3 }, output: borrowed } });
      const peerCompute = compute(gpu, prepareShader(COMPUTE_SHADER), { label: "live-compute-peer", set: { params: { value: 2 }, output: borrowed } });
      await Promise.all([retiredDraw.compile(retiredOutput), peerDraw.compile(peerOutput), retiredCompute.compile(), peerCompute.compile()]);

      retiredDraw.dispose();
      retiredCompute.dispose();
      frame(gpu, current => {
        current.pass(peerOutput, pass => pass.draw(peerDraw));
        current.computePass(pass => pass.dispatch(peerCompute, 1));
      });
      await gpu.settled();

      expect(await readPixel(peerOutput)).toEqual([128, 0, 0, 255]);
      expect(new Uint32Array(await borrowed.read())[0]).toBe(6);
      expect(await retiredOutput.color.read({ mipLevel: 0, region: "all" })).toHaveLength(4);
      expect(errors).toEqual([]);
    } finally {
      gpu.dispose();
    }
  });

  test("borrowed texture, geometry and SharedUniforms remain usable after owner disposal", async () => {
    const gpu = await init();
    const errors: unknown[] = [];
    gpu.onError(error => errors.push(error));
    try {
      const source = texture(gpu, {
        kind: "2d",
        size: [1, 1],
        format: "rgba8unorm",
        usage: ["texture_binding", "copy_dst"],
      });
      gpu.gpu.queue.writeTexture(
        { texture: source.gpu },
        new Uint8Array([64, 128, 192, 255]),
        { bytesPerRow: 4 },
        [1, 1],
      );
      const fullscreen = geometry(gpu, {
        buffers: [{
          data: new Float32Array([-1, -1, 3, -1, -1, 3]),
          attributes: { position: { format: "float32x2", location: 0 } },
        }],
      });
      const params = uniforms(gpu, { tint: [1, 1, 1, 1] });
      const retiredOutput = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      const peerOutput = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      const retired = draw(gpu, {
        shader: prepareShader(BORROWED_DRAW_SHADER),
        geometry: fullscreen,
        label: "retired-borrower",
        set: { source, params },
      });
      const peer = draw(gpu, {
        shader: prepareShader(BORROWED_DRAW_SHADER),
        geometry: fullscreen,
        label: "live-borrower",
        set: { source, params },
      });
      await Promise.all([retired.compile(retiredOutput), peer.compile(peerOutput)]);

      const pending = frame(gpu);
      pending.pass(retiredOutput, pass => pass.draw(retired));
      retired.dispose();
      pending.submit();
      await pending.done;
      expect(await readPixel(retiredOutput)).toEqual([64, 128, 192, 255]);

      params.set({ tint: [1, 0.5, 0.25, 1] });
      frame(gpu, current => current.pass(peerOutput, pass => pass.draw(peer)));
      await gpu.settled();

      expect(await readPixel(peerOutput)).toEqual([64, 64, 48, 255]);
      expect(errors).toEqual([]);
    } finally {
      gpu.dispose();
    }
  });
});

async function readPixel(output: ReturnType<typeof target>): Promise<readonly number[]> {
  return [...(await output.color.read({ mipLevel: 0, region: "all" })).slice(0, 4)];
}
