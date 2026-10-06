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
    const sampled = effect(gpu, SAMPLED, { label: "sampled", set: { source: first.color } });
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
    const whole = draw(gpu, { shader: GEOMETRY, geometry: mesh });
    const sliced = draw(gpu, { shader: GEOMETRY, geometry: mesh.slice({ firstVertex: 0, vertexCount: 3 }) });
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
    const liveDraw = effect(gpu, SOLID);
    const sampled = effect(gpu, SAMPLED, { set: { source: source.color } });
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
