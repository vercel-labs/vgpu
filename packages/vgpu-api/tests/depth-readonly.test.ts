import { expect, test, vi } from "vitest";
import { init, bundle, draw, effect, frame, target } from "../src/mock.ts";

const DRAW_SHADER = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const DEPTH_SAMPLING_SHADER = `
@group(0) @binding(0) var depthTex: texture_depth_2d;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(textureLoad(depthTex, vec2i(0), 0)); }
`;

test("depthReadOnly marks the depth attachment read-only and omits its ops", async () => {
  const gpu = await init();
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2], depth: true });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true }, () => undefined));

  const attachment = descriptors[0]?.depthStencilAttachment;
  expect(attachment).toMatchObject({ depthReadOnly: true });
  expect(attachment?.depthLoadOp).toBeUndefined();
  expect(attachment?.depthStoreOp).toBeUndefined();
  expect(attachment?.depthClearValue).toBeUndefined();
  // Depth-only formats must not mark a stencil aspect they do not have.
  expect(attachment?.stencilReadOnly).toBeUndefined();
  expect(attachment?.stencilLoadOp).toBeUndefined();
  expect(attachment?.stencilStoreOp).toBeUndefined();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("depthReadOnly on combined formats marks the stencil aspect read-only too", async () => {
  const gpu = await init();
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true }, () => undefined));

  const attachment = descriptors[0]?.depthStencilAttachment;
  expect(attachment).toMatchObject({ depthReadOnly: true, stencilReadOnly: true });
  expect(attachment?.depthLoadOp).toBeUndefined();
  expect(attachment?.depthStoreOp).toBeUndefined();
  expect(attachment?.stencilLoadOp).toBeUndefined();
  expect(attachment?.stencilStoreOp).toBeUndefined();
  expect(attachment?.stencilClearValue).toBeUndefined();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("color attachments still clear normally alongside depthReadOnly", async () => {
  const gpu = await init();
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2], depth: true });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true, clear: [0.5, 0, 0, 1] }, () => undefined));
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true, clear: false }, () => undefined));

  const colors = [...(descriptors[0]?.colorAttachments ?? [])];
  expect(colors[0]).toMatchObject({ loadOp: "clear", clearValue: { r: 0.5, g: 0, b: 0, a: 1 } });
  expect(descriptors[0]?.depthStencilAttachment).toMatchObject({ depthReadOnly: true });
  const preserved = [...(descriptors[1]?.colorAttachments ?? [])];
  expect(preserved[0]).toMatchObject({ loadOp: "load" });
  gpu.dispose();
  vi.restoreAllMocks();
});

test("depthReadOnly false behaves like a normal writable pass", async () => {
  const gpu = await init();
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2], depth: true });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: false, clearDepth: 0 }, () => undefined));

  expect(descriptors[0]?.depthStencilAttachment).toMatchObject({ depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 0 });
  expect(descriptors[0]?.depthStencilAttachment?.depthReadOnly).toBeUndefined();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("a depth-writing draw is rejected in a depthReadOnly pass", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: true });
  const defaultDepth = draw(gpu, { shader: DRAW_SHADER, label: "writes-by-default" });
  const explicitWrite = draw(gpu, { shader: DRAW_SHADER, label: "writes-explicitly", depth: { write: true, compare: "greater" } });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true }, (pass) => pass.draw(defaultDepth))))
    .toThrowError(/VGPU-PASS-DEPTH-READONLY|write: false/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true }, (pass) => pass.draw(explicitWrite))))
    .toThrowError(/VGPU-PASS-DEPTH-READONLY|write: false/);
  gpu.dispose();
});

test("non-writing draws encode in a depthReadOnly pass", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: true });
  const testOnly = draw(gpu, { shader: DRAW_SHADER, label: "test-only", depth: { write: false, compare: "less-equal" } });
  const depthOff = draw(gpu, { shader: DRAW_SHADER, label: "depth-off", depth: false });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true }, (pass) => {
    pass.draw(testOnly);
    pass.draw(depthOff);
  }))).not.toThrow();
  gpu.dispose();
});

test("stencil-writing draws are rejected on combined formats, keep-only draws encode", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  const writes = draw(gpu, { shader: DRAW_SHADER, label: "stencil-writes", depth: { write: false }, stencil: { front: { pass: "replace" } } });
  const comparesOnly = draw(gpu, { shader: DRAW_SHADER, label: "stencil-compares", depth: { write: false }, stencil: { front: { compare: "equal" }, ref: 1 } });
  const maskedOff = draw(gpu, { shader: DRAW_SHADER, label: "stencil-masked", depth: { write: false }, stencil: { front: { pass: "replace" }, writeMask: 0 } });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true }, (pass) => pass.draw(writes))))
    .toThrowError(/VGPU-PASS-DEPTH-READONLY|pass: "replace"/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true }, (pass) => {
    pass.draw(comparesOnly);
    // writeMask 0 mirrors the spec's [[writesStencil]]: ops cannot write masked-off bits.
    pass.draw(maskedOff);
  }))).not.toThrow();
  gpu.dispose();
});

test("culled stencil faces do not count as stencil writes", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  // Only the front face has writing ops and it is culled; the explicit back face keeps everything.
  const culledFront = draw(gpu, { shader: DRAW_SHADER, label: "culled-front", cull: "front", depth: { write: false }, stencil: { front: { pass: "replace" }, back: {} } });
  // Same ops without culling must still be rejected.
  const unculled = draw(gpu, { shader: DRAW_SHADER, label: "unculled-front", depth: { write: false }, stencil: { front: { pass: "replace" }, back: {} } });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true }, (pass) => pass.draw(culledFront)))).not.toThrow();
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true }, (pass) => pass.draw(unculled))))
    .toThrowError(/VGPU-PASS-DEPTH-READONLY|pass: "replace"/);
  gpu.dispose();
});

test("depthReadOnly contradiction rules throw at pass open", async () => {
  const gpu = await init();
  const depthTarget = target(gpu, { size: [2, 2], depth: true });
  const stencilTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  const colorOnly = target(gpu, { size: [2, 2] });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: depthTarget, depthReadOnly: true, clearDepth: 0 }, () => undefined)))
    .toThrowError(/VGPU-PASS-DEPTH-READONLY|clearDepth/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: stencilTarget, depthReadOnly: true, clearStencil: 1 }, () => undefined)))
    .toThrowError(/VGPU-PASS-DEPTH-READONLY|clearStencil/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorOnly, depthReadOnly: true }, () => undefined)))
    .toThrowError(/VGPU-PASS-DEPTH-READONLY|no depth attachment/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: depthTarget, depthReadOnly: "yes" as never }, () => undefined)))
    .toThrowError(/VGPU-PASS-DEPTH-READONLY|expected a boolean/);
  // depthReadOnly: false is inert; the dead-option rules do not apply.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorOnly, depthReadOnly: false }, () => undefined))).not.toThrow();
  gpu.dispose();
});

test("depthReadOnly is rejected on an MSAA target", async () => {
  const gpu = await init();
  const msaa = target(gpu, { size: [2, 2], depth: true, msaa: true });
  expect(msaa.sampleCount).toBe(4);

  // Multisampled depth is stored with storeOp "discard", so a read-only pass would depth-test
  // against discarded contents — silent garbage, not an error the driver reports.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: msaa, depthReadOnly: true }, () => undefined)))
    .toThrowError(/VGPU-PASS-DEPTH-READONLY-MSAA|storeOp "discard"/);
  // Symmetric to the clear:false rule on MSAA targets.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: msaa, clear: false }, () => undefined)))
    .toThrowError(/VGPU-PASS-PRESERVE-MSAA|cannot preserve MSAA/);
  // depthReadOnly: false stays inert on MSAA targets.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: msaa, depthReadOnly: false }, () => undefined))).not.toThrow();
  gpu.dispose();
});

test("clearDepth on a target without depth throws instead of being silently dropped", async () => {
  const gpu = await init();
  const colorOnly = target(gpu, { size: [2, 2] });
  const depthTarget = target(gpu, { size: [2, 2], depth: true });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorOnly, clearDepth: 0 }, () => undefined)))
    .toThrowError(/VGPU-PASS-CLEARDEPTH-INVALID|no depth attachment/);
  // Range and preserve rules still take precedence, and the same option is fine with depth.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorOnly, clearDepth: 2 }, () => undefined)))
    .toThrowError(/VGPU-PASS-CLEARDEPTH-INVALID|expected a number in \[0, 1\]/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: depthTarget, clearDepth: 0 }, () => undefined))).not.toThrow();
  gpu.dispose();
});

test("bundles cannot replay into a depthReadOnly pass", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: true });
  const drawable = draw(gpu, { shader: DRAW_SHADER, label: "bundled", depth: { write: false } });
  const recorded = bundle(gpu, { target: colorTarget }, (recorder) => recorder.draw(drawable));

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true }, (pass) => pass.bundles(recorded))))
    .toThrowError(/VGPU-PASS-DEPTH-READONLY|read-only/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, (pass) => pass.bundles(recorded)))).not.toThrow();
  gpu.dispose();
});

test("the pass target's depth texture can be sampled inside its own depthReadOnly pass", async () => {
  const gpu = await init();
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2], depth: true });
  expect(colorTarget.depth?.usage).toContain("texture_binding");

  const drawable = draw(gpu, { shader: DEPTH_SAMPLING_SHADER, label: "depth-sampler", depth: { write: false } });
  drawable.set({ depthTex: colorTarget.depth! });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true }, (pass) => pass.draw(drawable)))).not.toThrow();
  expect(descriptors[0]?.depthStencilAttachment).toMatchObject({ depthReadOnly: true });
  gpu.dispose();
  vi.restoreAllMocks();
});

test("effects keep the default depth write and are rejected in depthReadOnly passes", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: true });
  const shader1 = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }`);

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, depthReadOnly: true }, (pass) => pass.draw(shader1))))
    .toThrowError(/VGPU-PASS-DEPTH-READONLY|write: false/);
  gpu.dispose();
});

function spyRenderPassDescriptors(device: GPUDevice): GPURenderPassDescriptor[] {
  const descriptors: GPURenderPassDescriptor[] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    const originalBeginRenderPass = encoder.beginRenderPass.bind(encoder);
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        descriptors.push(renderPassDescriptor);
        return originalBeginRenderPass(renderPassDescriptor);
      },
    } as GPUCommandEncoder;
  });
  return descriptors;
}
