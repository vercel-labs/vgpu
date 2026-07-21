import { afterEach, expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { reflectSource } from "@vgpu/wgsl/reflect-source";
import { init } from "../src/mock.ts";

const RENDER = `
@group(0) @binding(0) var<storage, read> fragmentData: array<u32>;
@group(0) @binding(1) var<uniform> vertexData: vec4f;
@group(0) @binding(2) var<uniform> shared: vec4f;
@group(0) @binding(3) var<storage, read> unused: array<u32>;
@vertex fn vs() -> @builtin(position) vec4f { return vertexData + shared * 0.0; }
@fragment fn fs() -> @location(0) vec4f { return vec4f(f32(fragmentData[0])) + shared; }
`;

const COMPUTE = `
@group(0) @binding(0) var<storage, read> used: array<u32>;
@group(0) @binding(1) var<storage, read> unused: array<u32>;
@compute @workgroup_size(1) fn main() { let value = used[0]; }
`;

afterEach(() => vi.restoreAllMocks());

function entries(gpu: Awaited<ReturnType<typeof init>>, label: string): readonly GPUBindGroupLayoutEntry[] {
  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createBindGroupLayoutDescriptors.find((item) => item.label === `${label}.group0.bgl`);
  if (!desc) throw new Error(`missing ${label} layout`);
  return [...desc.entries];
}

test("render visibility unions only selected entry static uses and retains unused bindings", async () => {
  const gpu = await init();
  const draw = gpu.draw({ shader: RENDER, label: "visible" });
  expect(entries(gpu, "visible").map(({ binding, visibility }) => [binding, visibility])).toEqual([[0, 2], [1, 1], [2, 3]]);

  draw.layout(0, { dynamicOffsets: true });
  const dynamic = getMockGPUDeviceInstrumentation(gpu.device.gpu).createBindGroupLayoutDescriptors.find((item) => item.label === "visible.group0.dynamic.bgl")!;
  expect([...dynamic.entries].map(({ binding, visibility }) => [binding, visibility])).toEqual([[0, 2], [1, 1], [2, 3]]);
  gpu.dispose();
});

test("compute visibility is selected-entry driven and leaves unused declarations at zero", async () => {
  const gpu = await init();
  gpu.compute(COMPUTE, { label: "compute-visible" });
  expect(entries(gpu, "compute-visible").map(({ binding, visibility }) => [binding, visibility])).toEqual([[0, 4]]);
  gpu.dispose();
});

test("fragment-only storage succeeds with a zero vertex-stage storage limit", async () => {
  const gpu = await init();
  Object.defineProperty(gpu.device.gpu, "limits", { value: { ...gpu.device.limits, maxStorageBuffersInVertexStage: 0, maxStorageBuffersInFragmentStage: 4 } });
  gpu.draw({ shader: RENDER, label: "limit-zero" });
  expect(entries(gpu, "limit-zero")[0]?.visibility).toBe(2);
  gpu.dispose();
});

test("true vertex storage throws structured error before native BGL creation", async () => {
  const gpu = await init();
  Object.defineProperty(gpu.device.gpu, "limits", { value: { ...gpu.device.limits, maxStorageBuffersInVertexStage: 0, maxStorageBuffersInFragmentStage: 4 } });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  const shader = `
    @group(0) @binding(0) var<storage, read> positions: array<vec4f>;
    @vertex fn vs() -> @builtin(position) vec4f { return positions[0]; }
    @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }
  `;
  expect(() => gpu.draw({ shader, label: "too-many" })).toThrow(expect.objectContaining({
    code: "VGPU-LIMIT-STORAGE-VERTEX",
    where: "too-many.pipelineLayout",
    detail: { stage: "vertex", entryPoint: "vs", count: 1, limit: 0, bindings: [{ name: "positions", group: 0, binding: 0 }] },
  }));
  expect(mock.calls.createBindGroupLayout).toBe(0);
  gpu.dispose();
});

test("unused declarations stay reflected but are omitted from layouts and never required", async () => {
  const gpu = await init();
  const shader = `
    @group(0) @binding(0) var<storage, read> unused: array<u32>;
    @vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }
    @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }
  `;
  const draw = gpu.draw({ shader, label: "unused-layout" });
  const reflection = reflectSource(shader);
  expect(reflection.bindings.map(({ name }) => name)).toEqual(["unused"]);
  expect(reflection.entryPoints.map(({ bindings }) => bindings)).toEqual([[], []]);
  expect(getMockGPUDeviceInstrumentation(gpu.device.gpu).createBindGroupLayoutDescriptors.find((item) => item.label === "unused-layout.group0.bgl")).toBeUndefined();
  const target = gpu.target({ size: [1, 1] });
  expect(() => gpu.frame((frame) => frame.pass(target, (pass) => pass.draw(draw)))).not.toThrow();
  gpu.dispose();
});

test("two used storage buffers exceed a limit of one while unused storage does not count", async () => {
  const gpu = await init();
  Object.defineProperty(gpu.device.gpu, "limits", { value: { ...gpu.device.limits, maxStorageBuffersInVertexStage: 1 } });
  const shader = `
    @group(0) @binding(0) var<storage, read> a: array<vec4f>;
    @group(0) @binding(1) var<storage, read> b: array<vec4f>;
    @group(0) @binding(2) var<storage, read> unused: array<vec4f>;
    @vertex fn vs() -> @builtin(position) vec4f { return a[0] + b[0]; }
    @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }
  `;
  expect(() => gpu.draw({ shader, label: "two-storage" })).toThrow(expect.objectContaining({
    code: "VGPU-LIMIT-STORAGE-VERTEX",
    message: "Vertex entry 'vs' in 'two-storage' uses 2 storage buffer(s), but device limit maxStorageBuffersInVertexStage is 1.",
    fix: "Request init({ requiredLimits: { maxStorageBuffersInVertexStage: 2 } }) if the adapter supports it, or move vertex data to gpu.mesh(...) vertex streams.",
    detail: expect.objectContaining({ count: 2, limit: 1, bindings: [
      { name: "a", group: 0, binding: 0 }, { name: "b", group: 0, binding: 1 },
    ] }),
  }));
  gpu.dispose();
});

test("stage-specific missing limits fall back to maxStorageBuffersPerShaderStage", async () => {
  const gpu = await init();
  Object.defineProperty(gpu.device.gpu, "limits", { value: { maxStorageBuffersPerShaderStage: 0 } });
  expect(() => gpu.draw({ shader: RENDER, label: "fallback-limit" })).toThrow(expect.objectContaining({
    code: "VGPU-LIMIT-STORAGE-FRAGMENT",
    detail: expect.objectContaining({ limit: 0 }),
  }));
  gpu.dispose();
});

test("fragment storage limit reports the fragment sibling code", async () => {
  const gpu = await init();
  Object.defineProperty(gpu.device.gpu, "limits", { value: { ...gpu.device.limits, maxStorageBuffersInVertexStage: 8, maxStorageBuffersInFragmentStage: 0 } });
  expect(() => gpu.draw({ shader: RENDER, label: "fragment-limit" })).toThrow(expect.objectContaining({
    code: "VGPU-LIMIT-STORAGE-FRAGMENT",
    detail: expect.objectContaining({ stage: "fragment", entryPoint: "fs", count: 1, limit: 0 }),
  }));
  gpu.dispose();
});
