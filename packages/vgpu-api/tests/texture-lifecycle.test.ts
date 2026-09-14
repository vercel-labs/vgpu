import { describe, expect, test, vi } from "vitest";
import { type Texture, pingPong as texturePair } from "@vgpu/core";
import { init, texture, target, effect, frame, compute, bundle, pingPong } from "../src/mock.ts";

const SAMPLE = `@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f { return textureLoad(src, vec2i(0), 0); }`;
const STORE = `@group(0) @binding(0) var dst: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(1) fn main() { textureStore(dst, vec2i(0), vec4f(1)); }`;

describe("tracked texture lifetimes", () => {
  test("bundles observe every captured texture even after Draw.set during recording", async () => {
    const gpu = await init();
    try {
      const a = target(gpu, { size: [4, 4] });
      const b = target(gpu, { size: [4, 4] });
      const output = target(gpu, { size: [4, 4] });
      const post = effect(gpu, SAMPLE, { set: { src: a.color } });
      const recorded = bundle(gpu, { target: output }, recorder => {
        recorder.draw(post);
        post.set({ src: b.color });
        recorder.draw(post);
      });
      a.destroy();
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.draw(post)))).not.toThrow();
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.bundles(recorded)))).toThrow(/stale/);
    } finally { gpu.dispose(); }
  });

  test("destruction during recording cannot hide a captured texture's invalidation", async () => {
    const gpu = await init();
    try {
      const source = target(gpu, { size: [4, 4] });
      const output = target(gpu, { size: [4, 4] });
      const post = effect(gpu, SAMPLE, { set: { src: source.color } });
      const recorded = bundle(gpu, { target: output }, recorder => {
        recorder.draw(post);
        source.color.destroy();
      });
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.bundles(recorded)))).toThrow(/stale/);
    } finally { gpu.dispose(); }
  });

  test("failed recordings release all captured resource subscriptions", async () => {
    const gpu = await init();
    try {
      const source = target(gpu, { size: [4, 4] });
      const output = target(gpu, { size: [4, 4] });
      const post = effect(gpu, SAMPLE, { set: { src: source.color } });
      const onDestroy = source.color.onDestroy.bind(source.color);
      const offs: ReturnType<typeof vi.fn>[] = [];
      vi.spyOn(source.color, "onDestroy").mockImplementation(cb => {
        const off = vi.fn(onDestroy(cb)); offs.push(off); return off;
      });
      expect(() => bundle(gpu, { target: output }, recorder => {
        recorder.draw(post);
        throw new Error("record failed");
      })).toThrow("record failed");
      expect(offs).toHaveLength(1);
      expect(offs[0]).toHaveBeenCalledTimes(1);
    } finally { gpu.dispose(); }
  });

  test("repeated Target resize replaces subscriptions instead of accumulating them", async () => {
    const gpu = await init();
    try {
      const source = target(gpu, { size: [4, 4] });
      const alternate = target(gpu, { size: [4, 4] });
      const subscribe = source.onTexturesRecreated!.bind(source);
      const offs: ReturnType<typeof vi.fn>[] = [];
      vi.spyOn(source, "onTexturesRecreated").mockImplementation(cb => {
        const off = vi.fn(subscribe(cb)); offs.push(off); return off;
      });
      const post = effect(gpu, SAMPLE, { set: { src: source } });
      for (let size = 5; size <= 14; size++) source.resize([size, size]);
      expect(offs).toHaveLength(11);
      for (const off of offs.slice(0, -1)) expect(off).toHaveBeenCalledTimes(1);
      expect(offs.at(-1)).not.toHaveBeenCalled();
      post.set({ src: alternate });
      expect(offs.at(-1)).toHaveBeenCalledTimes(1);
      source.resize([16, 16]);
      expect(offs).toHaveLength(11);
    } finally { gpu.dispose(); }
  });

  test("dead sampled binding fails before cache reuse; replacement recovers", async () => {
    const gpu = await init();
    try {
      const src = texture(gpu, { kind: "2d", size: [4, 4], format: "rgba8unorm", usage: ["texture_binding"], label: "old-image" });
      const output = target(gpu, { size: [4, 4] });
      const post = effect(gpu, SAMPLE, { label: "post", set: { src } });
      const render = () => frame(gpu, f => f.pass({ target: output }, p => p.draw(post)));
      render();
      const spy = vi.spyOn(gpu.gpu, "createBindGroup");
      src.destroy();
      expect(render).toThrowError(expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED", message: expect.stringMatching(/src.*post.*old-image/) }));
      expect(spy).not.toHaveBeenCalled();
      expect(() => post.set({ src })).toThrowError(expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED" }));
      post.set({ src: texture(gpu, { kind: "2d", size: [4, 4], format: "rgba8unorm", usage: ["texture_binding"] }) });
      expect(render).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { gpu.dispose(); }
  });

  test("dead storage binding fails before opening or submitting a compute pass", async () => {
    const gpu = await init();
    try {
      const pair = texturePair(gpu.device, { kind: "2d", size: [4, 4], format: "rgba8unorm", usage: ["storage_binding"], label: "simulation" });
      const fill = compute(gpu, STORE, { label: "fill", set: { dst: pair.write } });
      fill.dispatch(1);
      pair.resize([8, 8]);
      const spy = vi.spyOn(gpu.gpu, "createCommandEncoder");
      expect(() => fill.dispatch(1)).toThrowError(expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED" }));
      expect(spy).not.toHaveBeenCalled();
      fill.set({ dst: pair.write });
      expect(() => fill.dispatch(1)).not.toThrow();
      pair.destroy();
    } finally { gpu.dispose(); }
  });

  test("Target bindings follow replacement; attachment references and old bundles do not", async () => {
    const gpu = await init();
    try {
      const source = target(gpu, { size: [4, 4] });
      const output = target(gpu, { size: [4, 4] });
      const followed = effect(gpu, SAMPLE, { set: { src: source } });
      const fixed = effect(gpu, SAMPLE, { set: { src: source.color } });
      const record = () => bundle(gpu, { target: output }, b => b.draw(fixed));
      const oldBundle = record();
      const old = source.color;
      source.resize([8, 8]);
      expect(() => old.view).toThrow(/destroyed/);
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.draw(followed)))).not.toThrow();
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.draw(fixed)))).toThrowError(expect.objectContaining({ code: "VGPU-R1-BINDING-DESTROYED" }));
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.bundles(oldBundle)))).toThrowError(expect.objectContaining({ code: "VGPU-R3-BUNDLE-STALE" }));
      fixed.set({ src: source.color });
      const freshBundle = record();
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.bundles(freshBundle)))).not.toThrow();
      source.color.destroy(); // A Target's attachment can also be destroyed directly.
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.draw(followed)))).toThrow(/destroyed/);
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.bundles(freshBundle)))).toThrow(/stale/);
      source.resize([16, 16]);
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.draw(followed)))).not.toThrow();
    } finally { gpu.dispose(); }
  });

  test("failed set keeps the previous live subscription; successful set removes it", async () => {
    const gpu = await init();
    try {
      const a = target(gpu, { size: [4, 4] });
      const b = target(gpu, { size: [4, 4] });
      const dead = target(gpu, { size: [4, 4] });
      const output = target(gpu, { size: [4, 4] });
      const post = effect(gpu, SAMPLE, { set: { src: a } });
      const render = () => frame(gpu, f => f.pass({ target: output }, p => p.draw(post)));
      dead.destroy();
      expect(() => post.set({ src: dead })).toThrow(/destroyed/);
      a.resize([8, 8]);
      expect(render).not.toThrow();
      post.set({ src: b });
      a.destroy();
      expect(render).not.toThrow();
      b.destroy();
      expect(render).toThrow(/destroyed/);
      expect(() => b.resize([4, 4])).toThrow(/destroyed/);
    } finally { gpu.dispose(); }
  });
});

describe("Target synchronous preparation", () => {
  test("target pair construction cleans the first half when the second fails", async () => {
    const gpu = await init();
    try {
      const original = gpu.device.createTexture.bind(gpu.device);
      let first: Texture | undefined;
      vi.spyOn(gpu.device, "createTexture").mockImplementation(opts => {
        if (first) throw new Error("second target failed");
        return first = original(opts);
      });
      expect(() => pingPong(gpu, 4, 4)).toThrow("second target failed");
      expect(() => first!.view).toThrow(/destroyed/);
    } finally { gpu.dispose(); }
  });

  test("size and format metadata do not follow caller mutation", async () => {
    const gpu = await init();
    try {
      const size: [number, number] = [4, 4];
      const colors: { format: GPUTextureFormat }[] = [{ format: "rgba8unorm" }];
      const source = target(gpu, { size, colors });
      size[0] = 100;
      colors[0]!.format = "rgba16float";
      expect(source.size).toEqual([4, 4]);
      expect(source.format).toBe("rgba8unorm");
      expect(() => source.resize([4, 4, 1] as never)).toThrowError(expect.objectContaining({ code: "VGPU-TARGET-SIZE-REQUIRED" }));
      source.resize([8, 8]);
      expect(source.color.format).toBe("rgba8unorm");
      expect(Object.isFrozen(source.colors)).toBe(true);
    } finally { gpu.dispose(); }
  });

  test("replacement callbacks cannot recursively resize; disposal rejects even same-size requests", async () => {
    const gpu = await init();
    const source = target(gpu, { size: [4, 4] });
    source.onTexturesRecreated!(() => {
      expect(() => source.resize([16, 16])).toThrowError(expect.objectContaining({ code: "VGPU-TARGET-RESIZE-REENTRANT" }));
    });
    source.resize([8, 8]);
    expect(source.size).toEqual([8, 8]);
    gpu.dispose();
    expect(() => source.resize([8, 8])).toThrowError(expect.objectContaining({ code: "VGPU-DEVICE-DISPOSED" }));
  });

  test.each([1, 2, 3, 4, 5])("resize rolls back when allocation %i fails", async (failure) => {
    const gpu = await init();
    try {
      const source = target(gpu, { size: [4, 4], colors: [{ format: "rgba8unorm" }, { format: "rgba16float" }], msaa: true, depth: true });
      const old = [...source.colors, source.depth!];
      const events = vi.fn();
      source.onTexturesRecreated!(events);
      const original = gpu.device.createTexture.bind(gpu.device);
      const prepared: Texture[] = [];
      let calls = 0;
      const spy = vi.spyOn(gpu.device, "createTexture").mockImplementation(opts => {
        if (++calls === failure) throw new Error("allocation failed");
        const texture = original(opts);
        prepared.push(texture);
        return texture;
      });
      expect(() => source.resize([8, 8])).toThrow("allocation failed");
      expect(source.size).toEqual([4, 4]);
      expect([...source.colors, source.depth!]).toEqual(old);
      expect(events).not.toHaveBeenCalled();
      for (const texture of prepared) expect(() => texture.view).toThrow(/destroyed/);
      for (const texture of old) expect(() => texture.view).not.toThrow();
      expect(() => source.renderPassDescriptor()).not.toThrow();
      spy.mockRestore();
      source.resize([8, 8]);
      expect(source.size).toEqual([8, 8]);
      expect(events).toHaveBeenCalledTimes(1);
      for (const texture of old) expect(() => texture.view).toThrow(/destroyed/);
    } finally { gpu.dispose(); }
  });

  test("constructor cleans partial attachments when depth allocation fails", async () => {
    const gpu = await init();
    try {
      const original = gpu.device.createTexture.bind(gpu.device);
      const allocated: Texture[] = [];
      vi.spyOn(gpu.device, "createTexture").mockImplementation(opts => {
        if (opts.format === "depth24plus") throw new Error("depth failed");
        const texture = original(opts);
        allocated.push(texture);
        return texture;
      });
      expect(() => target(gpu, { size: [4, 4], msaa: true, depth: true })).toThrow("depth failed");
      expect(allocated).toHaveLength(2);
      for (const texture of allocated) expect(() => texture.view).toThrow(/destroyed/);
    } finally { gpu.dispose(); }
  });

  test("commit stays coherent and cleans old attachments even if a subscriber throws", async () => {
    const gpu = await init();
    try {
      const source = target(gpu, { size: [4, 4], depth: true });
      const old = source.color;
      const output = target(gpu, { size: [4, 4] });
      source.onTexturesRecreated!(() => { throw new Error("subscriber failed"); });
      const post = effect(gpu, SAMPLE, { set: { src: source } });
      expect(() => source.resize([8, 8])).toThrow("subscriber failed");
      expect(source.size).toEqual([8, 8]);
      expect(source.color.size).toEqual([8, 8]);
      expect(source.depth!.size).toEqual([8, 8]);
      expect(() => old.view).toThrow(/destroyed/);
      expect(() => frame(gpu, f => f.pass({ target: output }, p => p.draw(post)))).not.toThrow();
      const spy = vi.spyOn(gpu.device, "createTexture");
      source.resize([8, 8]);
      expect(spy).not.toHaveBeenCalled();
    } finally { gpu.dispose(); }
  });
});
