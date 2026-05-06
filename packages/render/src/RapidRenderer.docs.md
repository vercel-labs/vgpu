# RapidRenderer

`RapidRenderer` is a direct draw entry point for code that already has a
compiled render pipeline and a render target view. Construct it with a core
`Device`, then call `draw(spec)` to clear the target, bind the pipeline, draw
vertices, end the render pass, and submit the command buffer.

## Signature

```ts
const renderer = new RapidRenderer(device);
await renderer.draw({ pipeline, target, vertexCount: 3 });
```

`renderer.gpu` returns the underlying `GPUDevice` for callers that need raw
WebGPU access.

## DrawSpec

`DrawSpec` contains:

- `pipeline`: a raw `GPURenderPipeline`, such as one returned by
  `createRenderPipeline()`.
- `target`: a raw `GPUTextureView` to render into.
- `vertexCount`: the number of vertices to draw.
- `clearValue`: optional `GPUColor`; when omitted, the target is cleared to
  opaque black.

`draw(spec)` returns a `Promise<void>` that resolves after commands have been
submitted. It does not wait for GPU completion.

Example:

```ts
const pipeline = createRenderPipeline(device, {
  shader,
  vertex: { entry: "vs_main" },
  fragment: { entry: "fs_main", targets: [{ format: "rgba8unorm" }] },
  primitive: { topology: "triangle-list" },
});

const renderer = new RapidRenderer(device);
await renderer.draw({ pipeline, target: texture.createView(), vertexCount: 3 });
```
