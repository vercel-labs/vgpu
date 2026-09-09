# Texture

`Texture` is the core wrapper around a `GPUTexture`. Use it for explicit texture allocation through `Device.createTexture(...)`, cached default views, readback, and wrapper-aware teardown. Its allocation and resource identity are fixed for its lifetime; replace and rebind it to change size.

This is also the canonical reference for `TextureOptions`, `TextureReadOptions`, `TextureShape` and
`TextureUsageName`. These types are re-exported by `vgpu`, `vgpu/node` and `vgpu/mock`; the public
`texture(gpu, opts)` factory uses this same class and contract, with ownership registered on `gpu`.

## Import

```ts
import { Texture } from "vgpu/core";
```

## Signature

```ts
import type { Device, TextureOptions, TextureReadOptions, TextureShape } from "vgpu/core";

declare class Texture {
  constructor(device: Device, gpu: GPUTexture, options: TextureOptions, ownership?: "owned" | "external");
  get gpu(): GPUTexture;
  get options(): TextureOptions;
  get size(): TextureOptions["size"];
  get kind(): TextureShape["kind"];
  get layers(): number;
  get format(): GPUTextureFormat;
  get usage(): TextureOptions["usage"];
  get mipLevelCount(): number;
  get sampleCount(): 1 | 4;
  get dimension(): GPUTextureDimension;
  get viewFormats(): readonly GPUTextureFormat[];
  get label(): string | undefined;
  get view(): GPUTextureView;
  createView(desc?: GPUTextureViewDescriptor): GPUTextureView;
  read(options: TextureReadOptions): Promise<Uint8Array>;
  readFloats(options: TextureReadOptions): Promise<Float32Array>;
  destroy(): void;
  dispose(): void;
}
```

## Shared types

### TextureShape

The discriminated shape uses `kind: "1d"` with `[width]`, `"2d"` with `[width, height]`,
`"3d"` with `[width, height, depth]`, or `"2d-array"` with `[width, height]` and separate `layers`.
Only arrays accept `layers`. Narrow `texture.options.kind` to access shape-specific fields.

### TextureUsageName

The capability names are `"copy_src"`, `"copy_dst"`, `"texture_binding"`, `"storage_binding"` and
`"render_attachment"`. `TextureOptions.usage` requires at least one; no capability is inferred.

### TextureReadOptions

Both fields are required. Origins and extents are mip-relative texels; `"all"` includes every array
layer or 3D slice of the selected mip. Buffer reads are unchanged.

```ts
interface TextureReadOptions {
  readonly mipLevel: number;
  readonly region: "all" | {
    readonly origin: readonly [number, number, number];
    readonly size: readonly [number, number, number];
  };
}
```

## Parameters

### `Device.createTexture(opts)` / `TextureOptions`

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| opts.kind | `TextureShape["kind"]` | ✔ | — | `"1d"`, `"2d"`, `"3d"` or `"2d-array"`. Same contract as public `texture(gpu, opts)`. |
| opts.size | `TextureShape["size"]` | ✔ | — | `[width]` for 1D; `[width, height, depth]` for 3D; `[width, height]` for 2D and arrays. Positive safe integers. |
| opts.layers | `number` | For arrays | — | Required positive layer count for `"2d-array"`; forbidden otherwise. Array `.size` stays two-dimensional. `.layers` is 1 for non-array textures. |
| opts.format | `GPUTextureFormat` | ✔ | — | Forwarded to `GPUTextureDescriptor.format`. `read()`/`readFloats()` support the color formats listed under [Readback formats](#readback-formats). |
| opts.usage | `readonly [TextureUsageName, ...TextureUsageName[]]` | ✔ | — | Nonempty explicit capability list. No implicit flags. |
| opts.mipLevelCount | `number` | ✖ | WebGPU default (`1`) | Only included in the native descriptor when provided; getter returns `opts.mipLevelCount ?? 1`. |
| opts.sampleCount | `1 \| 4` | ✖ | WebGPU default (`1`) | Only included when provided; getter returns `opts.sampleCount ?? 1`. Use `4` for MSAA where WebGPU allows it. |
| opts.viewFormats | `readonly GPUTextureFormat[]` | ✖ | `[]` | Only included when provided; getter returns `opts.viewFormats ?? []`. |
| opts.label | `string` | ✖ | `undefined` | Forwarded to `GPUTextureDescriptor.label` and exposed via `texture.label`. |

Valid `TextureUsageName` values: `"copy_src"`, `"copy_dst"`, `"texture_binding"`, `"storage_binding"`, `"render_attachment"`.

### Constructor

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| device | `Device` | ✔ | — | Owning device wrapper. Normally supplied by `Device.createTexture(...)`. |
| gpu | `GPUTexture` | ✔ | — | Raw WebGPU texture. |
| options | `TextureOptions` | ✔ | — | Copied and frozen, including nested arrays; exposed as `texture.options`. The constructor wraps an existing native resource; prefer `Device.createTexture()` for validated allocation. |
| ownership | `"owned" \| "external"` | ✖ | `"owned"` | Destroying an owned wrapper releases its native texture. Destroying an external wrapper only invalidates the wrapper and notifies subscribers; native ownership stays external. |

### Views, resize, readback

Texture allocation is immutable. To resize, create a replacement and rebind it before destroying the previous texture; see the replacement example below. Views and readback operate on the current allocation.

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| desc | `GPUTextureViewDescriptor` | ✖ | `undefined` | Native view descriptor. Arrays default to dimension `"2d-array"` even with one layer; an explicit `dimension` overrides this. Other fields pass through. |
| options.mipLevel | `number` | ✔ | — | Allocated mip index, nonnegative safe integer. |
| options.region | `"all" \| { origin: readonly [number, number, number]; size: readonly [number, number, number] }` | ✔ | — | Entire selected mip, or a positive in-bounds region in mip-relative texels. Includes all selected layers/slices. |

**Returns:**

- `Device.createTexture(opts)` returns `Texture`.
- `texture.view` returns a cached default `GPUTextureView` matching kind, including one-layer arrays.
- `createView(desc?)` returns a fresh `GPUTextureView`.
- `read(options)` returns `Promise<Uint8Array>` with unpadded texel bytes: selected `width * height * depthOrLayers * bytesPerPixel(format)`, X fastest, then Y, then Z. `bgra*` bytes are swizzled to RGBA order.
- `readFloats(options)` returns `Promise<Float32Array>` with one f32 per component in the same order. Float formats keep their HDR values (no clamping to `[0, 1]`), `unorm8` formats are normalized by `/ 255` without srgb gamma conversion.
- `destroy()` and `dispose()` return `void`.

**Throws:**

- `VGPU-CORE-TEXTURE-READ-INVALID` for absent/invalid selection, missing `copy_src`, multisampling, out-of-bounds regions, or allocations exceeding the device buffer limit or portable host byte limit (`2^32 - 1`). Validation occurs before staging allocation; use a smaller region for large textures. Float reads also validate the decoded allocation size.
- `VGPU-CORE-TEXTURE-DESTROYED` when `view`, `createView(...)`, `read()`, or `readFloats()` is used after `destroy()`/`dispose()` — create a new texture instead.
- `VGPU-CORE-UNSUPPORTED-FORMAT` when `read()`/`readFloats()` is called on a format outside [Readback formats](#readback-formats) (depth/stencil, packed, snorm/uint/sint, and compressed formats) — blit into a supported format first, or read the data through a storage buffer.
- Native WebGPU validation errors may occur for invalid size/format/usage combinations.
- Creation preflight throws `VGPU-TEXTURE-*` errors for invalid kind, size, layers, usage, mip/sample combinations, view-format compatibility, enabled limits or storage capability. It does not replace full native per-format validation.

## Examples

```ts
import { createMockAdapter } from "vgpu/mock";

const device = await createMockAdapter().requestDevice();
const target = device.createTexture({
  kind: "2d",
  label: "offscreen-target",
  size: [4, 4],
  format: "rgba8unorm",
  usage: ["render_attachment", "texture_binding", "copy_src"],
});

const defaultView = target.view;
const explicitView = target.createView({ label: "offscreen-target.view" });
console.log(defaultView, explicitView, target.sampleCount); // sampleCount defaults to 1

device.destroy();
```

```ts
import { createMockAdapter } from "vgpu/mock";

const device = await createMockAdapter().requestDevice();
let texture = device.createTexture({
  kind: "2d-array",
  size: [1, 1], layers: 6,
  format: "rgba8unorm",
  usage: ["texture_binding", "copy_src"],
});

const previous = texture;
texture = device.createTexture({ ...previous.options, kind: "2d-array", size: [2, 2], layers: 6 });
// Update any bindings to texture before releasing previous.
previous.destroy();
console.log(texture.size); // [2, 2]
console.log(texture.layers); // 6

const pixels = await texture.read({ mipLevel: 0, region: "all" });
console.log(pixels.byteLength); // width * height * layers * 4

device.destroy();
```

```ts
import { createMockAdapter } from "vgpu/mock";

const device = await createMockAdapter().requestDevice();
const hdr = device.createTexture({
  kind: "2d",
  size: [2, 2],
  format: "rgba16float",
  usage: ["render_attachment", "copy_src"],
});

const bytes = await hdr.read({ mipLevel: 0, region: "all" });
console.log(bytes.byteLength); // 2 * 2 * 8 — raw half-float bytes

const floats = await hdr.readFloats({ mipLevel: 0, region: "all" });
console.log(floats.length); // 2 * 2 * 4 — decoded rgba components, values may exceed 1

device.destroy();
```

## Readback formats

| Format | Bytes per texel | Components | `readFloats()` decoding |
|---|---:|---:|---|
| `r8unorm` | 1 | 1 | `byte / 255` |
| `rg8unorm` | 2 | 2 | `byte / 255` |
| `rgba8unorm`, `rgba8unorm-srgb` | 4 | 4 | `byte / 255` (no srgb gamma conversion) |
| `bgra8unorm`, `bgra8unorm-srgb` | 4 | 4 | `byte / 255`, channels swizzled to RGBA |
| `r16float` | 2 | 1 | binary16 widened to f32 |
| `rg16float` | 4 | 2 | binary16 widened to f32 |
| `rgba16float` | 8 | 4 | binary16 widened to f32 |
| `r32float` | 4 | 1 | verbatim f32 |
| `rg32float` | 8 | 2 | verbatim f32 |
| `rgba32float` | 16 | 4 | verbatim f32 |

Subnormals, infinities, and NaN survive the binary16 → f32 widening unchanged.

## Notes

- `texture.view` is cached and follows kind. Use `createView(descriptor)` for mip, array-layer, cube, or format-specific views.
- `Texture.resize()` does not exist. Create a replacement and rebind it, or resize the owning Target/core texture ping-pong pair. Replacement discards contents; reseed or copy explicitly when needed.
- Tracked public draw/compute bindings reject a destroyed Texture, even without another `set()` call. Raw `GPUTextureView` bindings do not carry a tracked parent and rely on native WebGPU validation.
- Prefer `texture.destroy()`/`texture.dispose()` over `texture.gpu.destroy()` so the wrapper invalidates cached views and emits lifecycle state correctly.
- Include `"copy_src"` when you plan to read, on both real and mock devices. Multisampled textures must be explicitly resolved first (Target exposes its resolved attachment through `.color`).
- `region: "all"` reads one mip, including every array layer or depth slice. A 3D mip shrinks width, height and depth; arrays shrink width/height but retain their layer count. No mip generation, clipping, or implicit resolve is performed.
- Prefer `readFloats()` for HDR textures (`rgba16float`, `rgba32float`): `read()` hands back the raw half/float bytes, which are only useful after a decode. `read()` remains the right call for `rgba8unorm` snapshots and PNG encoding.
- **See also:** `Device`, `Buffer`, `Queue`, `cubeView`, `layerView`.
