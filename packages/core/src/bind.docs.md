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

Sampler creation is intentionally a thin descriptor helper. `createSampler(...)`
accepts every raw `GPUSamplerDescriptor` field and adds two orthogonal shorthand
keys for the repeated cases: `filter` for `magFilter`/`minFilter`, and `wrap` for
`addressModeU`/`addressModeV`/`addressModeW`. There are no sampler preset strings
such as `linear-clamp`; keep per-call details like `label`, raw overrides, and
`mipmapFilter` in the descriptor you pass.

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

const sampler = createSampler(device, { filter: "linear", wrap: "clamp" });
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

## `createSampler` shorthand

`createSampler(device, descriptor)` accepts a `SamplerDescriptorWithSugar`, which
is a normal `GPUSamplerDescriptor` plus two optional shorthand keys:

- `filter?: "linear" | "nearest"` expands to both `magFilter` and `minFilter`.
  It deliberately does **not** set `mipmapFilter`.
- `wrap?: "clamp" | "repeat" | "mirror"` expands to `addressModeU`,
  `addressModeV`, and `addressModeW`. The values map to WebGPU as `"clamp"` →
  `"clamp-to-edge"`, `"repeat"` → `"repeat"`, and `"mirror"` →
  `"mirror-repeat"`.

Sugar expands first, then raw WebGPU descriptor fields win per key. This means
`{ filter: "linear", magFilter: "nearest" }` creates a sampler with
`minFilter: "linear"` and `magFilter: "nearest"`; likewise raw
`addressModeU`/`addressModeV`/`addressModeW` values override the matching `wrap`
axis. The `filter` and `wrap` keys are removed before calling
`device.createSampler(...)`.

```ts
const blurSampler = createSampler(device, {
  label: "bloom.sampler",
  filter: "linear",
  wrap: "clamp",
});

const mixedSampler = createSampler(device, {
  filter: "linear",
  wrap: "clamp",
  magFilter: "nearest", // raw field wins for this key only
});
```

Because `filter` does not set `mipmapFilter`, anisotropic sampling stays
explicit. WebGPU requires `magFilter`, `minFilter`, and `mipmapFilter` to all be
`"linear"` when `maxAnisotropy > 1`. vgpu fails loudly with a `ValidationError`
when sugar expansion would violate that rule:

```ts
// Throws: filter sets mag/min only; mipmapFilter remains the WebGPU default.
createSampler(device, { filter: "linear", maxAnisotropy: 16 });

// Valid: trilinear anisotropic sampling is explicit.
createSampler(device, { filter: "linear", mipmapFilter: "linear", maxAnisotropy: 16 });
```

Comparison samplers need no special casing. `compare` is a raw WebGPU field, and
sugar never sets or removes it:

```ts
const shadowSampler = createSampler(device, {
  filter: "linear",
  wrap: "clamp",
  compare: "less-equal",
});
```

## `.gpu` escape hatch and lifecycle

`.gpu` exposes the unmanaged raw WebGPU object for APIs VGPU does not wrap yet,
feature probes, and advanced or niche calls. Prefer wrapper lifecycle methods:
`texture.destroy()`, `buffer.destroy()`, and `device.destroy()`. Avoid calling
`texture.gpu.destroy()` or `buffer.gpu.destroy()` directly because wrappers keep
lifecycle state and test mocks in sync.
