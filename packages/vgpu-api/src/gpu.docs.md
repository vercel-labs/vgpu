# Gpu

The main API (`vgpu`) facade returned by `init()`. It owns the `Device`, optional screen target, frame clocks, and public factories for passes, draws, compute, targets, buffers, uniforms, samplers, and bundles.

## Import

```ts
import type { Gpu } from "vgpu";
import { init } from "vgpu/mock";
```

## Signature

```ts
import type { Bundle, BundleOptions, BundleRecorder, Compute, ComputeOptions, Draw, DrawOptions, Frame, FrameRunner, Pass, PassOptions, Target, TargetOptions } from "vgpu";
import type { Device } from "vgpu/core";
import type { ShaderSource } from "vgpu";

interface Gpu {
  readonly device: Device;
  readonly gpu: GPUDevice;
  readonly screen?: Target;
  time: number;
  deltaTime: number;
  frameCount: number;
  pass(source: string | ShaderSource, opts?: PassOptions): Pass;
  draw(opts: DrawOptions): Draw;
  target(opts?: TargetOptions): Target;
  readonly frame: FrameRunner & ((cb?: (frame: Frame) => void) => Frame);
  sampler(desc?: GPUSamplerDescriptor): GPUSampler;
  mesh(geometry: unknown): import("vgpu").MeshLike;
  onResize(cb: (size: readonly [number, number]) => void): () => void;
  dispose(): void;
  compute(source: string | ShaderSource, opts?: ComputeOptions): Compute;
  storage(bytes: number, access?: "read" | "read-write"): import("vgpu").StorageBuffer;
  pingPong(width: number, height: number, opts?: TargetOptions): import("vgpu").PingPongTargets;
  pingPongStorage(bytes: number): import("vgpu").PingPongStorage;
  uniforms<T extends Record<string, unknown>>(values: T): import("vgpu").SharedUniforms<T>;
  bundle(opts: BundleOptions, cb: (recorder: BundleRecorder) => void): Bundle;
}
```

## Parameters

`Gpu` is an object, not a callable constructor. Method parameters:

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| pass.source | `string \| ShaderSource` | ✔ | — | WGSL string or loader-produced `ShaderSource { version: 1, wgsl }`. |
| pass.opts | `PassOptions` | ✖ | `{}` | `label` defaults to `"pass"`; `set` defaults to no initial bindings. |
| draw.opts | `DrawOptions` | ✔ | — | Includes required `shader`; see `DrawOptions`. |
| target.opts | `TargetOptions` | ✖ | `{}` | Offscreen target defaults to size `[1, 1]`, format `"rgba8unorm"`, no depth, sample count `1`. |
| frame.cb | `(frame: Frame) => void` | ✖ | `undefined` | If provided, submits automatically in `finally`; if omitted, caller must call `frame.submit()`. |
| sampler.desc | `GPUSamplerDescriptor` | ✖ | `undefined` | Cached by descriptor. `gpu.sampler()` is the canonical default sampler. |
| mesh.geometry | `unknown` | ✔ | — | Usually a `vgpu/scene` geometry descriptor such as `box()` or `plane()`. |
| onResize.cb | `(size) => void` | ✔ | — | Called only for canvas-backed screen resize notifications. Returns unsubscribe. |
| compute.source | `string \| ShaderSource` | ✔ | — | WGSL string or `ShaderSource`. Must contain a `@compute` entry point. |
| compute.opts | `ComputeOptions` | ✖ | `{}` | `label` defaults to `"compute"`; `set` defaults to no initial bindings. |
| storage.bytes | `number` | ✔ | — | Byte size for a main API (`vgpu`) storage buffer. |
| storage.access | `"read" \| "read-write"` | ✖ | `"read-write"` | Reflection still controls shader compatibility; writable aliases are checked before compute dispatch. |
| pingPong.width | `number` | ✔ | — | Floored and clamped to at least `1`. |
| pingPong.height | `number` | ✔ | — | Floored and clamped to at least `1`. |
| pingPong.opts | `TargetOptions` | ✖ | `{}` | Applied to both targets; labels become `.ping` and `.pong`. |
| pingPongStorage.bytes | `number` | ✔ | — | Creates two `"read-write"` storage buffers. |
| uniforms.values | `Record<string, unknown>` | ✔ | — | Cloned initial JS values; WGSL layout is adopted when first bound. |
| bundle.opts | `BundleOptions` | ✔ | — | Requires `target`. |
| bundle.cb | `(recorder: BundleRecorder) => void` | ✔ | — | Records bundle commands immediately. |

**Returns:** `Gpu` methods return the resources named in their signatures. `dispose()` and frame/pass callbacks return `void`.

**Throws:** `VGPU-SHADER-SOURCE-INVALID` for malformed `ShaderSource`; `VGPU-RING1-UNSUPPORTED` for unsupported pass/compute/target cases; `VGPU-SCREEN-MISSING` when one-shot drawing/frame pass needs a target and no `gpu.screen` exists; plus method-specific `VGPU-R1-*`, `VGPU-R3-*`, and `VGPU-R4-*` errors documented on `Pass`, `Draw`, `Compute`, `Frame`, `Bundle`, `Target`, and `SharedUniforms`.

## Examples

```ts
import { init } from "vgpu/mock";

const gpu = await init({ size: [128, 128] });
const target = gpu.target({ size: [128, 128], depth: true });
const draw = gpu.draw({
  shader: `
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[vi], 0, 1);
    }
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1, 0, 1, 1); }
  `,
  targets: [target],
});

gpu.frame((frame) => {
  frame.pass({ target, clear: [0, 0, 0, 1] }, (pass) => pass.draw(draw));
});
```

## Notes

- `Draw`, `Pass`, `Frame`, `FramePass`, and `FrameRunner` are type-only public exports from `vgpu`; create them through `Gpu` methods.
- Time is explicit JS state. Pass `gpu.time`, `gpu.deltaTime`, or `gpu.frameCount` through `set()` or `SharedUniforms` when shaders need them.
- Prefer `gpu.frame((f) => ...)` for multiple passes or explicit offscreen targets; `pass.draw()` / `draw.draw()` are one-shot conveniences.
- **See also:** `init`, `Pass`, `Draw`, `Compute`, `Frame`, `Target`, `Bundle`, `SharedUniforms`.
