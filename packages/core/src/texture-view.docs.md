# cubeView and layerView

`cubeView(texture, { compat })` and `layerView(texture, layer)` create explicit `GPUTextureView`s for cubemap and array-layer workflows. They are free functions so they work with both VGPU `Texture` objects and raw `GPUTexture`s from WebGPU APIs.

## cubeView

`cubeView(texture, { compat, label? })` creates a sampleable view over a whole six-face cubemap texture.

The `compat` flag is required because it must match your WGSL binding type:

- `compat: false` creates a WebGPU `dimension: "cube"` view for shaders that bind `texture_cube<f32>`.
- `compat: true` creates a `dimension: "2d-array"` view for shaders that bind `texture_2d_array<f32>`.

Compatibility mode is not auto-detected inside `cubeView`. The same boolean selects both the texture view dimension and the shader variant, so callers must make the decision explicitly. Pin `compat: true` if you want one `texture_2d_array` shader variant that works on core and compatibility devices; otherwise pass `device.isCompatibilityMode` when selecting both the view and the WGSL binding variant.

`cubeView` throws `ValidationError` unless the texture has exactly six array layers.

```text
import { cubeView } from "@vgpu/core";

const cubemap = device.createTexture({
  size: [1024, 1024, 6],
  format: "rgba8unorm",
  usage: ["texture_binding", "render_attachment"],
});

const view = cubeView(cubemap, {
  compat: device.isCompatibilityMode,
  label: "skybox.sample",
});
```

## layerView

`layerView(texture, layer, opts?)` creates a plain `dimension: "2d"` view over one array layer. Use it for cubemap face render targets, array-slice blits, and per-mip prefilter passes.

When `opts.mipLevel` is provided, the view pins `baseMipLevel` to that level and sets `mipLevelCount: 1`, which is the shape render attachments require. `format`, `aspect`, and `label` forward to the native texture view descriptor.

```text
import { layerView } from "@vgpu/core";

for (let face = 0; face < 6; face++) {
  const view = layerView(cubemap, face, { mipLevel: 0, label: `skybox.face.${face}` });
  // Use view as a color attachment for this cubemap face.
}
```
