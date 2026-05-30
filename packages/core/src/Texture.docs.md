# Texture

`Texture` is the core opaque GPU texture object created by
`device.createTexture(...)`. It wraps a `GPUTexture`, tracks the creation
options, and provides deterministic readback for snapshot tests. `rgba8unorm`
and `rgba8unorm-srgb` are supported for readback; prefer `rgba8unorm` for
deterministic snapshots unless a test specifically covers sRGB behavior.

`TextureOptions` contains:

- `size`: `[width, height, depthOrArrayLayers?]`.
- `format`: currently readback-supported for `"rgba8unorm"` and `"rgba8unorm-srgb"`.
- `usage`: texture usage names such as `"render_attachment"` and `"copy_src"`.
- `label`: optional WebGPU label.

Invariants: `read()` only supports the documented readback formats above and
throws structured `VGPU-CORE-UNSUPPORTED-FORMAT` for unsupported formats.
`createView(...)` forwards to the raw texture. `destroy()` is idempotent; after
destroy, `read()` throws because the texture is no longer alive. Prefer
`texture.destroy()` over `texture.gpu.destroy()` for VGPU-owned textures; `.gpu`
remains available as the raw WebGPU escape hatch for native interop.

Example:

```ts
const target = device.createTexture({
  size: [256, 256],
  format: "rgba8unorm",
  usage: ["render_attachment", "copy_src"],
});
const pixels = await target.read();
```
