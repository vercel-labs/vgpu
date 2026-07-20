# Gpu

The main API (`vgpu`) facade returned by `init()`. It owns device lifetime, frame clocks, canvas surfaces, offscreen targets, and public factories for render, compute, storage, uniforms, samplers, and bundles.

## Import

```ts
import type { Gpu } from "vgpu";
import { init } from "vgpu/mock";
```

## Signature

```ts
import type { Bundle, BundleOptions, BundleRecorder, Compute, ComputeOptions, Draw, DrawOptions, Frame, FrameRunner, Effect, EffectOptions, GpuErrorListener, PingPongStorage, PingPongTargets, SharedUniforms, StorageAccess, StorageBuffer, Surface, SurfaceOptions, Target, TargetOptions, TargetTextureOptions } from "vgpu";
import type { Device } from "vgpu/core";
import type { ShaderSource } from "vgpu";

interface Gpu {
  readonly device: Device;
  readonly gpu: GPUDevice;
  time: number;
  deltaTime: number;
  frameCount: number;
  surface(canvas: HTMLCanvasElement | OffscreenCanvas, opts?: SurfaceOptions): Surface;
  effect(source: string | ShaderSource, opts?: EffectOptions): Effect;
  draw(opts: DrawOptions): Draw;
  target(opts: TargetOptions): Target;
  readonly frame: FrameRunner & ((cb?: (frame: Frame) => void) => Frame);
  sampler(desc?: GPUSamplerDescriptor): GPUSampler;
  mesh(geometry: unknown): import("vgpu").MeshLike;
  dispose(): void;
  compute(source: string | ShaderSource, opts?: ComputeOptions): Compute;
  storage(bytes: number, access?: StorageAccess): StorageBuffer;
  pingPong(width: number, height: number, opts?: TargetTextureOptions): PingPongTargets;
  pingPongStorage(bytes: number): PingPongStorage;
  uniforms<T extends Record<string, unknown>>(values: T): SharedUniforms<T>;
  bundle(opts: BundleOptions, cb: (recorder: BundleRecorder) => void): Bundle;
  onError(cb: GpuErrorListener): () => void;
  settled(): Promise<void>;
}
```

## Parameters

`Gpu` is an object, not a callable constructor. Method parameters:

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| surface.canvas | `HTMLCanvasElement \| OffscreenCanvas` | ✔ | — | Canvas-like object with a `webgpu` context. A canvas may have one live `Surface`. |
| surface.opts | `SurfaceOptions` | ✖ | `{}` | Per-surface canvas format, size, DPR, and auto-resize behavior. |
| effect.source | `string \| ShaderSource` | ✔ | — | WGSL string or loader-produced `ShaderSource { version: 1, wgsl }`. |
| effect.opts | `EffectOptions` | ✖ | `{}` | `label` defaults to `"effect"`; `set` defaults to no initial bindings. |
| draw.opts | `DrawOptions` | ✔ | — | Includes required `shader`; see `DrawOptions`. |
| target.opts | `TargetOptions` | ✔ | — | Offscreen target options. `size` is required. |
| frame.cb | `(frame: Frame) => void` | ✖ | `undefined` | If provided, submits automatically in `finally`; if omitted, caller must call `frame.submit()`. |
| sampler.desc | `GPUSamplerDescriptor` | ✖ | `undefined` | Cached by descriptor. `gpu.sampler()` is the canonical default sampler. |
| mesh.geometry | `unknown` | ✔ | — | Usually a `vgpu/scene` geometry descriptor such as `box()` or `plane()`. |
| compute.source | `string \| ShaderSource` | ✔ | — | WGSL string or `ShaderSource`. Must contain a `@compute` entry point. |
| compute.opts | `ComputeOptions` | ✖ | `{}` | `label` defaults to `"compute"`; `set` defaults to no initial bindings. |
| storage.bytes | `number` | ✔ | — | Byte size for a main API (`vgpu`) storage buffer. |
| storage.access | `StorageAccess` | ✖ | `"read-write"` | Reflection still controls shader compatibility; writable aliases are checked before compute dispatch. |
| pingPong.width | `number` | ✔ | — | Floored and clamped to at least `1`. |
| pingPong.height | `number` | ✔ | — | Floored and clamped to at least `1`. |
| pingPong.opts | `TargetTextureOptions` | ✖ | `{}` | Texture/attachment options only; size comes from positional width/height. |
| pingPongStorage.bytes | `number` | ✔ | — | Creates two `"read-write"` storage buffers. |
| uniforms.values | `Record<string, unknown>` | ✔ | — | Cloned initial JS values; WGSL layout is adopted when first bound. |
| bundle.opts | `BundleOptions` | ✔ | — | Requires a `target` or target signature. |
| bundle.cb | `(recorder: BundleRecorder) => void` | ✔ | — | Records bundle commands immediately. |
| onError.cb | `GpuErrorListener` | ✔ | — | Receives asynchronous vgpu errors; returns an unsubscribe function. |

**Returns:** `Gpu` methods return the resources named in their signatures. `dispose()` and frame/pass callbacks return `void`.

**Throws:** `VGPU-LIMIT-STORAGE-VERTEX` / `VGPU-LIMIT-STORAGE-FRAGMENT` when a selected render entry exceeds its granted storage-buffer limit. The structured detail reports `stage`, `entryPoint`, `count`, `limit`, and each counted binding's `name`, `group`, and `binding`; request a supported limit or reduce/move the data; `VGPU-SHADER-SOURCE-INVALID` for malformed `ShaderSource`; `VGPU-RING1-UNSUPPORTED` for unsupported effect/compute/target cases; `VGPU-TARGET-REQUIRED` when one-shot drawing needs an explicit target; `VGPU-TARGET-SIZE-REQUIRED` for runtime JS calls to `gpu.target()` without `size`; `VGPU-SURFACE-*` errors from `surface()`, surface resize, surface readback, or using disposed surfaces; plus method-specific `VGPU-R1-*`, `VGPU-R3-*`, and `VGPU-R4-*` errors documented on `Effect`, `Draw`, `Compute`, `Frame`, `Bundle`, `Target`, and `SharedUniforms`.

## Examples

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const target = gpu.target({ size: [128, 128], depth: true });
const draw = gpu.draw({
  shader: `
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[vi], 0, 1);
    }
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1, 0, 1, 1); }
  `,
  // optional sync pre-warm; `await draw.compile(target)` is preferred during browser load
  targets: [target],
});

gpu.frame((frame) => {
  frame.pass({ target, clear: [0, 0, 0, 1] }, (pass) => pass.draw(draw));
});
```

```ts
import { init } from "vgpu";

declare const canvas: HTMLCanvasElement;

const gpu = await init();
const surface = gpu.surface(canvas, { dpr: [1, 2] });
const wave = gpu.effect(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.2, 0.4, 1.0, 1.0); }`);

gpu.frame.loop((frame) => {
  frame.pass({ target: surface }, (pass) => pass.draw(wave));
});
```

## Error delivery

`gpu.onError(cb)` subscribes to asynchronous vgpu errors and returns an unsubscribe function. Listeners run in subscription order; removing one stops future deliveries; a throwing listener is reported to `console.error` without stopping the rest. If no listener is registered, vgpu reports the error to `console.error` by default.

`gpu.settled()` resolves after the current snapshot of pending error deliveries and in-flight pipeline work settles. It never rejects, so it is safe for deterministic tests and teardown.

## Notes

- There is no implicit screen property and no implicit default target. Pass `target` explicitly to frame passes and one-shot draws.
- Canvas-specific `size`, `dpr`, and `autoResize` live on `gpu.surface(canvas, opts)`, not on `init()`.
- Time is explicit JS state. Pass `gpu.time`, `gpu.deltaTime`, or `gpu.frameCount` through `set()` or `SharedUniforms` when shaders need them.
- **See also:** `init`, `Surface`, `Effect`, `Draw`, `Compute`, `Frame`, `Target`, `Bundle`, `SharedUniforms`.
