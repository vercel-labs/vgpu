import { prepareShader } from "@vgpu/wgsl/prepare";
import { bindGroupCacheTestState } from "../../src/bind-cache.ts";
import { drawCacheOwnerTestState, drawEncodeTestState, type InternalDraw } from "../../src/draw.ts";
import { setCoreTestState, type SetCore } from "../../src/set-core.ts";
import { draw, geometry, getMockGPUDeviceInstrumentation, init, target, type Buffer, type Draw } from "../../src/mock.ts";

type Gpu = Awaited<ReturnType<typeof init>>;

/** The issue #489 workload shader: three identity-bound uniform buffers, one per group. */
export const THREE_GROUPS = `struct Frame { viewProjection: mat4x4f }
struct Object { world: mat4x4f }
struct Material { color: vec4f }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> object: Object;
@group(2) @binding(0) var<uniform> material: Material;
@vertex fn vs_main(@location(0) position: vec3f) -> @builtin(position) vec4f { return frame.viewProjection * object.world * vec4f(position, 1); }
@fragment fn fs_main() -> @location(0) vec4f { return material.color; }`;

export const uniformBuffer = (gpu: Gpu, size: number, label?: string): Buffer => gpu.device.createBuffer({ size, usage: ["uniform", "copy_dst"], label });

/** N draws sharing the group 0 and 2 buffers, each with a private group 1 buffer, on one depth target. */
export function issueWorkload(gpu: Gpu, count = 4, shader = prepareShader(THREE_GROUPS, "encode.wgsl")) {
  const frameBuffer = uniformBuffer(gpu, 64, "frame");
  const materialBuffer = uniformBuffer(gpu, 16, "material");
  const mesh = geometry(gpu, { buffers: [{ data: new Float32Array(9), stride: 12, attributes: { position: { format: "float32x3", offset: 0, location: 0 } } }], vertexCount: 3 });
  const out = target(gpu, { size: [8, 8], depth: true });
  const objects = Array.from({ length: count }, (_, index) => uniformBuffer(gpu, 64, `object${index}`));
  const draws = objects.map((object, index) => draw(gpu, { shader, geometry: mesh, label: `draw${index}`, set: { frame: frameBuffer, object, material: materialBuffer } }));
  return { frameBuffer, materialBuffer, mesh, out, objects, draws, shader };
}

/** Every per-encode work counter the unchanged hot path must leave untouched, summed over the consumers. */
export function hotPathCounters(gpu: Gpu, draws: readonly Draw[], cores: readonly SetCore[] = []) {
  const all = [...draws.map((item) => drawCacheOwnerTestState(item as InternalDraw)), ...cores.map(setCoreTestState)];
  const cache = bindGroupCacheTestState(all[0]!.cache);
  const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
  const sum = (read: (index: number) => number) => all.reduce((total, _, index) => total + read(index), 0);
  return {
    maintenanceVisits: cache.lifetime.maintenanceVisits,
    targetedVisits: cache.lifetime.targetedVisits,
    records: cache.lifetime.records,
    bindingKeyBuilds: cache.bindingKeyBuilds,
    fullVerifications: sum((index) => all[index]!.stats.fullVerifications),
    groupPlanBuilds: sum((index) => all[index]!.stats.groupPlanBuilds),
    pipelineKeyDerivations: draws.reduce((total, item) => total + drawEncodeTestState(item as InternalDraw).pipelineKeyDerivations, 0),
    createBindGroup: mock.calls.createBindGroup,
    createRenderPipeline: mock.calls.createRenderPipeline,
    createCommandEncoder: mock.calls.createCommandEncoder,
  };
}

export type HotPathCounters = ReturnType<typeof hotPathCounters>;

export function delta(before: HotPathCounters, after: HotPathCounters): HotPathCounters {
  return Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - before[key as keyof HotPathCounters]])) as HotPathCounters;
}

export const ZERO_WORK: Omit<HotPathCounters, "createCommandEncoder"> = {
  maintenanceVisits: 0,
  targetedVisits: 0,
  records: 0,
  bindingKeyBuilds: 0,
  fullVerifications: 0,
  groupPlanBuilds: 0,
  pipelineKeyDerivations: 0,
  createBindGroup: 0,
  createRenderPipeline: 0,
};

/**
 * Records the bind groups each render pass binds (in order) and the descriptor each bind group was
 * created from, so a test can read the uniform bytes a draw actually bound.
 */
export function recordBindings(gpu: Gpu) {
  const descriptors = new Map<GPUBindGroup, GPUBindGroupDescriptor>();
  const bound: { group: number; bindGroup: GPUBindGroup }[] = [];
  const device = gpu.gpu;
  const createBindGroup = device.createBindGroup.bind(device);
  device.createBindGroup = (descriptor) => {
    const created = createBindGroup(descriptor);
    descriptors.set(created, descriptor);
    return created;
  };
  const createCommandEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = (descriptor) => {
    const encoder = createCommandEncoder(descriptor);
    const beginRenderPass = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = (passDescriptor) => {
      const pass = beginRenderPass(passDescriptor);
      const setBindGroup = pass.setBindGroup.bind(pass);
      pass.setBindGroup = ((group: number, bindGroup: GPUBindGroup, ...rest: unknown[]) => {
        bound.push({ group, bindGroup });
        return (setBindGroup as (...args: unknown[]) => void)(group, bindGroup, ...rest);
      }) as GPURenderPassEncoder["setBindGroup"];
      return pass;
    };
    return encoder;
  };
  /** First f32 of the buffer range bound at `group` by the most recent setBindGroup for that group. */
  const lastFloat = (group: number, element = 0): number => {
    const last = bound.findLast((entry) => entry.group === group);
    const resource = [...descriptors.get(last!.bindGroup)!.entries][0]!.resource as GPUBufferBinding;
    const bytes = (resource.buffer as unknown as { __vgpuMockBytes: Uint8Array }).__vgpuMockBytes;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32((resource.offset ?? 0) + element * 4, true);
  };
  return { bound, descriptors, lastFloat };
}
