# Texture

Creates a standalone sampleable/storage texture from the main API (`vgpu`). Use it when a shader needs a texture that is not a render target: compute-written storage textures, 3D lookup tables, texture arrays, or mipmapped inputs. Render outputs still use `target(gpu)`.

## Import

```ts
import type { Texture, TextureOptions, TextureUsageName } from "vgpu";
import { init, texture } from "vgpu/mock";
```

## Signature

```ts
import type { Texture } from "vgpu";
import type { Gpu } from "vgpu";

type TextureUsageName = "copy_src" | "copy_dst" | "texture_binding" | "storage_binding" | "render_attachment";

interface TextureOptions {
  readonly size: readonly [width: number, height: number, depthOrArrayLayers?: number];
  readonly format: GPUTextureFormat;
  readonly usage?: readonly TextureUsageName[];
  readonly dimension?: GPUTextureDimension;
  readonly mipLevelCount?: number;
  readonly label?: string;
}

declare function texture(gpu: Gpu, opts: TextureOptions): Texture;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| opts.size | `[width, height, depthOrArrayLayers?]` | ✔ | — | Integers `>= 1`. The third entry is the depth for `dimension: "3d"` and the layer count otherwise; omitted means `1`. |
| opts.format | `GPUTextureFormat` | ✔ | — | Any WebGPU format. With `storage_binding` usage it must be storage-capable: `rgba8unorm`, `rgba8snorm`, `rgba8uint`, `rgba8sint`, `rgba16float`, `rgba16uint`, `rgba16sint`, `rgba32float`, `rgba32uint`, `rgba32sint`, `r32float`, `r32uint`, `r32sint`, `rg32float`, `rg32uint`, `rg32sint`. |
| opts.usage | `TextureUsageName[]` | ✖ | `["texture_binding", "storage_binding", "copy_src", "copy_dst"]` | Pass an explicit list to drop `storage_binding` for formats that are not storage-capable (for example `bgra8unorm` or `rgb10a2unorm`). |
| opts.dimension | `GPUTextureDimension` | ✖ | `"2d"` | `"3d"` makes the third size entry a depth. With `"2d"` a third entry `> 1` creates a 2D array. |
| opts.mipLevelCount | `number` | ✖ | `1` | Extra levels are not generated; write them from compute or copies. |
| opts.label | `string` | ✖ | `undefined` | Used for the GPU texture label and in error `where` fields. |

**Returns:** `Texture` from the core layer — bind it with `set({ name: texture })`, read it back with `texture.read()`, and release it with `texture.destroy()`. Sampled bindings (`texture_2d<f32>`, `texture_3d<f32>`, `texture_2d_array<f32>`) accept it when `usage` includes `texture_binding`; storage bindings (`texture_storage_2d<...>`, `texture_storage_3d<...>`) accept it when `usage` includes `storage_binding`.

**Throws:** `VGPU-TEXTURE-SIZE-REQUIRED` when `size` is missing or has a non-positive entry — pass `[width, height]` or `[width, height, depth]`; `VGPU-TEXTURE-STORAGE-FORMAT` when `usage` includes `storage_binding` and `format` is not storage-capable — pick a storage-capable format or pass `usage` without `storage_binding`.

## Examples

```ts
import { compute, effect, init, sampler, texture } from "vgpu/mock";

const gpu = await init();
// 32x32x32 rgba16float lookup table written by compute and sampled by a fragment shader.
const lut = texture(gpu, { size: [32, 32, 32], format: "rgba16float", dimension: "3d", label: "lut" });

const fill = compute(gpu, `
  @group(0) @binding(0) var lut: texture_storage_3d<rgba16float, write>;
  @compute @workgroup_size(4, 4, 4)
  fn main(@builtin(global_invocation_id) id: vec3u) {
    textureStore(lut, id, vec4f(vec3f(id) / 31.0, 1.0));
  }
`, { label: "fill-lut", set: { lut } });
fill.dispatch(8, 8, 8);

const view = effect(gpu, `
  @group(0) @binding(0) var lut: texture_3d<f32>;
  @group(0) @binding(1) var linear: sampler;
  @fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSample(lut, linear, vec3f(uv, 0.5));
  }
`, { label: "view-lut", set: { lut, linear: sampler(gpu) } });
```

```ts
import { init, texture } from "vgpu/mock";

const gpu = await init();
// A sampled-only 2D array; storage_binding is dropped explicitly because the format is not storage-capable.
const atlas = texture(gpu, { size: [256, 256, 8], format: "bgra8unorm", usage: ["texture_binding", "copy_dst"] });
atlas.destroy();
```

## Notes

- Storage texture bindings are validated at `set()` time: the texture must carry `storage_binding` usage, its `format` must equal the format declared in WGSL, and its `dimension` must match the binding (`texture_storage_3d` needs `dimension: "3d"`; `texture_storage_2d` needs a 2D texture). Mismatches throw `VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE` with a fix-it naming the expected value.
- A `Target` cannot satisfy a storage texture binding; render attachments are not storage textures. Write into `texture(gpu)` from compute and sample it from the render pass instead.
- Storage views always bind mip level `0`. To fill other levels, create a second texture or copy with the core layer.
- `rgba32float`, `rg32float`, and `r32float` textures need the `float32-filterable` feature for `textureSample`; prefer `rgba16float` for lookup tables that are sampled with a filtering sampler.
- **See also:** `target`, `compute`, `Compute.set`, `Texture` from `vgpu/core`.
