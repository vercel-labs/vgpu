# Target

Render target abstraction used by passes, draws, bundles, and ping-pong resources. Targets own size, color formats, optional depth, MSAA resolve textures, and readback.

## Import

```ts
import type { Target, TargetOptions, PingPongTargets, PingPongStorage } from "vgpu";
```

## Signature

```ts
import type { ResourceDestroyCallback, ResourceIdentity, Texture, UnsubscribeResourceDestroy } from "vgpu/core";

interface TargetOptions {
  readonly size?: readonly [number, number];
  readonly format?: GPUTextureFormat;
  readonly colors?: readonly { readonly format: GPUTextureFormat }[];
  readonly depth?: boolean | GPUTextureFormat;
  readonly msaa?: boolean | 4;
  readonly label?: string;
}

interface Target {
  readonly gpu: unknown;
  readonly size: readonly [number, number];
  readonly texelSize: readonly [number, number];
  readonly color: Texture;
  readonly colors: readonly [Texture, ...Texture[]];
  readonly depth?: Texture;
  readonly format: GPUTextureFormat;
  readonly sampleCount: 1 | 4;
  readonly resourceIdentity: ResourceIdentity;
  resize(size: readonly [number, number]): void;
  read(): Promise<Uint8Array>;
  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy;
  renderPassDescriptor(clear?: GPUColor | readonly [number, number, number, number]): GPURenderPassDescriptor;
}

interface PingPongTargets { readonly read: Target; readonly write: Target; swap(): void; }
interface PingPongStorage { readonly read: import("vgpu").StorageBuffer; readonly write: import("vgpu").StorageBuffer; swap(): void; }
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| gpu.target.opts | `TargetOptions` | ✖ | `{}` | Creates an offscreen target. |
| opts.size | `readonly [number, number]` | ✖ | `[1, 1]` | Initial offscreen texture size. |
| opts.format | `GPUTextureFormat` | ✖ | `"rgba8unorm"` | Used for single-color targets when `colors` is omitted. |
| opts.colors | `readonly { format: GPUTextureFormat }[]` | ✖ | `[{ format: opts.format ?? "rgba8unorm" }]` | MRT color attachments. `target.color` is `colors[0]`. |
| opts.depth | `boolean \| GPUTextureFormat` | ✖ | `undefined` | `true` means `"depth24plus"`; a string uses that depth format; omitted means no depth. |
| opts.msaa | `boolean \| 4` | ✖ | `false` / sample count `1` | `true` or `4` creates MSAA color/depth attachments with sample count `4` and resolves to sampleable `.color(s)`. |
| opts.label | `string` | ✖ | `undefined` | Prefix for created texture labels. |
| target.resize.size | `readonly [number, number]` | ✔ | — | Recreates offscreen textures unless size is unchanged; screen targets resize canvas dimensions. |
| target.read.clear | — | — | — | No parameters; reads `target.color`. |
| target.onDestroy.cb | `ResourceDestroyCallback<Target>` | ✔ | — | Subscribes to target destruction. |
| target.renderPassDescriptor.clear | `GPUColor \| readonly [number, number, number, number]` | ✖ | `[0, 0, 0, 1]` | Clear color for all color attachments. |
| gpu.pingPong.width | `number` | ✔ | — | Floored and clamped to at least `1`. |
| gpu.pingPong.height | `number` | ✔ | — | Floored and clamped to at least `1`. |
| gpu.pingPong.opts | `TargetOptions` | ✖ | `{}` | Shared by both halves. |
| gpu.pingPongStorage.bytes | `number` | ✔ | — | Creates two `"read-write"` storage buffers. |

**Returns:** `gpu.target()` returns `Target`; `resize()` returns `void`; `read()` returns `Promise<Uint8Array>`; `renderPassDescriptor()` returns a WebGPU render pass descriptor; `gpu.pingPong()` returns `PingPongTargets`; `gpu.pingPongStorage()` returns `PingPongStorage`.

**Throws:** `VGPU-RING1-UNSUPPORTED` when `msaa: true` / `4` with `rgba16float` is used on a Dawn compatibility-mode device; underlying core texture/readback operations can throw native WebGPU validation errors.

## Examples

```ts
import { init } from "vgpu/mock";

const gpu = await init({ size: [128, 128] });
const scene = gpu.target({ size: [128, 128], format: "rgba16float", depth: true, msaa: true });
const post = gpu.pass(`
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0, 1); }
`);

gpu.frame((frame) => {
  frame.pass({ target: scene, clear: [0, 0, 0, 1] }, (pass) => pass.draw(post));
});
```

```ts
import { init } from "vgpu/mock";

const gpu = await init({ size: [32, 32] });
const pingPong = gpu.pingPong(32.9, 32.1, { format: "rgba8unorm" });
const blur = gpu.pass(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);

gpu.frame((frame) => {
  frame.pass({ target: pingPong.write }, (pass) => pass.draw(blur));
});
pingPong.swap();
```

## Notes

- There is no global resolution binding. Pass `target.size` or `target.texelSize` explicitly to shaders.
- `ScreenTarget.color` wraps `getCurrentTexture()` and should be read fresh each frame; offscreen target colors are stable until resize/destroy.
- MSAA targets render into multisampled attachments and resolve into sampleable `.color` / `.colors` textures.
- **See also:** `FramePassOptions`, `Pass`, `Draw`, `Bundle`, `Compute` storage ping-pong.
