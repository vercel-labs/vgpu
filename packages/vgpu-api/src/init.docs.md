# init

Creates the public `Gpu` context. `init()` creates the device only; canvas-backed rendering is explicit through `gpu.surface(canvas, opts)`.

## Import

```ts
import { init } from "vgpu";
```

Browser code imports from `vgpu`; Node GPU tests import from `vgpu/node`; deterministic unit tests import from `vgpu/mock`.

## Signature

```ts
import type { Gpu } from "vgpu";
import type { RequiredDeviceLimits, VGPUAdapter } from "vgpu/core";

declare function init(options?: InitOptions): Promise<Gpu>;

interface InitOptions {
  readonly adapter?: VGPUAdapter;
  readonly powerPreference?: GPUPowerPreference;
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly requiredLimits?: RequiredDeviceLimits;
  readonly label?: string;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| options | `InitOptions` | ✖ | `{}` | Device creation options only. Canvas size, DPR, and auto-resize belong to `gpu.surface(canvas, opts)`. |
| options.adapter | `VGPUAdapter` | ✖ | `undefined` | Explicit adapter. If omitted in `vgpu`, `navigator.gpu.requestAdapter()` is used; `vgpu/node` and `vgpu/mock` provide adapter factories. |
| options.powerPreference | `GPUPowerPreference` | ✖ | `undefined` | Forwarded to `navigator.gpu.requestAdapter({ powerPreference })`. |
| options.requiredFeatures | `readonly GPUFeatureName[]` | ✖ | `undefined` | Forwarded to `adapter.requestDevice`. |
| options.requiredLimits | `RequiredDeviceLimits` | ✖ | `undefined` | Forwarded unchanged to `adapter.requestDevice`. Unsupported names/values reject device creation. |
| options.label | `string` | ✖ | `undefined` | Reserved public option; current main API (`vgpu`) device creation does not use it as a debug label. |

**Returns:** `Promise<Gpu>` — resolves to the main API facade with `surface`, `target`, `pass`, `draw`, `compute`, `frame`, buffers, uniforms, and bundles.

**Throws:** `VGPU-RING1-UNSUPPORTED` when WebGPU is unavailable, adapter request returns `null`, or an entrypoint lacks an adapter factory — use `vgpu/mock` in tests, `vgpu/node` in Node, or pass a valid adapter.

## Examples

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const target = gpu.target({ size: [64, 64], format: "rgba8unorm" });
const effect = gpu.effect(`
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, 0.0, 1.0);
  }
`);

gpu.frame((frame) => {
  frame.pass({ target }, (p) => p.draw(effect));
});
```

```ts
import { init } from "vgpu";

declare const canvas: HTMLCanvasElement;

const gpu = await init({
  // Request only when a vertex entry actually reads storage and the adapter supports it.
  requiredLimits: { maxStorageBuffersInVertexStage: 1 },
});
const surface = gpu.surface(canvas, { dpr: [1, 2] });
const effect = gpu.effect(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);

gpu.frame((frame) => {
  frame.pass({ target: surface }, (p) => p.draw(effect));
});
```

## Notes

- `init(canvas)` is intentionally not supported. Create surfaces explicitly with `gpu.surface(canvas)`.
- `size`, `dpr`, and `autoResize` are `SurfaceOptions`, not `InitOptions`.
- The browser, node, and mock entrypoints all use the same `init(options?)` shape.
- **See also:** `Gpu`, `Surface`, `Target`, `FrameRunner`.
