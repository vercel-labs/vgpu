import { prepareShader } from "@vgpu/wgsl/prepare";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { expect, test } from "vitest";
import { compute, draw, effect, frame, init, target, type FramePass } from "../src/mock.ts";
import {
  InternalDraw,
  drawBindingState,
  drawCacheOwnerTestState,
  drawGeometrySnapshot,
  drawLifecycleToken,
  drawReflection,
  drawResourceSnapshots,
  drawUsesBlendConstant,
  drawUsesStencilReference,
  registerDrawBundle,
  unregisterDrawBundle,
  type BundleBackReference,
} from "../src/draw.ts";
import { FRAME_DRAWABLE } from "../src/frame-protocols.ts";
import { effectDraw, InternalEffect } from "../src/effect.ts";
import { ComputePipeline } from "../src/compute.ts";
import { FRAME_COMPUTE } from "../src/frame-protocols.ts";

const DRAW_SHADER = `
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
`;

const EFFECT_SHADER = `
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
`;

const COMPUTE_SHADER = `
@compute @workgroup_size(1) fn main() {}
`;

const BOUND_DRAW_SHADER = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
${DRAW_SHADER}
`;

const BOUND_EFFECT_SHADER = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
${EFFECT_SHADER}
`;

const BOUND_COMPUTE_SHADER = `
struct Params { value: u32 }
@group(0) @binding(0) var<uniform> params: Params;
@compute @workgroup_size(1) fn main() { if (params.value == 0u) {} }
`;

test("Draw disposal is idempotent and guards set before argument validation", async () => {
  const gpu = await init();
  const drawable = draw(gpu, { shader: prepareShader(DRAW_SHADER), label: "retired-draw" });

  expect(() => drawable.dispose()).not.toThrow();
  expect(() => drawable.dispose()).not.toThrow();
  expect(() => drawable.set(null as never)).toThrowError(expect.objectContaining({
    code: "VGPU-DRAW-DISPOSED",
    message: "Draw 'retired-draw' has been disposed.",
    where: "retired-draw.set",
    fix: "Create a new draw(gpu, ...) or effect(gpu, ...); disposed render units cannot be reused.",
    detail: { label: "retired-draw" },
  }));

  gpu.dispose();
});

test("every Draw operation and inspection hook uses the disposed tombstone", async () => {
  const gpu = await init();
  const drawable = draw(gpu, { shader: prepareShader(DRAW_SHADER), label: "guarded-draw" }) as InternalDraw;
  const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
  const before = { ...mock.calls };
  const backReference: BundleBackReference = { id: "probe", markStale() {} };
  drawable.dispose();

  const operations: readonly [string, () => unknown][] = [
    ["gpu", () => drawable.gpu],
    ["targets", () => drawable.targets],
    ["group", () => drawable.group(-1, null as never)],
    ["layout", () => drawable.layout(-1, { dynamicOffsets: true })],
    ["draw", () => drawable.draw(null as never)],
    ["encode", () => drawable.encode(null as never, null as never, null as never)],
    ["compile", () => drawable.compile(null as never)],
    ["compileSync", () => drawable.compileSync(null as never)],
    ["pipelineFor", () => drawable.pipelineFor(null as never)],
    ["pipelineForAsync", () => drawable.pipelineForAsync(null as never)],
    ["drawable", () => drawable[FRAME_DRAWABLE]],
    ["writesDepth", () => drawable.writesDepth()],
    ["stencilWritingOps", () => drawable.stencilWritingOps()],
    ["reflection", () => drawReflection(drawable)],
    ["bindingState", () => drawBindingState(drawable, "missing")],
    ["resourceSnapshots", () => drawResourceSnapshots(drawable)],
    ["lifecycle", () => drawLifecycleToken(drawable)],
    ["geometry", () => drawGeometrySnapshot(drawable)],
    ["cacheOwner", () => drawCacheOwnerTestState(drawable)],
    ["blendConstant", () => drawUsesBlendConstant(drawable)],
    ["stencilReference", () => drawUsesStencilReference(drawable)],
    ["bundle", () => registerDrawBundle(drawable, backReference)],
    ["bundle", () => unregisterDrawBundle(drawable, backReference)],
  ];

  for (const [operation, invoke] of operations) {
    expect(invoke, operation).toThrowError(expect.objectContaining({
      code: "VGPU-DRAW-DISPOSED",
      where: `guarded-draw.${operation}`,
      detail: { label: "guarded-draw" },
    }));
  }
  expect(mock.calls).toEqual(before);
  gpu.dispose();
});

test("Effect delegates one Draw tombstone before normalizing arguments", async () => {
  const gpu = await init();
  const shader = effect(gpu, prepareShader(EFFECT_SHADER), { label: "retired-effect" }) as InternalEffect;
  shader.dispose();
  shader.dispose();

  const operations: readonly [string, () => unknown][] = [
    ["gpu", () => shader.gpu],
    ["set", () => shader.set(null as never)],
    ["draw", () => shader.draw(null as never)],
    ["compile", () => shader.compile(null as never)],
    ["compileSync", () => shader.compileSync(null as never)],
    ["encode", () => shader.encode(null as never, null as never, null as never)],
    ["drawable", () => shader[FRAME_DRAWABLE]],
    ["draw", () => effectDraw(shader)],
  ];
  for (const [operation, invoke] of operations) {
    expect(invoke, operation).toThrowError(expect.objectContaining({
      code: "VGPU-DRAW-DISPOSED",
      where: `retired-effect.${operation}`,
      detail: { label: "retired-effect" },
    }));
  }
  gpu.dispose();
});

test("Compute keeps only a guarded tombstone after disposal", async () => {
  const gpu = await init();
  const pipeline = compute(gpu, prepareShader(COMPUTE_SHADER), { label: "retired-compute" }) as ComputePipeline;
  const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
  const before = { ...mock.calls };
  pipeline.dispose();
  pipeline.dispose();

  const operations: readonly [string, () => unknown][] = [
    ["device", () => pipeline.device],
    ["reflection", () => pipeline.reflection],
    ["entryPoint", () => pipeline.entryPoint],
    ["setCore", () => pipeline.setCore],
    ["bindGroupLayouts", () => pipeline.bindGroupLayouts],
    ["pipelineLayout", () => pipeline.pipelineLayout],
    ["shaderModule", () => pipeline.shaderModule],
    ["pipeline", () => pipeline.pipeline],
    ["set", () => pipeline.set(null as never)],
    ["dispatch", () => pipeline.dispatch(null as never)],
    ["encode", () => pipeline.encode(null as never, null as never, undefined, undefined, [])],
    ["compile", () => pipeline.compile()],
    ["compileSync", () => pipeline.compileSync()],
    ["frame", () => pipeline[FRAME_COMPUTE]],
  ];
  for (const [operation, invoke] of operations) {
    expect(invoke, operation).toThrowError(expect.objectContaining({
      code: "VGPU-COMPUTE-DISPOSED",
      where: `retired-compute.${operation}`,
      detail: { label: "retired-compute" },
    }));
  }
  expect(mock.calls).toEqual(before);
  gpu.dispose();
});

test("consumer disposal remains idempotent after GPU teardown", async () => {
  const gpu = await init();
  const drawable = draw(gpu, { shader: prepareShader(DRAW_SHADER), label: "draw-after-gpu" });
  const fullscreen = effect(gpu, prepareShader(EFFECT_SHADER), { label: "effect-after-gpu" });
  const pipeline = compute(gpu, prepareShader(COMPUTE_SHADER), { label: "compute-after-gpu" });

  gpu.dispose();

  for (const consumer of [drawable, fullscreen, pipeline]) {
    expect(() => consumer.dispose()).not.toThrow();
    expect(() => consumer.dispose()).not.toThrow();
  }
  expect(() => drawable.set(null as never)).toThrowError(expect.objectContaining({ code: "VGPU-DRAW-DISPOSED" }));
  expect(() => pipeline.set(null as never)).toThrowError(expect.objectContaining({ code: "VGPU-COMPUTE-DISPOSED" }));
});

test("dispose is the only added consumer lifetime method", async () => {
  const gpu = await init();
  try {
    const consumers = [
      draw(gpu, { shader: prepareShader(DRAW_SHADER) }),
      effect(gpu, prepareShader(EFFECT_SHADER)),
      compute(gpu, prepareShader(COMPUTE_SHADER)),
    ];
    for (const consumer of consumers) {
      expect("destroy" in consumer).toBe(false);
      expect(Symbol.dispose in consumer).toBe(false);
    }
  } finally {
    gpu.dispose();
  }
});

test("outer frame and pass validity retain precedence over a disposed consumer", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [1, 1] });
    const drawable = draw(gpu, { shader: prepareShader(DRAW_SHADER) });
    const fullscreen = effect(gpu, prepareShader(EFFECT_SHADER), { label: "disposed-shorthand" });
    const canceled = frame(gpu);
    canceled.cancel();
    drawable.dispose();
    fullscreen.dispose();

    expect(() => canceled.pass(output, drawable)).toThrowError(expect.objectContaining({
      code: "VGPU-FRAME-CANCELED",
      where: "Frame.pass",
    }));
    expect(() => frame(gpu, current => current.pass(output, fullscreen))).toThrowError(expect.objectContaining({
      code: "VGPU-DRAW-DISPOSED",
      where: "disposed-shorthand.drawable",
    }));

    const live = draw(gpu, { shader: prepareShader(DRAW_SHADER) });
    let retainedPass!: FramePass;
    frame(gpu, current => current.pass(output, pass => { retainedPass = pass; }));
    live.dispose();
    expect(() => retainedPass.draw(live)).toThrowError(expect.objectContaining({
      code: "VGPU-FRAME-PASS-ACTIVE",
      where: "FramePass.draw",
    }));
  } finally {
    gpu.dispose();
  }
});

test("compilation remains valid before bindings are set", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [1, 1] });
    const drawable = draw(gpu, { shader: prepareShader(BOUND_DRAW_SHADER) });
    const fullscreen = effect(gpu, prepareShader(BOUND_EFFECT_SHADER));
    const pipeline = compute(gpu, prepareShader(BOUND_COMPUTE_SHADER));

    await expect(drawable.compile(output)).resolves.toBe(drawable);
    await expect(fullscreen.compile(output)).resolves.toBe(fullscreen);
    await expect(pipeline.compile()).resolves.toBe(pipeline);
  } finally {
    gpu.dispose();
  }
});
