# Explicit binding helpers

`bind`, `createBindGroupLayout`, `createPipelineLayout`, `createBindGroup`, and
`createSampler` are thin core helpers for explicit WebGPU resource binding. They
return raw WebGPU objects and never infer layouts from WGSL, reflect shaders, or
force `layout: "auto"`.

Use explicit numeric bindings to keep control over shader ABI, pipeline layout
compatibility, and performance-sensitive bind group reuse. This implementation is
positional/array-only; named binding maps are intentionally deferred in this
slice, so there is no `bind.named()` helper and every entry keeps an explicit
numeric `binding`.

Sampler creation is also intentionally explicit. This slice does not add sampler
presets such as `linear-clamp`; pass the full descriptor you want to
`createSampler(...)` (or `device.createSampler(...)`) instead.

## Native WebGPU

```ts
const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
const sceneLayout = device.createBindGroupLayout({
  label: "scene.bindings",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
  ],
});
const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [sceneLayout] });
const bindGroup = device.createBindGroup({
  layout: sceneLayout,
  entries: [
    { binding: 0, resource: { buffer: uniformBuffer } },
    { binding: 1, resource: sourceTexture.createView() },
    { binding: 2, resource: sampler },
  ],
});
```

## VGPU helpers

```ts
import { bind, createBindGroup, createBindGroupLayout, createPipelineLayout, createSampler } from "@vgpu/core";

const sampler = createSampler(device, { minFilter: "linear", magFilter: "linear" });
const sceneLayout = createBindGroupLayout(device, {
  label: "scene.bindings",
  entries: [
    bind.uniform(0, "vertex|fragment"),
    bind.texture(1, "fragment", { sampleType: "float" }),
    bind.sampler(2, "fragment", { type: "filtering" }),
  ],
});
const pipelineLayout = createPipelineLayout(device, { bindGroups: [sceneLayout] });
const bindGroup = createBindGroup(device, {
  layout: sceneLayout,
  entries: [
    bind.resource(0, uniformBuffer),
    bind.resource(1, sourceTexture),
    bind.resource(2, sampler),
  ],
});
```

`createBindGroup` requires an explicit `layout`. This helper is intentionally not
render-specific and imports only `@vgpu/core` primitives.

`bind.resource(...)` unwraps VGPU `Buffer` to `{ buffer: buffer.gpu }`, VGPU
`Texture` to `texture.createView()`, accepts raw `GPUBuffer`, `GPUTextureView`,
`GPUSampler`, and passes through raw `GPUBindingResource` values.

## `.gpu` escape hatch and lifecycle

`.gpu` exposes the unmanaged raw WebGPU object for APIs VGPU does not wrap yet,
feature probes, and advanced or niche calls. Prefer wrapper lifecycle methods:
`texture.destroy()`, `buffer.destroy()`, and `device.destroy()`. Avoid calling
`texture.gpu.destroy()` or `buffer.gpu.destroy()` directly because wrappers keep
lifecycle state and test mocks in sync.
