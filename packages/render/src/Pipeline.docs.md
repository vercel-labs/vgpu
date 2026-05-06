# Pipeline

`Pipeline` is the opaque render pipeline handle for `@vgpu/render`. It wraps a
`GPURenderPipeline` and keeps render pipeline creation focused on the inputs
needed to draw: a WGSL shader module, vertex entry point, fragment entry point,
color target formats, optional primitive state, optional layout, and an
optional label.

`createRenderPipeline(device, options)` accepts:

- `shader`: a core `Shader` created from a raw WGSL string or `ResolvedShader`.
- `vertex.entry`: vertex function name.
- `fragment.entry`: fragment function name.
- `fragment.targets`: WebGPU color target states.
- `primitive`, `layout`, `label`: forwarded to WebGPU unchanged.

Invariants: pipeline creation does not perform reflection, bind layout
synthesis, or shader rewriting. The caller supplies entry-point names
explicitly. `.gpu` is available as an escape hatch for code that must touch raw
WebGPU, but higher-level render helpers should pass the `Pipeline` object.

Example:

```ts
const shader = device.createShader(wgslSource);
const pipeline = createRenderPipeline(device, {
  shader,
  vertex: { entry: "vs_main" },
  fragment: { entry: "fs_main", targets: [{ format: "rgba8unorm" }] },
  primitive: { topology: "triangle-list" },
});
```
