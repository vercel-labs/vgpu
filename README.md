# vgpu

> ⚠️ **0.1.0 — early preview. API remains unstable before 1.0.**

Agentic-first WebGPU library. Run the same code on Node (Dawn), the web (browser WebGPU), and serverless platforms with linux-arm64 prebuilts. vgpu keeps the surface area small in 0.1.0: core device and resource primitives, a thin render layer, WGSL tooling, and adapters for real Node runtimes or deterministic tests.

## Packages

| Package | What it is |
| --- | --- |
| [`@vgpu/core`](./packages/core/README.md) | Core runtime primitives for devices, buffers, textures, shaders, queues, and app bootstrapping. |
| [`@vgpu/render`](./packages/render/README.md) | Minimal render-pipeline, `Frame`, render-bundle, and `RapidRenderer` helpers; `RapidRenderer` is for simple draws/examples, not production multipass or bundle-heavy hot paths. |
| [`@vgpu/wgsl`](./packages/wgsl/README.md) | WGSL compile helpers plus runtime resolution and webpack/vite integration points. |
| [`@vgpu/wgsl-std`](./packages/wgsl-std/README.md) | Standard WGSL utility modules for math, color, and sampling helpers. |
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

- ✅ **In 0.1.0**
  - device / buffer / texture / shader primitives
  - render pipeline + render pass
  - WGSL compile + loaders for webpack and vite
  - node and mock adapters
- 🚧 **Coming next**
  - MRT (multiple render targets)
  - texture sampling helpers
  - post-process passes
  - mesh edit operators
  - geometry primitives library
- ❌ **Not yet planned**
  - examples gallery
  - full typedoc site

## Releasing

Releases are triggered by **GitHub Releases** — no bot commits or version-package PRs required.

### Steps

1. **Bump versions** across all published packages:
   ```bash
   pnpm bump:patch    # 0.0.1 → 0.0.2
   # or
   pnpm bump:minor    # 0.0.1 → 0.1.0
   pnpm bump:major    # 0.0.1 → 1.0.0
   ```
2. **Commit + push** the version bumps to `main` (via PR if branch protection requires).
3. **Create a GitHub Release** at https://github.com/vercel-labs/vgpu/releases/new
   - **Tag**: e.g. `v0.0.2` (target: `main`)
   - **Title**: e.g. `v0.0.2 — short summary`
   - **Notes**: describe what changed; you can use **Generate release notes** to draft from merged PRs since the last release
   - Click **Publish release**
4. The `Release` workflow will:
   - Check out the tag
   - Install dependencies
   - Build all packages
   - Run fast tests
   - Publish all packages to npm via Trusted Publishing with provenance attestation

The first auto-published version after the manual bootstrap will show a **Provenance** badge on each package's npm page proving it was built and signed by GitHub Actions.

### Trusted Publishing setup

Trusted Publishing is already configured on npm for each `@vgpu/*` package with:
- Repository: `vercel-labs/vgpu`
- Workflow filename: `release.yml`
- Environment: none

If you ever add a new `@vgpu/*` package, publish it manually once, then add the same Trusted Publisher entry pointing at `release.yml`.

## License

MIT — see [LICENSE](./LICENSE).

## Status & roadmap

Track the early architecture and API work in [issue #7](https://github.com/vercel-labs/vgpu/issues/7) and [issue #17](https://github.com/vercel-labs/vgpu/issues/17).
