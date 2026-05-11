## Unreleased

### Minor
- @vgpu/wgsl: Add `deps` field to `resolveShader` result; add `onDependency` callback option to `transformWgsl`. Foundation for HMR / watch-mode support in webpack/vite loaders (PR2).

## 0.0.1 — 2026-05-07

First public preview. API will shift before 0.1.0.

### Shipped
- @vgpu/core: device, buffer, texture, shader, queue, app primitives
- @vgpu/render: render pipeline + render pass + bind group helpers
- @vgpu/wgsl: WGSL compile + runtime resolve + webpack/vite loaders
- @vgpu/adapter-mock: mock GPU adapter for tests
- @vgpu/adapter-node: Node.js GPU adapter (Dawn-backed, linux-arm64 prebuilts)

### Known limitations
- Single-color render targets only (MRT lands in 0.1.0)
- No texture sampling helpers yet (lands in 0.1.0)
- API is unstable; expect breaking changes before 0.1.0
