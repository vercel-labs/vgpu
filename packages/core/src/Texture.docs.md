# Texture

`Texture` is the core opaque GPU texture object created by
`device.createTexture(...)`. It wraps a `GPUTexture`, tracks the creation
options, and provides deterministic `rgba8unorm` readback for snapshot tests.

`TextureOptions` contains:

- `size`: `[width, height, depthOrArrayLayers?]`.
- `format`: currently readback-supported for `"rgba8unorm"` and `"rgba8unorm-srgb"`.
- `usage`: texture usage names such as `"render_attachment"` and `"copy_src"`.
- `mipLevelCount`: optional WebGPU mip level count. Defaults to `1` when omitted.
- `sampleCount`: optional WebGPU sample count. Defaults to `1` when omitted.
- `dimension`: optional WebGPU texture dimension. Defaults to `"2d"` when omitted.
- `viewFormats`: optional additional WebGPU texture view formats.
- `label`: optional WebGPU label.

Invariants: `read()` only supports `rgba8unorm` and throws structured
`VGPU-CORE-UNSUPPORTED-FORMAT` for unsupported formats. `createView(...)`
forwards to the raw texture. `destroy()` is idempotent; after destroy, `read()`
throws because the texture is no longer alive.

Example:

```ts
const target = device.createTexture({
  size: [256, 256],
  format: "rgba8unorm",
  usage: ["render_attachment", "copy_src"],
});
const pixels = await target.read();
```

Native WebGPU descriptors map directly to VGPU texture options. VGPU keeps the
API descriptor-first: provide the explicit fields you want rather than relying
on hidden usage inference or upload helpers.

Native WebGPU:

```ts
const texture = gpuDevice.createTexture({
  size: { width: 1024, height: 1024, depthOrArrayLayers: 1 },
  format: "rgba8unorm",
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  mipLevelCount: 5,
  dimension: "2d",
  viewFormats: ["rgba8unorm-srgb"],
});
```

VGPU:

```ts
const texture = device.createTexture({
  size: [1024, 1024, 1],
  format: "rgba8unorm",
  usage: ["texture_binding", "render_attachment"],
  mipLevelCount: 5,
  dimension: "2d",
  viewFormats: ["rgba8unorm-srgb"],
});
```
