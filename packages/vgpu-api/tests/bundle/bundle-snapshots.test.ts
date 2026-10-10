import { prepareShader } from "@vgpu/wgsl/prepare";
import { expect, test, vi } from "vitest";
import { bundle, draw, effect, frame, geometry, init, target } from "../../src/mock.ts";

const SAMPLED = `
@group(0) @binding(0) var source: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f {
  return textureLoad(source, vec2i(0), 0);
}
`;

const SOLID = `
@fragment fn main() -> @location(0) vec4f { return vec4f(1); }
`;

const GEOMETRY = `
@vertex fn vs_main(@location(0) position: vec2f) -> @builtin(position) vec4f {
  return vec4f(position, 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
`;

test("recording-local rebinding stales older bundles and captures both resources in the new bundle", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const first = target(gpu, { size: [4, 4] });
    const second = target(gpu, { size: [4, 4] });
    const sampled = effect(gpu, prepareShader(SAMPLED), { label: "sampled", set: { source: first.color } });
    const older = bundle(gpu, { target: output, label: "older" }, recorder => recorder.draw(sampled));
    const newer = bundle(gpu, { target: output, label: "newer" }, recorder => {
      recorder.draw(sampled);
      sampled.set({ source: second.color });
      recorder.draw(sampled);
    });

    expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(older)))).toThrowError(
      expect.objectContaining({ code: "VGPU-R3-BUNDLE-STALE" }),
    );
    first.color.destroy();
    expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(newer)))).toThrowError(
      expect.objectContaining({ code: "VGPU-R3-BUNDLE-STALE" }),
    );
  } finally {
    gpu.dispose();
  }
});

test("captured geometry and a captured slice both validate their backing geometry at replay", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const mesh = geometry(gpu, {
      buffers: [{ data: new Float32Array([-1, -1, 1, -1, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }],
    });
    const whole = draw(gpu, { shader: prepareShader(GEOMETRY), geometry: mesh });
    const sliced = draw(gpu, { shader: prepareShader(GEOMETRY), geometry: mesh.slice({ firstVertex: 0, vertexCount: 3 }) });
    const recorded = bundle(gpu, { target: output }, recorder => {
      recorder.draw(whole);
      recorder.draw(sliced);
    });
    mesh.destroy();
    expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(recorded)))).toThrow(/Geometry is destroyed/);
  } finally { gpu.dispose(); }
});

test("a mixed live and stale bundle list executes none of the list", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const source = target(gpu, { size: [4, 4] });
    const liveDraw = effect(gpu, prepareShader(SOLID));
    const sampled = effect(gpu, prepareShader(SAMPLED), { set: { source: source.color } });
    const live = bundle(gpu, { target: output, label: "live" }, recorder => recorder.draw(liveDraw));
    const stale = bundle(gpu, { target: output, label: "stale" }, recorder => recorder.draw(sampled));
    source.color.destroy();
    const executeBundles = vi.fn();
    const createCommandEncoder = gpu.gpu.createCommandEncoder.bind(gpu.gpu);
    vi.spyOn(gpu.gpu, "createCommandEncoder").mockImplementation((descriptor) => {
      const encoder = createCommandEncoder(descriptor);
      const begin = encoder.beginRenderPass.bind(encoder);
      encoder.beginRenderPass = (passDescriptor) => {
        const pass = begin(passDescriptor);
        const execute = pass.executeBundles.bind(pass);
        pass.executeBundles = (bundles) => { executeBundles(); execute(bundles); };
        return pass;
      };
      return encoder;
    });

    expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(live, stale)))).toThrowError(
      expect.objectContaining({ code: "VGPU-R3-BUNDLE-STALE" }),
    );
    expect(executeBundles).not.toHaveBeenCalled();
  } finally { gpu.dispose(); }
});

test("consumer disposal permanently stales managed replay with the exact draw cause", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const drawable = effect(gpu, prepareShader(SOLID), { label: "retired-effect" });
    const recorded = bundle(gpu, { target: output, label: "retired-bundle" }, recorder => recorder.draw(drawable));
    const savedNative = recorded.gpu;

    drawable.dispose();

    expect(recorded.gpu).toBe(savedNative);

    expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(recorded)))).toThrowError(
      expect.objectContaining({
        code: "VGPU-R3-BUNDLE-STALE",
        message: "Bundle 'retired-bundle' is stale: draw 'retired-effect' was disposed. Create a new draw/effect and re-record the bundle.",
      }),
    );
  } finally {
    gpu.dispose();
  }
});

test("recording an already-disposed consumer fails with its tombstone before native encoding", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const drawable = effect(gpu, prepareShader(SOLID), { label: "already-retired" });
    drawable.dispose();

    expect(() => bundle(gpu, { target: output, label: "failed-recording" }, recorder => recorder.draw(drawable))).toThrowError(
      expect.objectContaining({
        code: "VGPU-DRAW-DISPOSED",
        where: "already-retired.draw",
      }),
    );
  } finally {
    gpu.dispose();
  }
});

test("recording an already-disposed plain Draw reports the recorder draw operation", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const drawable = draw(gpu, { shader: prepareShader(SOLID), label: "already-retired-draw" });
    drawable.dispose();

    expect(() => bundle(gpu, { target: output }, recorder => recorder.draw(drawable))).toThrowError(
      expect.objectContaining({ code: "VGPU-DRAW-DISPOSED", where: "already-retired-draw.draw" }),
    );
  } finally {
    gpu.dispose();
  }
});

test("disposal during recording stales immediately", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const drawable = effect(gpu, prepareShader(SOLID), { label: "recording-retired" });
    const recorded = bundle(gpu, { target: output, label: "recording-bundle" }, recorder => {
      recorder.draw(drawable);
      drawable.dispose();
    });

    expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(recorded)))).toThrowError(
      expect.objectContaining({
        code: "VGPU-R3-BUNDLE-STALE",
        message: "Bundle 'recording-bundle' is stale: draw 'recording-retired' was disposed. Create a new draw/effect and re-record the bundle.",
      }),
    );
  } finally {
    gpu.dispose();
  }
});

test("the first permanent stale cause wins over later consumer disposal", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const source = target(gpu, { size: [4, 4] });
    const drawable = effect(gpu, prepareShader(SAMPLED), { label: "first-cause", set: { source: source.color } });
    const recorded = bundle(gpu, { target: output, label: "first-cause-bundle" }, recorder => recorder.draw(drawable));

    source.color.destroy();
    drawable.dispose();

    try {
      frame(gpu, current => current.pass(output, pass => pass.bundles(recorded)));
      throw new Error("expected stale bundle");
    } catch (error) {
      expect(error).toMatchObject({ code: "VGPU-R3-BUNDLE-STALE" });
      expect((error as Error).message).toContain("binding `source`");
      expect((error as Error).message).not.toContain("was disposed");
    }
  } finally {
    gpu.dispose();
  }
});

test("consumer disposal stales every bundle that recorded it and leaves unrelated bundles live", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const retired = effect(gpu, prepareShader(SOLID), { label: "retired-many" });
    const live = effect(gpu, prepareShader(SOLID), { label: "live-many" });
    const first = bundle(gpu, { target: output, label: "first-many" }, recorder => recorder.draw(retired));
    const second = bundle(gpu, { target: output, label: "second-many" }, recorder => {
      recorder.draw(live);
      recorder.draw(retired);
    });
    const control = bundle(gpu, { target: output, label: "control-many" }, recorder => recorder.draw(live));

    retired.dispose();

    for (const recorded of [first, second]) {
      expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(recorded)))).toThrowError(
        expect.objectContaining({ code: "VGPU-R3-BUNDLE-STALE" }),
      );
    }
    expect(() => frame(gpu, current => current.pass(output, pass => pass.bundles(control)))).not.toThrow();
  } finally {
    gpu.dispose();
  }
});
