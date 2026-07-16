# Texture

`Texture` is the core wrapper around a `GPUTexture`. Use it for explicit texture allocation through `Device.createTexture(...)`, cached default views, resizing owned textures, readback, and wrapper-aware teardown.

## Import

```ts
import { Texture } from "vgpu/core";
```

## Signature

```ts
import type { Device } from "vgpu/core";

type TextureUsageName = "copy_src" | "copy_dst" | "texture_binding" | "storage_binding" | "render_attachment";

interface TextureOptions {
  readonly size: readonly [width: number, height: number, depthOrArrayLayers?: number];
  readonly format: GPUTextureFormat;
  readonly usage: readonly TextureUsageName[];
  readonly mipLevelCount?: number;
  readonly sampleCount?: 1 | 4;
  readonly dimension?: GPUTextureDimension;
  readonly viewFormats?: readonly GPUTextureFormat[];
  readonly label?: string;
}

declare class Texture {
  constructor(device: Device, gpu: GPUTexture, options: TextureOptions, ownership?: "owned" | "external");
  get gpu(): GPUTexture;
  get options(): TextureOptions;
  get size(): TextureOptions["size"];
  get format(): GPUTextureFormat;
  get usage(): TextureOptions["usage"];
  get mipLevelCount(): number;
  get sampleCount(): 1 | 4;
  get dimension(): GPUTextureDimension;
  get viewFormats(): readonly GPUTextureFormat[];
  get label(): string | undefined;
  get view(): GPUTextureView;
  createView(desc?: GPUTextureViewDescriptor): GPUTextureView;
  resize(size: readonly [number, number] | readonly [number, number, number]): boolean;
  read(): Promise<Uint8Array>;
  destroy(): void;
  dispose(): void;
}
```

## Parameters

### `Device.createTexture(opts)` / `TextureOptions`

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| opts.size | `readonly [width: number, height: number, depthOrArrayLayers?: number]` | ✔ | — | Stored as tuple and converted to `{ width, height, depthOrArrayLayers: opts.size[2] ?? 1 }` for WebGPU. |
| opts.format | `GPUTextureFormat` | ✔ | — | Forwarded to `GPUTextureDescriptor.format`. `read()` only supports `"rgba8unorm"` and `"rgba8unorm-srgb"`. |
| opts.usage | `readonly TextureUsageName[]` | ✔ | — | Vgpu usage names mapped to `GPUTextureUsage` flags. |
| opts.mipLevelCount | `number` | ✖ | WebGPU default (`1`) | Only included in the native descriptor when provided; getter returns `opts.mipLevelCount ?? 1`. |
| opts.sampleCount | `1 \| 4` | ✖ | WebGPU default (`1`) | Only included when provided; getter returns `opts.sampleCount ?? 1`. Use `4` for MSAA where WebGPU allows it. |
| opts.dimension | `GPUTextureDimension` | ✖ | WebGPU default (`"2d"`) | Only included when provided; getter returns `opts.dimension ?? "2d"`. |
| opts.viewFormats | `readonly GPUTextureFormat[]` | ✖ | `[]` | Only included when provided; getter returns `opts.viewFormats ?? []`. |
| opts.label | `string` | ✖ | `undefined` | Forwarded to `GPUTextureDescriptor.label` and exposed via `texture.label`. |

Valid `TextureUsageName` values: `"copy_src"`, `"copy_dst"`, `"texture_binding"`, `"storage_binding"`, `"render_attachment"`.

### Constructor

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| device | `Device` | ✔ | — | Owning device wrapper. Normally supplied by `Device.createTexture(...)`. |
| gpu | `GPUTexture` | ✔ | — | Raw WebGPU texture. |
| options | `TextureOptions` | ✔ | — | Original vgpu descriptor exposed as `texture.options`. |
| ownership | `"owned" \| "external"` | ✖ | `"owned"` | Owned textures can be resized and destroyed by the wrapper; external textures cannot be resized or destroyed by the wrapper. |

### Views, resize, readback

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| desc | `GPUTextureViewDescriptor` | ✖ | `undefined` | `createView(desc?)` forwards directly to `gpu.createView(desc)`. |
| size | `readonly [number, number] \| readonly [number, number, number]` | ✔ | — | New extent for `resize(...)`. A 2-tuple preserves the current depth/array layers. |

**Returns:**

- `Device.createTexture(opts)` returns `Texture`.
- `texture.view` returns a cached default `GPUTextureView` created with no descriptor.
- `createView(desc?)` returns a fresh `GPUTextureView`.
- `resize(size)` returns `false` if the extent is unchanged, otherwise reallocates the raw texture and returns `true`.
- `read()` returns `Promise<Uint8Array>` with unpadded pixel bytes.
- `destroy()` and `dispose()` return `void`.

**Throws:**

- `VGPU-CORE-TEXTURE-DESTROYED` when `view`, `resize(...)`, or `read()` is used after `destroy()`/`dispose()` — create a new texture instead.
- `VGPU-CORE-EXTERNAL-TEXTURE` when `resize(...)` is called on a texture constructed with `ownership: "external"` — resize the owning canvas/swapchain/resource instead.
- `VGPU-CORE-TEXTURE-RESIZE-LOCKED` when an internal resize lock is active — follow the lock message and resize through the owner that installed the lock.
- `VGPU-CORE-UNSUPPORTED-FORMAT` when `read()` is called on a format other than `"rgba8unorm"` or `"rgba8unorm-srgb"` — use a supported readback format or implement a format conversion pass.
- Native WebGPU validation errors may occur for invalid size/format/usage combinations.

## Examples

```ts
import { createMockAdapter } from "vgpu/mock";

const device = await createMockAdapter().requestDevice();
const target = device.createTexture({
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
const texture = device.createTexture({
  size: [1, 1, 6],
  format: "rgba8unorm",
  usage: ["texture_binding", "copy_src"],
});

console.log(texture.resize([2, 2])); // true; depthOrArrayLayers stays 6
console.log(texture.size); // [2, 2, 6]
console.log(texture.resize([2, 2, 6])); // false; unchanged

const pixels = await texture.read();
console.log(pixels.byteLength); // width * height * 4

device.destroy();
```

## Notes

- `texture.view` is cached and descriptorless. Use `createView(descriptor)` for mip, array-layer, cube, or format-specific views.
- `resize(...)` preserves all descriptor fields except `size`; contents are not preserved. Rebuild bind groups or caches keyed by `texture.gpu` after a resize.
- Prefer `texture.destroy()`/`texture.dispose()` over `texture.gpu.destroy()` so the wrapper invalidates cached views and emits lifecycle state correctly.
- Include `"copy_src"` when you plan to call `read()` on real WebGPU devices; mock textures can still expose their mock bytes.
- **See also:** `Device`, `Buffer`, `Queue`, `cubeView`, `layerView`.
