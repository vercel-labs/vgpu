import { expect, test, vi } from "vitest";
import { bind, createBindGroup, createBindGroupLayout } from "@vgpu/core";
import { UniformPool } from "../../src/core.ts";
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
  const gpu = await init();
  const scene = gpu.target({ size: [4, 4] });
  const tex1 = gpu.target({ size: [4, 4] });
  const tex2 = gpu.target({ size: [4, 4] });
  const floor = gpu.effect(FLOOR, { label: "floor", set: { fogDensity: 0.1 } });
  const walls = gpu.effect(WALLS, { label: "walls" });
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

test("R3 bundle sampling a resized target stales through binding identity", async () => {
  const gpu = await init();
  const scene = gpu.target({ size: [4, 4] });
  const source = gpu.target({ size: [4, 4] });
  const post = gpu.effect(WALLS, { label: "post", set: { detail: source } });

  const bundle = gpu.bundle({ target: scene, label: "postBundle" }, (b) => {
    b.draw(post);
  });

  source.resize([8, 8]);

  expect(() => gpu.frame((f) => f.pass({ target: scene }, (p) => p.bundles(bundle)))).toThrowError(
    "bundle 'postBundle' está stale: el binding `detail` (@group(0) @binding(0)) del draw\n" +
      "  'post' cambió de recurso después de la grabación. Los bundles congelan comandos y bind groups.\n" +
      "  Fix: re-grabalo → postBundle = gpu.bundle({ target: scene }, ...)\n" +
      "  (la re-grabación es siempre tuya; la lib solo detecta).",
  );
  gpu.dispose();
});

test("R4 raw claim validation stays attributed when frames overlap", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const popResolvers: ((error: GPUError | null) => void)[] = [];
  const gpuDevice = gpu.device.gpu as GPUDevice & {
    pushErrorScope(filter: GPUErrorFilter): void;
    popErrorScope(): Promise<GPUError | null>;
  };
  gpuDevice.pushErrorScope = vi.fn();
  gpuDevice.popErrorScope = vi.fn(() => new Promise<GPUError | null>((resolve) => popResolvers.push(resolve)));

  const cubeA = rawClaimedDraw(gpu, "cubeA");
  const cubeB = rawClaimedDraw(gpu, "cubeB");

  const frameA = gpu.frame();
  frameA.pass({ target }, (p) => p.draw(cubeA, { offsets: { 1: [0] } }));
  expect(popResolvers).toHaveLength(2); // pipeline sync-create scope, then R4 raw-claim scope.
  const frameB = gpu.frame();
  frameB.pass({ target }, (p) => p.draw(cubeB, { offsets: { 1: [0] } }));
  expect(popResolvers).toHaveLength(3); // cubeB reuses the device pipeline; only its R4 raw-claim scope is new.

  const errors: unknown[] = [];
  gpu.onError((error) => errors.push(error));

  frameB.submit();
  frameA.submit();

  popResolvers[0]!(null);
  popResolvers[1]!({ message: "first frame validation" } as GPUError);
  popResolvers[2]!({ message: "second frame validation" } as GPUError);
  for (const resolve of popResolvers.slice(3)) resolve(null);

  await frameA.done;
  await frameB.done;
  await gpu.settled();

  expect(errors).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: "VGPU-R4-GROUP-VALIDATION",
      message: expect.stringContaining("grupo 1 reclamado en draw 'cubeA'"),
      where: "cubeA.draw",
      detail: { drawLabel: "cubeA", group: 1 },
    }),
    expect.objectContaining({
      code: "VGPU-R4-GROUP-VALIDATION",
      message: expect.stringContaining("grupo 1 reclamado en draw 'cubeB'"),
      where: "cubeB.draw",
      detail: { drawLabel: "cubeB", group: 1 },
    }),
  ]));

  gpu.dispose();
});

function rawClaimedDraw(gpu: Awaited<ReturnType<typeof init>>, label: string) {
  const cube = gpu.draw({ shader: OBJECTS, label, set: { globals: { tint: 1 } } });
  const rawBuffer = gpu.device.gpu.createBuffer({ size: 4, usage: 64 });
  const rawLayout = gpu.device.gpu.createBindGroupLayout({
    label: `${label}.raw-static-layout`,
    entries: [{ binding: 0, visibility: 2, buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: 4 } }],
  });
  const rawBindGroup = gpu.device.gpu.createBindGroup({
    label: `${label}.raw-static-bind-group`,
    layout: rawLayout,
    entries: [{ binding: 0, resource: { buffer: rawBuffer, offset: 0, size: 4 } }],
  });
  cube.layout(1, { dynamicOffsets: true });
  cube.group(1, rawBindGroup);
  return cube;
}

test("R4 claimed groups reject set() and per-draw offsets reach setBindGroup", async () => {
  const gpu = await init();
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
