# Texture

Creates a standalone sampleable/storage texture from the main API (`vgpu`). Use it when a shader needs a texture that is not a render target: compute-written storage textures, 3D lookup tables, texture arrays, or mipmapped inputs. Render outputs still use `target(gpu)`.

## Import

```ts
import type { Texture, TextureOptions, TextureReadOptions, TextureShape, TextureUsageName } from "vgpu";
import { init, texture } from "vgpu/mock";
```

## Signature

```ts
import type { Texture } from "vgpu";
import type { Gpu } from "vgpu";

type TextureUsageName = "copy_src" | "copy_dst" | "texture_binding" | "storage_binding" | "render_attachment";

type TextureShape =
  | { readonly kind: "1d"; readonly size: readonly [width: number]; readonly layers?: never }
  | { readonly kind: "2d"; readonly size: readonly [width: number, height: number]; readonly layers?: never }
  | { readonly kind: "3d"; readonly size: readonly [width: number, height: number, depth: number]; readonly layers?: never }
  | { readonly kind: "2d-array"; readonly size: readonly [width: number, height: number]; readonly layers: number };

type TextureOptions = TextureShape & {
  readonly format: GPUTextureFormat;
  readonly usage: readonly [TextureUsageName, ...TextureUsageName[]];
  readonly mipLevelCount?: number;
  readonly sampleCount?: 1 | 4;
  readonly viewFormats?: readonly GPUTextureFormat[];
  readonly label?: string;
};

declare function texture(gpu: Gpu, opts: TextureOptions): Texture;

interface TextureReadOptions {
  readonly mipLevel: number;
  readonly region: "all" | {
    readonly origin: readonly [number, number, number];
    readonly size: readonly [number, number, number];
  };
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| opts.kind | `TextureShape["kind"]` | ✔ | — | Explicit `"1d"`, `"2d"`, `"3d"` or `"2d-array"`. |
| opts.size | `TextureShape["size"]` | ✔ | — | Positive safe integers; one, two or three spatial dimensions according to kind. Arrays use two. |
| opts.layers | `number` | For arrays | — | Required positive integer for `"2d-array"`; forbidden for other kinds. |
| opts.format | `GPUTextureFormat` | ✔ | — | Must support the requested usages with the device's enabled features. Native WebGPU performs full per-format validation. |
| opts.usage | `readonly [TextureUsageName, ...TextureUsageName[]]` | ✔ | — | Nonempty list. No sampling, storage or copy flags are added implicitly. |
| opts.mipLevelCount | `number` | ✖ | `1` | Extra levels are not generated; write them from compute or copies. |
| opts.sampleCount | `1 \| 4` | ✖ | `1` | MSAA needs a 2D render attachment with one mip and no storage usage. No automatic resolve. |
| opts.viewFormats | `readonly GPUTextureFormat[]` | ✖ | `[]` | Explicit compatible alternate view formats; no conversion or automatic expansion. |
| opts.label | `string` | ✖ | `undefined` | Used for the GPU texture label and in error `where` fields. |

**Returns:** `Texture` from the core layer — bind it with `set({ name: texture })`, read it back with `texture.read({ mipLevel: 0, region: "all" })`, and release it with `texture.destroy()`. Sampled bindings (`texture_2d<f32>`, `texture_3d<f32>`, `texture_2d_array<f32>`) accept it when `usage` includes `texture_binding`; storage bindings (`texture_storage_2d<...>`, `texture_storage_3d<...>`) accept it when `usage` includes `storage_binding`.

**Throws:** `VGPU-TEXTURE-SIZE-REQUIRED` when `size` is missing or has a non-positive entry — pass `[width, height]` or `[width, height, depth]`; `VGPU-TEXTURE-STORAGE-FORMAT` when `usage` includes `storage_binding` and `format` is not storage-capable — pick a storage-capable format or pass `usage` without `storage_binding`.

## Examples

```ts
import { compute, effect, init, sampler, texture } from "vgpu/mock";

const gpu = await init();
// 32x32x32 rgba16float lookup table written by compute and sampled by a fragment shader.
const lut = texture(gpu, { kind: "3d", size: [32, 32, 32], format: "rgba16float", usage: ["storage_binding", "texture_binding"], label: "lut" });

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
// Uploadable and sampled, with no storage or readback capability requested.
const atlas = texture(gpu, { kind: "2d-array", size: [256, 256], layers: 8, format: "bgra8unorm", usage: ["texture_binding", "copy_dst"] });
atlas.destroy();
```

### Write a selected mip from compute

Binding a `Texture` directly to a storage slot selects mip 0. To write another allocated mip,
bind a native view that selects exactly one level:

```ts
import { compute, init, texture } from "vgpu/mock";

const gpu = await init();
const image = texture(gpu, {
  kind: "2d", size: [8, 8], format: "rgba16float", mipLevelCount: 2,
  usage: ["storage_binding", "copy_src"],
});
const fill = compute(gpu, `
  @group(0) @binding(0) var dst: texture_storage_2d<rgba16float, write>;
  @compute @workgroup_size(1)
  fn main(@builtin(global_invocation_id) id: vec3u) {
    textureStore(dst, id.xy, vec4f(1.0));
  }
`, { set: { dst: image.createView({ baseMipLevel: 1, mipLevelCount: 1 }) } });
fill.dispatch(4, 4); // Mip 1 of an 8x8 texture is 4x4.
const pixels = await image.readFloats({ mipLevel: 1, region: "all" });
gpu.dispose();
```

This is a raw `GPUTextureView`, not a managed view. It bypasses wrapper-aware binding validation and
lifetime tracking; native WebGPU validates the view. Keep its parent texture alive, and recreate/rebind
the view (and re-record any bundles that captured it) after replacing the parent. No automatic mip
generation or content preservation occurs.

## Notes

- Texture structure is fixed: there is no `Texture.resize()`. Create a replacement, call `set()` with it and destroy the old resource. Tracked sampled/storage bindings throw `VGPU-R1-BINDING-DESTROYED` with the binding and resource context on subsequent use; already-recorded bundles become stale and must be re-recorded.
- `set({ src: target })` follows successful Target attachment replacement. `set({ src: target.color })` retains that exact texture and must be updated after resize. Raw views and direct native destruction bypass parent-aware diagnostics; native WebGPU validation remains the fallback.
- `TextureOptions`, `TextureReadOptions`, `TextureShape` and `TextureUsageName` are re-exported from core through `vgpu`, `vgpu/node` and `vgpu/mock`. Their canonical documentation is the core `Texture` page. Both creation paths use the same validation; `texture(gpu, opts)` additionally registers ownership with `gpu`. Options and nested arrays are copied and frozen. Array `.size` stays `[width, height]`; `.layers` reports the separate count. `.dimension` remains the derived native WebGPU dimension for interop.
- Default views follow kind: a one-layer `"2d-array"` still has an array view. Use an explicit `createView({ dimension: "2d", arrayLayerCount: 1 })` or `layerView` when a layer needs a plain 2D view.
- Storage texture bindings are validated at `set()` time: the texture must carry `storage_binding` usage, its `format` must equal the format declared in WGSL, and its shape must match the binding (`texture_storage_3d` needs `kind: "3d"`). Mismatches throw `VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE` with a fix-it naming the expected value.
- A `Target` cannot satisfy a storage texture binding; render attachments are not storage textures. Write into `texture(gpu)` from compute and sample it from the render pass instead.
- Direct `Texture` storage bindings select mip level `0`. A native `createView({ baseMipLevel, mipLevelCount: 1 })` can select another allocated level; see the example and raw-view lifetime limitations above.
- `rgba32float`, `rg32float`, and `r32float` textures need the `float32-filterable` feature for `textureSample`; prefer `rgba16float` for lookup tables that are sampled with a filtering sampler.
- **See also:** `target`, `compute`, `Compute.set`, `Texture` from `vgpu/core`.
