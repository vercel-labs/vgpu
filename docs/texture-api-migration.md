# Texture API migration

Breaking changes planned for the next minor release. This guide describes the implemented creation,
lifecycle and explicit readback contracts; it does not announce a published version.

## One creation contract

`texture(gpu, opts)` and `device.createTexture(opts)` accept the same core `TextureOptions` and return
the same `Texture` class. The public factory only adds ownership by `gpu`; core resources still need
their existing explicit lifecycle management. `TextureOptions` and `TextureShape` are re-exported
from `vgpu`, `vgpu/node`, `vgpu/mock` and `vgpu/core`.

### Explicit kind and usage

Before this PR, standalone textures were created through core (`device` is a core `Device`):

```ts
const lut = device.createTexture({
  size: [32, 32, 32], dimension: "3d", format: "rgba16float",
  usage: ["storage_binding", "texture_binding"],
});
```

After, the same core factory accepts the explicit contract:

```ts
const lut = device.createTexture({
  kind: "3d", size: [32, 32, 32], format: "rgba16float",
  usage: ["storage_binding", "texture_binding"],
});
```

Core already required `usage`; it now rejects an empty list. This PR also introduces
`texture(gpu, opts)` in the main API, accepting the same options and registering ownership with `gpu`.
It is a new factory, not an existing factory whose defaults changed.

No capabilities are inferred. Add `copy_src` if you read or copy from the texture, `copy_dst` for
uploads/copies into it, and `render_attachment` for rendering into it. Empty usages are rejected.
The same change applies to direct `device.createTexture(...)` and core `pingPong(device, opts)`.

### Spatial size and layers

| Resource | Creation shape |
| --- | --- |
| 1D | `kind: "1d", size: [width]` |
| 2D | `kind: "2d", size: [width, height]` |
| 3D | `kind: "3d", size: [width, height, depth]` |
| Array | `kind: "2d-array", size: [width, height], layers: count` |

Before, `[width, height, count]` without a dimension created an array. Now arrays always declare
`kind` and `layers`, and `.size` remains a 2-tuple. Replace `array.size[2]` with `array.layers`.
Volume depth remains `volume.size[2]`. For shape-agnostic code, height is `texture.size[1] ?? 1`.
Use `texture.options.kind` to narrow the options union when working with shape-specific metadata.
`.kind` is semantic; `.dimension` is retained as the derived native dimension (`"2d"` for arrays).

One-layer arrays now retain array default views. Explicit native view dimensions, `cubeView` and
`layerView` remain available. Raw `GPUDevice.createTexture` descriptors are unchanged: continue to
use native `dimension`, extent and usage bit flags at that boundary.

## Defaults and validation

Only allocation details have defaults: `mipLevelCount: 1`, `sampleCount: 1`, `viewFormats: []`.
Additional mips allocate storage without generating contents. Standalone MSAA textures do not
allocate or resolve another texture automatically. Alternate compatible view formats require explicit
opt-in; no conversion is performed. Public and core factories expose the same fields.

Descriptors and nested arrays are copied and frozen. Mutating the input object no longer changes
resource metadata or the options used by later pair resizes. Update application configuration separately;
do not mutate `texture.options`, `.size`, `.usage` or `.viewFormats`.

Core preflight rejects malformed shapes, unsupported usage names, invalid mip/sample combinations,
incompatible view formats, exceeded enabled limits and storage formats lacking enabled capabilities.
Native WebGPU remains authoritative for complete per-format and backend validation. These failures
are not silently converted into another allocation or usage set.

## Fixed texture lifetime

`Texture.resize()` and its resize-lock machinery are removed. Texture allocation and resource identity
do not change during its lifetime. Replace a standalone texture explicitly:

```ts
const previous = image;
image = texture(gpu, {
  kind: "2d", size: [width, height], format: "rgba8unorm",
  usage: ["texture_binding", "copy_dst"],
});
post.set({ src: image });
previous.destroy();
```

Re-upload/copy contents as needed; replacement never preserves them implicitly. Destroying a wrapper
invalidates views and bindings. External wrappers never destroy the native resource owned by another
library or swapchain. The obsolete `VGPU-CORE-EXTERNAL-TEXTURE`/`VGPU-CORE-TEXTURE-RESIZE-LOCKED`
resize errors disappear with the method.

Targets retain synchronous `resize(size): void`; core texture pairs retain `resize(size): boolean`.
Each prepares its complete replacement before committing it. Synchronous preparation failure cleans
partial allocations and preserves the old size, attachments/halves, contents and pair parity. Successful
texture-pair replacement resets orientation and discards both halves' contents. Array layers and the
creation format/usage/mip/sample settings stay fixed. An unchanged valid size is a no-op.

These are bounded preparation guarantees: late native GPU errors still use normal device reporting and
do not roll back. Callback errors occur after commit; they do not restore old attachments, and cleanup
and remaining notifications still run. Offscreen targets reject recursive resize from replacement
callbacks and reject all resize calls after destruction. Buffer-pair behavior is outside this checkpoint.

## Binding and bundle safety

```ts
// Automatically follows successful Target attachment replacement:
post.set({ src: scene });
scene.resize([width, height]);

// Explicit attachment reference: rebind after replacement:
post.set({ src: scene.color });
scene.resize([width * 2, height * 2]);
post.set({ src: scene.color });

// Core texture pairs also require explicit rebinding after replacement:
if (pair.resize([width, height])) {
  fill.set({ dst: pair.write });
  post.set({ src: pair.read });
  // Reseed before using the new contents.
}
```

Using a destroyed tracked texture in `set`, draw or compute dispatch now fails with
`VGPU-R1-BINDING-DESTROYED`, naming the binding and resource. This includes retained old target
attachments and pair halves. Rebinding a live replacement recovers ordinary rendering. Bundles freeze
their commands/resources: they become `VGPU-R3-BUNDLE-STALE` and must be recorded again, even if
the Draw has since been rebound.

Raw `GPUTextureView`/native bind groups have no tracked parent in this API. Direct native destruction
also bypasses wrapper signals. Native WebGPU remains the validation fallback; no managed-view or raw
view lifetime guarantee is added here.

## Explicit texture readback

Both fields are mandatory. Select the attachment first; `Target.read`, `Target.readFloats`,
`Surface.read` and `Surface.readFloats` have been removed. Buffer reads are unchanged.

```ts
// Before
const pixels = await output.read();
const values = await volume.readFloats();

// After
const pixels = await output.color.read({ mipLevel: 0, region: "all" });
const values = await volume.readFloats({ mipLevel: 0, region: "all" });
const normals = await gbuffer.colors[1].readFloats({ mipLevel: 0, region: "all" });

// Read a crop from one allocated mip. Coordinates are mip-relative texels.
const crop = await volume.readFloats({
  mipLevel: 1,
  region: { origin: [2, 3, 1], size: [4, 5, 2] },
});
```

`TextureReadOptions` is shared by core and public entrypoints. `region: "all"` means the whole
selected mip, including **every** array layer or 3D slice (previously reads copied only the first slice).
To retain that previous selection, use `region: { origin: [0, 0, 0], size: [width, height, 1] }`.
Width/height/depth shrink at each 3D mip; array layers never shrink. Results are tightly packed:
X fastest, then Y, then Z; no row or slice padding remains.

Declare `copy_src` at creation, including for mocks. Invalid/missing mip or region, non-integer or
out-of-bounds coordinates, missing usage, multisampling and oversized allocations fail before staging
allocation with `VGPU-CORE-TEXTURE-READ-INVALID`. No clipping or implicit resolve occurs; read an
MSAA Target's resolved `.color` attachment instead of its multisampled texture. Allocation checks
cover the device's `maxBufferSize` and a portable host byte limit of `2^32 - 1`; decoded float sizes
are also checked. Read smaller regions when necessary.

Formats and conversion semantics are unchanged: `read` returns raw bytes (BGRA swizzled to RGBA),
`readFloats` widens half/float components and normalizes unorm8 without sRGB decoding. Unsupported
depth, compressed, packed and integer formats still fail with `VGPU-CORE-UNSUPPORTED-FORMAT`.
Mock storage now distinguishes allocated mips and slices; nonzero-mip uploads are supported.

## Node/Linux backend default

Linux now selects Vulkan even when X11 or Wayland is configured. Existing code stays the same:

```ts
import { init } from "vgpu/node";
const gpu = await init(); // Vulkan on Linux; other platforms retain their existing defaults.
```

If your Linux environment previously depended on automatic OpenGL selection, install a hardware
Vulkan driver or use the existing portable CPU-renderer installer:

```sh
npx vgpu install-software-renderer
```

Auto mode may use that installed renderer if normal discovery fails. It does not silently switch to
OpenGL or download drivers. A missing adapter produces `VGPU-NODE-NO-ADAPTER` with remediation.
An explicit override remains available for legacy uses:

```sh
VGPU_DAWN_FLAGS=backend=opengl node render.mjs
```

That opt-in retains Dawn's known restricted-mip-view/storage-write bug (392121637). macOS, Windows,
browser WebGPU and the existing compatibility feature level are unchanged. Docker/CI references now
use one pinned native Linux x64 Vulkan/lavapipe environment and one shared baseline collection.
The accepted comparison policy allows at most 1/255 per RGB channel with exact alpha, checking every
pixel without a percentage allowance or antialias exclusion. Raw differences remain in reports;
tolerated rounding never regenerates references. See [Visual snapshots](visual-snapshots.md).
