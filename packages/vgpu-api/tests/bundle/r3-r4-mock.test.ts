import { expect, test, vi } from "vitest";
import { bind, createBindGroup, createBindGroupLayout } from "@vgpu/core";
import { UniformPool } from "@vgpu/render";
import { init } from "../../src/mock.ts";

const FLOOR = `
struct Fog { fogDensity: f32 }
@group(0) @binding(0) var<uniform> fog: Fog;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, fog.fogDensity, 1.0);
}
`;

const WALLS = `
@group(0) @binding(0) var detail: texture_2d<f32>;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureLoad(detail, vec2u(0, 0), 0);
}
`;

const OBJECTS = `
struct Globals { tint: f32 }
struct Obj { value: f32 }
@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> obj: Obj;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(obj.value * globals.tint, uv, 1.0);
}
`;

test("R3 bundle replay stays valid after JS value writes and stales on bind-group identity changes", async () => {
  const gpu = await init({ size: [4, 4] });
  const scene = gpu.target({ size: [4, 4] });
  const tex1 = gpu.target({ size: [4, 4] });
  const tex2 = gpu.target({ size: [4, 4] });
  const floor = gpu.pass(FLOOR, { label: "floor", set: { fogDensity: 0.1 } });
  const walls = gpu.pass(WALLS, { label: "walls" });
  walls.set({ detail: tex1 });

  const staticScene = gpu.bundle({ target: scene, label: "staticScene" }, (b) => {
    b.draw(floor);
    b.draw(walls);
  });

  floor.set({ fogDensity: 0.2 });
  expect(() => gpu.frame((f) => f.pass({ target: scene }, (p) => p.bundles(staticScene)))).not.toThrow();

  walls.set({ detail: tex2 });
  expect(() => gpu.frame((f) => f.pass({ target: scene }, (p) => p.bundles(staticScene)))).toThrowError(
    "bundle 'staticScene' está stale: el binding `detail` (@group(0) @binding(0)) del draw\n" +
      "  'walls' cambió de recurso después de la grabación. Los bundles congelan comandos y bind groups.\n" +
      "  Fix: re-grabalo → staticScene = gpu.bundle({ target: scene }, ...)\n" +
      "  (la re-grabación es siempre tuya; la lib solo detecta).",
  );
  gpu.dispose();
});

test("R4 claimed groups reject set() and per-draw offsets reach setBindGroup", async () => {
  const gpu = await init({ size: [4, 4] });
  const target = gpu.target({ size: [4, 4] });
  const cube = gpu.draw({ shader: OBJECTS, label: "cube", set: { globals: { tint: 1 } } });
  const offsets: readonly number[][] = [];
  const originalCreateCommandEncoder = gpu.device.gpu.createCommandEncoder.bind(gpu.device.gpu);
  vi.spyOn(gpu.device.gpu, "createCommandEncoder").mockImplementation((desc?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(desc);
    return {
      ...encoder,
      beginRenderPass(passDesc: GPURenderPassDescriptor) {
        const pass = encoder.beginRenderPass(passDesc);
        return {
          ...pass,
          setBindGroup(index: number, bindGroup: GPUBindGroup | null, dynamicOffsets?: readonly number[]) {
            if (index === 1 && dynamicOffsets) offsets.push([...dynamicOffsets]);
            pass.setBindGroup(index, bindGroup, dynamicOffsets);
          },
        } as GPURenderPassEncoder;
      },
    } as GPUCommandEncoder;
  });
  const pool = new UniformPool(gpu.device, { capacityBytes: 1024 });
  const slot = pool.alloc({
    size: 4,
    bindGroupLayout: cube.layout(1, { dynamicOffsets: true }),
    encode(value: number, dst: ArrayBuffer, byteOffset: number) { new DataView(dst).setFloat32(byteOffset, value, true); },
  });

  const staticBuffer = gpu.device.createBuffer({ size: 4, usage: ["uniform"] });
  const staticLayout = createBindGroupLayout(gpu.device, {
    label: "staticLayout",
    entries: [bind.uniform(0, "fragment", { minBindingSize: 4 })],
  });
  const staticBindGroup = createBindGroup(gpu.device, {
    label: "staticBindGroup",
    layout: staticLayout,
    entries: [bind.resource(0, staticBuffer)],
  });
  expect(() => cube.group(1, staticBindGroup)).toThrowError(
    "el grupo 1 reclamado en draw 'cube' no es compatible: @binding(0) no coincide con el layout reflejado.",
  );

  cube.group(1, slot.bindGroup);
  expect(() => cube.set({ obj: { value: 1 } })).toThrowError(
    "el grupo 1 de 'cube' fue reclamado con group(1, bindGroup); no se puede usar set() sobre ese grupo.",
  );

  pool.beginFrame(1);
  const offset = pool.push(slot, 3);
  gpu.frame((f) => f.pass({ target }, (p) => p.draw(cube, { offsets: { 1: [offset] } })));

  expect(offsets).toEqual([[offset]]);
  gpu.dispose();
});
