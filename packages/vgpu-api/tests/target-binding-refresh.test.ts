import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { bundle, effect, frame, init, target } from "../src/mock.ts";

const SAMPLE = `
@group(0) @binding(0) var source: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f {
  return textureLoad(source, vec2i(0), 0);
}
`;

const DEPTH = `
@group(0) @binding(0) var source: texture_depth_2d;
@fragment fn main() -> @location(0) vec4f {
  return vec4f(textureLoad(source, vec2i(0), 0));
}
`;

const TWO_TEXTURES = `
@group(0) @binding(0) var first: texture_2d<f32>;
@group(0) @binding(1) var second: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f {
  return textureLoad(first, vec2i(0), 0) + textureLoad(second, vec2i(0), 0);
}
`;

test("a followed Target resolves only its newest attachment without recreate subscriptions", async () => {
  const gpu = await init();
  try {
    const source = target(gpu, { size: [4, 4] });
    const output = target(gpu, { size: [4, 4] });
    const recreate = vi.spyOn(source, "onTexturesRecreated");
    const sampled = effect(gpu, SAMPLE, { label: "lazy-target", set: { source } });
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    const groupsBefore = mock.calls.createBindGroup;

    source.resize([8, 8]);
    source.resize([16, 16]);
    source.resize([32, 32]);

    expect(recreate).not.toHaveBeenCalled();
    expect(() => frame(gpu, current => current.pass(output, pass => pass.draw(sampled)))).not.toThrow();
    expect(mock.calls.createBindGroup).toBe(groupsBefore + 1);
    expect(() => frame(gpu, current => current.pass(output, pass => pass.draw(sampled)))).not.toThrow();
    expect(mock.calls.createBindGroup).toBe(groupsBefore + 1);
  } finally {
    gpu.dispose();
  }
});

test("reflected depth bindings follow the newest depth attachment", async () => {
  const gpu = await init();
  try {
    const source = target(gpu, { size: [4, 4], depth: true });
    const output = target(gpu, { size: [4, 4] });
    const sampled = effect(gpu, DEPTH, { set: { source } });
    source.resize([8, 8]);
    source.resize([16, 16]);
    expect(() => frame(gpu, current => current.pass(output, pass => pass.draw(sampled)))).not.toThrow();
  } finally { gpu.dispose(); }
});

test("same-size and failed Target resizes preserve the resolved cache entry", async () => {
  const gpu = await init();
  try {
    const source = target(gpu, { size: [4, 4] });
    const output = target(gpu, { size: [4, 4] });
    const sampled = effect(gpu, SAMPLE, { set: { source } });
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    const render = () => frame(gpu, current => current.pass(output, pass => pass.draw(sampled)));
    render();
    const groups = mock.calls.createBindGroup;
    source.resize([4, 4]);
    render();
    expect(mock.calls.createBindGroup).toBe(groups);

    const failure = vi.spyOn(gpu.device, "createTexture").mockImplementation(() => { throw new Error("allocation failed"); });
    expect(() => source.resize([8, 8])).toThrow("allocation failed");
    failure.mockRestore();
    render();
    expect(mock.calls.createBindGroup).toBe(groups);
  } finally { gpu.dispose(); }
});

test("recreation callbacks see the new generation and reject the obsolete bundle before old destruction", async () => {
  const gpu = await init();
  try {
    const source = target(gpu, { size: [4, 4] });
    const output = target(gpu, { size: [4, 4] });
    const sampled = effect(gpu, SAMPLE, { label: "followed", set: { source } });
    const obsolete = bundle(gpu, { target: output, label: "obsolete" }, recorder => recorder.draw(sampled));
    let fresh: ReturnType<typeof bundle> | undefined;
    source.onTexturesRecreated!(() => {
      expect(() => frame(gpu, current => current.pass(output, pass => pass.draw(sampled)))).not.toThrow();
      expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(obsolete)))).toThrowError(
        expect.objectContaining({ code: "VGPU-R3-BUNDLE-STALE" }),
      );
      fresh = bundle(gpu, { target: output, label: "fresh" }, recorder => recorder.draw(sampled));
      expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(fresh!)))).not.toThrow();
    });

    source.resize([8, 8]);
    expect(fresh).toBeDefined();
    expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(fresh!)))).not.toThrow();
  } finally { gpu.dispose(); }
});

test("fixed attachments and destroyed Targets fail, while followed replacements recover", async () => {
  const gpu = await init();
  try {
    const followedSource = target(gpu, { size: [4, 4] });
    const fixedSource = target(gpu, { size: [4, 4] });
    const output = target(gpu, { size: [4, 4] });
    const followed = effect(gpu, SAMPLE, { label: "followed", set: { source: followedSource } });
    const fixed = effect(gpu, SAMPLE, { label: "fixed", set: { source: fixedSource.color } });
    const render = (drawable: typeof followed) => frame(gpu, current => current.pass(output, pass => pass.draw(drawable)));
    fixedSource.color.destroy();
    expect(() => render(fixed)).toThrowError(expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED" }));
    followedSource.color.destroy();
    expect(() => render(followed)).toThrowError(expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED" }));
    followedSource.resize([8, 8]);
    expect(() => render(followed)).not.toThrow();
    followedSource.destroy();
    expect(() => render(followed)).toThrowError(expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED" }));
  } finally { gpu.dispose(); }
});

test("each dead binding can be replaced transactionally despite another dead binding", async () => {
  const gpu = await init();
  try {
    const first = target(gpu, { size: [4, 4] });
    const second = target(gpu, { size: [4, 4] });
    const firstReplacement = target(gpu, { size: [4, 4] });
    const secondReplacement = target(gpu, { size: [4, 4] });
    const output = target(gpu, { size: [4, 4] });
    const sampled = effect(gpu, TWO_TEXTURES, { set: { first: first.color, second: second.color } });
    first.color.destroy();
    second.color.destroy();
    expect(() => sampled.set({ first: firstReplacement.color })).not.toThrow();
    expect(() => frame(gpu, current => current.pass(output, pass => pass.draw(sampled)))).toThrowError(
      expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED" }),
    );
    expect(() => sampled.set({ second: secondReplacement.color })).not.toThrow();
    expect(() => frame(gpu, current => current.pass(output, pass => pass.draw(sampled)))).not.toThrow();
  } finally { gpu.dispose(); }
});

test("a fresh followed bundle stays live and destination-only resize stays signature-compatible", async () => {
  const gpu = await init();
  try {
    const source = target(gpu, { size: [4, 4] });
    const output = target(gpu, { size: [4, 4] });
    const sampled = effect(gpu, SAMPLE, { set: { source } });
    source.resize([8, 8]);
    const recorded = bundle(gpu, { target: output }, recorder => recorder.draw(sampled));
    expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(recorded)))).not.toThrow();
    output.resize([16, 16]);
    expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(recorded)))).not.toThrow();
  } finally { gpu.dispose(); }
});
