import { describe, expect, test, vi } from "vitest";
import { init, target, effect, frame, bundle } from "../../src/node.ts";

const SAMPLE = `@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f { return textureLoad(src, vec2i(0), 0); }`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("texture replacement on Dawn", () => {
  test("rollback preserves pixels; commit updates Target bindings and rejects retained attachments", async () => {
    const gpu = await init();
    try {
      const source = target(gpu, { size: [4, 4], depth: true });
      const output = target(gpu, { size: [2, 2] });
      const followed = effect(gpu, SAMPLE, { set: { src: source } });
      const fixed = effect(gpu, SAMPLE, { set: { src: source.color } });
      const recorded = bundle(gpu, { target: output }, recorder => recorder.draw(fixed));
      const paint = (clear: [number, number, number, number]) => frame(gpu, f => f.pass({ target: source, clear }, () => {}));
      const render = () => frame(gpu, f => f.pass({ target: output }, p => p.draw(followed)));
      paint([1, 0, 0, 1]);
      render();
      expect([...(await output.color.read({ mipLevel: 0, region: "all" })).slice(0, 4)]).toEqual([255, 0, 0, 255]);

      const original = gpu.device.createTexture.bind(gpu.device);
      const spy = vi.spyOn(gpu.device, "createTexture").mockImplementation(opts => {
        if (opts.format === "depth24plus") throw new Error("depth preparation failed");
        return original(opts);
      });
      expect(() => source.resize([8, 8])).toThrow("depth preparation failed");
      spy.mockRestore();
      render();
      expect([...(await output.color.read({ mipLevel: 0, region: "all" })).slice(0, 4)]).toEqual([255, 0, 0, 255]);
      expect(source.size).toEqual([4, 4]);
      frame(gpu, f => f.pass({ target: output }, p => p.bundles(recorded)));
      expect([...(await output.color.read({ mipLevel: 0, region: "all" })).slice(0, 4)]).toEqual([255, 0, 0, 255]);

      source.resize([8, 8]);
      paint([0, 0, 1, 1]);
      render();
      expect([...(await output.color.read({ mipLevel: 0, region: "all" })).slice(0, 4)]).toEqual([0, 0, 255, 255]);
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.draw(fixed)))).toThrow(/destroyed/);
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.bundles(recorded)))).toThrow(/stale/);
      fixed.set({ src: source.color });
      frame(gpu, f => f.pass({ target: output }, p => p.draw(fixed)));
      expect([...(await output.color.read({ mipLevel: 0, region: "all" })).slice(0, 4)]).toEqual([0, 0, 255, 255]);
    } finally { gpu.dispose(); }
  });

  test("late native validation errors stay in WebGPU error scopes without rollback", async () => {
    const gpu = await init();
    try {
      const source = target(gpu, { size: [4, 4] });
      const old = source.color;
      const create = gpu.gpu.createTexture.bind(gpu.gpu);
      gpu.gpu.pushErrorScope("validation");
      const spy = vi.spyOn(gpu.gpu, "createTexture").mockImplementationOnce(desc => create({ ...desc, size: { width: 0, height: 8 } }));
      expect(() => source.resize([8, 8])).not.toThrow();
      spy.mockRestore();
      expect(await gpu.gpu.popErrorScope()).not.toBeNull();
      expect(source.color).not.toBe(old);
      expect(source.size).toEqual([8, 8]);
      expect(() => old.view).toThrow(/destroyed/);
      source.resize([16, 16]);
      frame(gpu, f => f.pass({ target: source, clear: [0, 1, 0, 1] }, () => {}));
      expect([...(await source.color.read({ mipLevel: 0, region: "all" })).slice(0, 4)]).toEqual([0, 255, 0, 255]);
    } finally { gpu.dispose(); }
  });
});
