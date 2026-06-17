# createRenderPipeline / createRenderPipelineAsync

Creates a GPU render pipeline from descriptor-like VGPU options. Both helpers
return a raw `GPURenderPipeline` with no wrapper so the result can be passed
directly to native WebGPU, `RenderPass.setPipeline()`, or render-bundle recording.

## Signatures

```ts
createRenderPipeline(device: Device, opts: RenderPipelineOptions): GPURenderPipeline
createRenderPipelineAsync(device: Device, opts: RenderPipelineOptions): Promise<GPURenderPipeline>
createRenderPipelineFromDescriptor(device: Device, descriptor: GPURenderPipelineDescriptor): GPURenderPipeline
createRenderPipelineFromDescriptorAsync(device: Device, descriptor: GPURenderPipelineDescriptor, fallback?: RenderPipelineAsyncFallback): Promise<GPURenderPipeline>
```

`createRenderPipelineAsync` calls `GPUDevice.createRenderPipelineAsync()` when it
exists. If the implementation does not expose the async API, the default
compatibility policy is `fallback: "sync"`, which emits a once-only diagnostic and
calls `createRenderPipeline()` instead. Performance-critical warmup can pass
`fallback: "throw"` to receive a structured `VGPUError` with code
`VGPU-RENDER-PIPELINE-ASYNC-UNAVAILABLE` instead of accidentally blocking.

## Raw descriptor entrypoints

If you already have a hand-built `GPURenderPipelineDescriptor`, pass it straight
through — do not reshape it into `RenderPipelineOptions` just to get the
async→sync fallback:

- `createRenderPipelineFromDescriptor(device, descriptor)` forwards the descriptor
  to `GPUDevice.createRenderPipeline()` unchanged.
- `createRenderPipelineFromDescriptorAsync(device, descriptor, fallback?)` forwards
  it to `GPUDevice.createRenderPipelineAsync()` with the exact same compatibility
  fallback as `createRenderPipelineAsync` (default `"sync"`, or `"throw"` for a
  structured `VGPUError`).

The descriptor is forwarded verbatim, so native WebGPU validation and lifecycle
rules remain the caller's responsibility. These are explicit, separately named
exports rather than an overload so a `RenderPipelineOptions` caller can never be
misread as passing a raw descriptor.

VGPU does not cache pipelines: one helper call equals one WebGPU device call.
Keep pipeline caches explicit and owned by the caller.

## Options

- `shader`: optional shared `Shader` or raw `GPUShaderModule` used by stages that
  do not provide their own module.
- `vertex`: vertex stage options.
  - `shader` / `module`: optional per-stage `Shader` or raw `GPUShaderModule`.
  - `entry` / `entryPoint`: vertex entry-point name.
  - `buffers`: optional vertex buffer layouts and attributes.
  - `constants`: optional pipeline constants.
- `fragment`: optional fragment stage options.
  - `shader` / `module`: optional per-stage `Shader` or raw `GPUShaderModule`.
  - `entry` / `entryPoint`: fragment entry-point name.
  - `targets`: color target formats plus blend and write-mask state.
  - `constants`: optional pipeline constants.
- `primitive`: optional WebGPU primitive state.
- `depthStencil`: optional depth/stencil state.
- `multisample`: optional multisample state.
- `layout`: explicit `GPUPipelineLayout`, or `"auto"`. Defaults to `"auto"`.
- `label`: optional debug label forwarded to WebGPU.
- `fallback`: async-only fallback policy, `"sync"` or `"throw"`.

## Examples

Shared VGPU `Shader` module:

```ts
const pipeline = await createRenderPipelineAsync(device, {
  label: "hero.pipeline",
  fallback: "throw",
  shader,
  layout: explicitPipelineLayout,
  vertex: {
    entry: "vs_main",
    buffers: [{
      arrayStride: 16,
      attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }],
    }],
  },
  fragment: {
    entry: "fs_main",
    targets: [{
      format,
      blend: {
        color: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        alpha: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      },
      writeMask: 0xf,
    }],
  },
  primitive: { topology: "triangle-list", cullMode: "back" },
  depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  multisample: { count: 4 },
});
```

Raw shader modules and per-stage constants:

```ts
const pipeline = createRenderPipeline(device, {
  layout: "auto",
  vertex: { module: vertexModule, entryPoint: "vs", constants: { scale: 2 } },
  fragment: { module: fragmentModule, entryPoint: "fs", targets: [{ format }] },
});
```

Existing raw `GPURenderPipelineDescriptor`, only wanting the async fallback:

```ts
const descriptor: GPURenderPipelineDescriptor = {
  label: "hero.pipeline",
  layout: pipelineLayout,
  vertex: { module: shaderModule, entryPoint: "vs_main", buffers },
  fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format }] },
  primitive: { topology: "triangle-list" },
};

const pipeline = await createRenderPipelineFromDescriptorAsync(device, descriptor, "throw");
```

## Raw escape hatch

`Shader.gpu` is an intentional advanced escape hatch to the underlying
`GPUShaderModule`. It is part of VGPU's public API surface and should be treated
as semver-protected, but direct native WebGPU usage remains responsible for
native WebGPU validation and lifecycle rules.
