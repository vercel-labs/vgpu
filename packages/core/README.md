# @vgpu/core

> 0.1.0 — early preview

`@vgpu/core` is the runtime foundation for vgpu. It gives you a small wrapper layer around WebGPU devices, queues, buffers, textures, and shader modules, plus an `App.create()` entry point that asks an adapter for a device and returns a compact app instance. In 0.1.0 the goal is portability and a minimal public surface, not a fully opinionated engine.

## Install

```bash
pnpm add @vgpu/core
```

## Exports

### Classes
- `App`
- `Buffer`
- `Device`
- `Queue`
- `Shader`
- `Texture`
- `VGPUError`
- `ValidationError`

### Functions
- `bind`
- `createBindGroupLayout`
- `createPipelineLayout`
- `createBindGroup`
- `createSampler`
- `createMockGPUDevice`

### Types
- `AppCreateOptions`
- `AppInstance`
- `VGPUAdapter`
- `BufferOptions`
- `BufferUsageName`
- `BufferWriteData`
- `TextureOptions`
- `TextureUsageName`
- `CreateDeviceOptions`
- `BindVisibility`
- `CreateBindGroupLayoutOptions`
- `CreatePipelineLayoutOptions`
- `CreateBindGroupOptions`
- `DeviceLike`
- `ShaderInput`

## Usage

```ts
import { App } from "@vgpu/core";
import { createMockAdapter } from "@vgpu/adapter-mock";

const { device } = await App.create({ adapter: createMockAdapter() });
const data = new Float32Array([1, 2, 3, 4]);
const buffer = device.createBuffer({
  size: data.byteLength,
  usage: ["copy_dst", "copy_src", "storage"],
});

buffer.write(data);
const copy = new Float32Array(await buffer.read(data.byteLength));
device.destroy();
```

Explicit binding helpers keep layout control in user code without WGSL reflection or
`layout: "auto"`:

```ts
import { bind, createBindGroupLayout } from "@vgpu/core";

const sceneLayout = createBindGroupLayout(device, {
  entries: [bind.uniform(0, "vertex|fragment")],
});
```

The `.gpu` property is an unmanaged raw WebGPU escape hatch for APIs that VGPU
does not wrap yet. Prefer wrapper lifecycle methods (`buffer.destroy()`,
`texture.destroy()`, `device.destroy()`) instead of destroying `.gpu` directly.

## License

MIT.
