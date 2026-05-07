# @vgpu/render

> 0.0.1 — early preview

`@vgpu/render` is the small rendering layer on top of `@vgpu/core`. It currently focuses on two public building blocks: creating a render pipeline from a vgpu shader wrapper, and issuing a render pass against a texture or texture view. The package is intentionally narrow in 0.0.1 and leaves higher-level scene helpers for later releases.

## Install

```bash
pnpm add @vgpu/render
```

## Exports

### Runtime
- `createRenderPipeline`
- `RenderPass`

### Types
- `RenderPipelineOptions`
- `ColorAttachment`
- `RenderPassOptions`

## Usage

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
pass.end();
```

## License

MIT.
