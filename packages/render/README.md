# @vgpu/render

> 0.0.5 — early preview

`@vgpu/render` is the small rendering layer on top of `@vgpu/core`. It focuses on explicit WebGPU-style control: create pipelines, encode standalone render passes, or build one frame command encoder with multiple user-ordered passes.

## Install

```bash
pnpm add @vgpu/render
```

## Exports

### Runtime
- `createRenderPipeline`
- `RenderPass`
- `beginFrame` / `Frame`
- `createRenderBundle` / `RenderBundleRecorder`

### Types
- `RenderPipelineOptions`
- `ColorAttachment`
- `DepthStencilAttachment`
- `RenderPassOptions`
- `RenderPassDrawOptions`
- `RenderPassDynamicOffsets`
- `FrameOptions`
- `RenderBundleOptions`

## Standalone pass

```ts
import { App } from "@vgpu/core";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { createRenderPipeline, RenderPass } from "@vgpu/render";

const { device } = await App.create({ adapter: createMockAdapter() });
const shader = device.createShader(`
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(0.0, 0.5), vec2f(-0.5, -0.5), vec2f(0.5, -0.5));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.2, 0.6, 1.0, 1.0); }
`);
const target = device.createTexture({ size: [64, 64], format: "rgba8unorm", usage: ["render_attachment", "copy_src"] });
const pipeline = createRenderPipeline(device, {
  shader,
  vertex: { entry: "vs_main" },
  fragment: { entry: "fs_main", targets: [{ format: "rgba8unorm" }] },
});
const pass = new RenderPass(device, {
  colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
});
pass.setPipeline(pipeline);
pass.draw(3);
pass.end(); // finishes and submits this one-shot pass
```

## Explicit multipass frame

Render bundles are setup-time reusable draw packets, not hidden passes or a render graph:

```ts
import { beginFrame, createRenderBundle } from "@vgpu/render";

const bundle = createRenderBundle(device, {
  label: "hero.light-sources.bundle",
  colorFormats: ["rgba8unorm"],
  depthStencilFormat: "depth24plus",
  sampleCount: 1,
  record(bundle) {
    bundle.setPipeline(lightPipeline);
    bundle.setBindGroup(0, lightBindGroup);
    bundle.draw(lightVertexCount);
  },
});
```

Native WebGPU multipass code uses one command encoder, explicit pass begin/end calls, then one finish/submit:

```ts
const encoder = device.gpu.createCommandEncoder({ label: "hero.frame" });

const lightPass = encoder.beginRenderPass(lightPassDescriptor);
lightPass.executeBundles([bundle]);
lightPass.end();

encoder.writeTimestamp(querySet, 0);
encoder.copyBufferToBuffer(srcBuffer, 0, dstBuffer, 0, byteLength);

const compositePass = encoder.beginRenderPass(compositePassDescriptor);
compositePass.setPipeline(compositePipeline);
compositePass.setBindGroup(0, compositeBindGroup);
compositePass.draw(3);
compositePass.end();

device.queue.gpu.submit([encoder.finish()]);
```

With VGPU `Frame`, the lifecycle is the same but pass end and final submission are harder to get wrong:

```ts
const frame = beginFrame(device, { label: "hero.frame" });
frame.renderPass(lightPassDescriptor, (pass) => {
  pass.executeBundles([bundle]);
});
frame.gpu.writeTimestamp(querySet, 0);
frame.copyBufferToBuffer(srcBuffer, dstBuffer, byteLength);
frame.renderPass(compositePassDescriptor, (pass) => {
  pass.setPipeline(compositePipeline);
  pass.setBindGroup(0, compositeBindGroup);
  pass.draw(3);
});
frame.submit(); // finishes once and submits once
```

`Frame` preserves authored ordering and exposes its raw `GPUCommandEncoder` as `frame.gpu` for advanced commands. Direct raw encoder calls follow WebGPU behavior; VGPU helper methods guard use after `submit()` with `VGPU-FRAME-SUBMITTED`.

## License

MIT.
