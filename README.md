# vgpu

> ⚠️ **0.0.1 — early preview. API will shift before 0.1.0.**

Agentic-first WebGPU library. Run the same code on Node (Dawn), the web (browser WebGPU), and serverless platforms with linux-arm64 prebuilts. vgpu keeps the surface area small in 0.0.1: core device and resource primitives, a thin render layer, WGSL tooling, and adapters for real Node runtimes or deterministic tests.

## Packages

| Package | What it is |
| --- | --- |
| [`@vgpu/core`](./packages/core/README.md) | Core runtime primitives for devices, buffers, textures, shaders, queues, and app bootstrapping. |
| [`@vgpu/render`](./packages/render/README.md) | Minimal render-pipeline and render-pass helpers built on top of `@vgpu/core`. |
| [`@vgpu/wgsl`](./packages/wgsl/README.md) | WGSL compile helpers plus runtime resolution and webpack/vite integration points. |
| [`@vgpu/adapter-mock`](./packages/adapter-mock/README.md) | Mock adapter for tests and local validation without real GPU hardware. |
| [`@vgpu/adapter-node`](./packages/adapter-node/README.md) | Node.js adapter backed by Dawn WebGPU bindings, including linux-arm64 prebuilt support. |

## Install

```bash
pnpm add @vgpu/core @vgpu/render @vgpu/wgsl
# plus an adapter:
pnpm add @vgpu/adapter-node    # Node.js / serverless
# or @vgpu/adapter-mock for tests
```

## Quickstart

```ts
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { createRenderPipeline, RenderPass } from "@vgpu/render";
import { compile } from "@vgpu/wgsl";

const TRIANGLE_WGSL = `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2f, 3>(vec2f(0.0, 0.5), vec2f(-0.5, -0.5), vec2f(0.5, -0.5));
  var colors = array<vec3f, 3>(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0));
  var out: VSOut;
  out.pos = vec4f(positions[vi], 0.0, 1.0);
  out.color = colors[vi];
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
`;

const { device } = await App.create({ adapter: createNodeAdapter() });
const target = device.createTexture({
  size: [256, 256],
  format: "rgba8unorm",
  usage: ["render_attachment", "copy_src"],
});
const shader = device.createShader(compile(TRIANGLE_WGSL));
const pipeline = createRenderPipeline(device, {
  shader,
  vertex: { entry: "vs_main" },
  fragment: { entry: "fs_main", targets: [{ format: "rgba8unorm" }] },
  primitive: { topology: "triangle-list" },
});
const pass = new RenderPass(device, {
  colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
});

pass.setPipeline(pipeline);
pass.draw(3);
pass.end();

const pixels = await target.read();
device.destroy();
```

## Capability matrix

- ✅ **In 0.0.1**
  - device / buffer / texture / shader primitives
  - render pipeline + render pass
  - WGSL compile + loaders for webpack and vite
  - node and mock adapters
- 🚧 **Coming in 0.1.0**
  - MRT (multiple render targets)
  - texture sampling helpers
  - post-process passes
  - mesh edit operators
  - geometry primitives library
- ❌ **Not yet planned**
  - examples gallery
  - full typedoc site

## License

MIT — see [LICENSE](./LICENSE).

## Status & roadmap

Track the early architecture and API work in [issue #7](https://github.com/vercel-labs/vgpu/issues/7) and [issue #17](https://github.com/vercel-labs/vgpu/issues/17).
