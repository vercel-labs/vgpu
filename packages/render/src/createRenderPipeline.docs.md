# createRenderPipeline

Creates a GPU render pipeline from a vgpu `Shader` plus vertex and fragment
entry points. Returns a raw `GPURenderPipeline` with no wrapper.

## Signature

`createRenderPipeline(device: Device, opts: RenderPipelineOptions): GPURenderPipeline`

## Options

- `shader`: the `Shader` whose compiled GPU module will back both stages.
- `vertex.entry`: the vertex shader entry-point name.
- `fragment.entry`: the fragment shader entry-point name.
- `fragment.targets`: the color target formats and blend/write settings.
- `primitive`: optional WebGPU primitive state such as topology or culling.
- `layout`: optional pipeline layout, or `"auto"` to let WebGPU derive one.
- `label`: optional debug label forwarded to WebGPU.

## Example

```ts
const pipeline = createRenderPipeline(device, {
  shader,
  vertex: { entry: "vs_main" },
  fragment: { entry: "fs_main", targets: [{ format: "rgba8unorm" }] },
  primitive: { topology: "triangle-list" },
});
```

## Notes

The returned `GPURenderPipeline` can be used directly with WebGPU APIs or
passed to `RenderPass.setPipeline`.
