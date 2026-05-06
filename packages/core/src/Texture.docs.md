# Texture

`Texture` is the core opaque GPU texture object created by
`device.createTexture(...)`. It wraps a `GPUTexture`, tracks the S2 creation
options, and provides deterministic `rgba8unorm` readback for snapshot tests.

`TextureOptions` contains:

- `size`: `[width, height, depthOrArrayLayers?]`.
- `format`: currently readback-supported for `"rgba8unorm"`.
- `usage`: texture usage names such as `"render_attachment"` and `"copy_src"`.
- `label`: optional WebGPU label.

Invariants: `read()` only supports `rgba8unorm` in S2 and throws structured
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
