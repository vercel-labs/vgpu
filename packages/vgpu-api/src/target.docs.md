# Target

Offscreen render target abstraction used by passes, draws, bundles, and ping-pong resources. Targets own size, color formats, optional depth, MSAA resolve textures, and readback. Canvas-backed targets are `Surface` instances created with `gpu.surface(canvas)`.

## Import

```ts
import type { Target, TargetOptions, TargetTextureOptions, PingPongTargets, PingPongStorage } from "vgpu";
```

## Signature

```ts
import type { ClearColor } from "vgpu";
import type { ResourceDestroyCallback, ResourceIdentity, Texture, UnsubscribeResourceDestroy } from "vgpu/core";

interface TargetTextureOptions {
  readonly format?: GPUTextureFormat;
  readonly colors?: readonly { readonly format: GPUTextureFormat }[];
  readonly depth?: boolean | GPUTextureFormat;
  readonly msaa?: boolean | 4;
  readonly label?: string;
}

interface TargetOptions extends TargetTextureOptions {
  readonly size: readonly [number, number];
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
  renderPassDescriptor(clear?: ClearColor, preserve?: boolean): GPURenderPassDescriptor;
}

interface PingPongTargets { readonly read: Target; readonly write: Target; swap(): void; }
interface PingPongStorage { readonly read: import("vgpu").StorageBuffer; readonly write: import("vgpu").StorageBuffer; swap(): void; }
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| gpu.target.opts | `TargetOptions` | ✔ | — | Creates an offscreen target. `size` is mandatory. |
| opts.size | `readonly [number, number]` | ✔ | — | Initial offscreen texture size in physical pixels. |
| opts.format | `GPUTextureFormat` | ✖ | `"rgba8unorm"` | Used for single-color targets when `colors` is omitted. |
| opts.colors | `readonly { format: GPUTextureFormat }[]` | ✖ | `[{ format: opts.format ?? "rgba8unorm" }]` | MRT color attachments. `target.color` is `colors[0]`. |
| opts.depth | `boolean \| GPUTextureFormat` | ✖ | `undefined` | `true` means `"depth24plus"`; a string uses that depth format; omitted means no depth. |
| opts.msaa | `boolean \| 4` | ✖ | `false` / sample count `1` | `true` or `4` creates MSAA color/depth attachments with sample count `4` and resolves to sampleable `.color(s)`. |
| opts.label | `string` | ✖ | `undefined` | Prefix for created texture labels. |
| target.resize.size | `readonly [number, number]` | ✔ | — | Recreates offscreen textures unless size is unchanged. |
| target.read | — | — | — | No parameters; reads `target.color` and returns RGBA bytes. `bgra8unorm` / `bgra8unorm-srgb` are supported and swizzled to RGBA, matching canvas preferred formats on platforms such as macOS. |
| target.onDestroy.cb | `ResourceDestroyCallback<Target>` | ✔ | — | Subscribes to target destruction. |
| target.renderPassDescriptor.clear | `ClearColor` | ✖ | `[0, 0, 0, 1]` | Clear color for all color attachments unless `preserve` is true. `Frame.pass` supplies `gpu.clearColor` for omitted/`true` clears and a per-pass color when provided. |
| target.renderPassDescriptor.preserve | `boolean` | ✖ | `false` | Optional implementer hook used by `Frame.pass({ clear: false })`; when true, color and depth attachments should load existing contents and omit clear values. |
| gpu.pingPong.width | `number` | ✔ | — | Floored and clamped to at least `1`. |
| gpu.pingPong.height | `number` | ✔ | — | Floored and clamped to at least `1`. |
| gpu.pingPong.opts | `TargetTextureOptions` | ✖ | `{}` | Texture options for both targets. Size is intentionally not accepted; positional width/height win. |
| gpu.pingPongStorage.bytes | `number` | ✔ | — | Creates two `"read-write"` storage buffers. |

**Returns:** `gpu.target()` returns `Target`; `resize()` returns `void`; `read()` returns `Promise<Uint8Array>`; `renderPassDescriptor(clear?, preserve?)` returns a WebGPU render pass descriptor; `gpu.pingPong()` returns `PingPongTargets`; `gpu.pingPongStorage()` returns `PingPongStorage`.

**Throws:** `VGPU-TARGET-SIZE-REQUIRED` when runtime JS calls `gpu.target()` without `size`; `VGPU-RING1-UNSUPPORTED` when `msaa: true` / `4` with `rgba16float` is used on a Dawn compatibility-mode device; underlying core texture/readback operations can throw native WebGPU validation errors.

## Examples

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const scene = gpu.target({ size: [128, 128], format: "rgba16float", depth: true, msaa: true });
const post = gpu.effect(`
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0, 1); }
`);

gpu.frame((frame) => {
  frame.pass({ target: scene, clear: [0, 0, 0, 1] }, (pass) => pass.draw(post));
});
```

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const surface = gpu.surface(mockCanvas());
const bloomSize = (w: number, h: number): [number, number] => [w / 2, h / 2];
const bloom = gpu.target({ size: bloomSize(surface.size[0], surface.size[1]) });
const bright = gpu.effect(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);

surface.onResize(({ width, height }) => {
  bloom.resize(bloomSize(width, height));
  bright.set({ resolution: bloom.size });
});

function mockCanvas(): HTMLCanvasElement {
  return {
    width: 10,
    height: 10,
    clientWidth: 10,
    clientHeight: 10,
    getContext() { return { configure() {}, unconfigure() {}, getCurrentTexture() { return { createView: () => ({}) }; } }; },
  } as unknown as HTMLCanvasElement;
}
```

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const pingPong = gpu.pingPong(32.9, 32.1, { format: "rgba8unorm" });
const blur = gpu.effect(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);

gpu.frame((frame) => {
  frame.pass({ target: pingPong.write, clear: false }, (pass) => pass.draw(blur));
});
pingPong.swap();
```

## Notes

- There is no global resolution binding. Pass `target.size` or `target.texelSize` explicitly to shaders.
- `Surface.color` wraps the canvas current texture; offscreen target colors are stable until resize/destroy.
- `target.read()` and `surface.read()` return RGBA bytes. BGRA canvas formats are read back with red/blue channels swizzled to RGBA.
- Size-dependent targets derived from a surface should be created from the real initial `surface.size` and resized from `surface.onResize(...)`.
- Custom `Target` implementers should honor the optional `renderPassDescriptor(clear?, preserve?)` second argument to participate in `Frame.pass({ clear: false })`; older one-argument implementations remain structurally assignable but will clear if they ignore `preserve`.
- **See also:** `Surface`, `FramePassOptions`, `Effect`, `Draw`, `Bundle`, `Compute` storage ping-pong.
