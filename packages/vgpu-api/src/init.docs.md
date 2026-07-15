# init

Creates a main API (`vgpu`) `Gpu` context. Use the browser entrypoint with a canvas, or the `vgpu/node` / `vgpu/mock` entrypoints for headless and tests.

## Import

```ts
import { init } from "vgpu";
```

Browser is `vgpu`; Node is `vgpu/node`; tests can use `vgpu/mock`.

## Signature

```ts
import type { Gpu } from "vgpu";

declare function init(canvas: HTMLCanvasElement | OffscreenCanvas, options?: InitOptions): Promise<Gpu>;
declare function init(options?: InitOptions): Promise<Gpu>;

interface InitOptions {
  readonly adapter?: import("vgpu/core").VGPUAdapter;
  readonly size?: readonly [number, number];
  readonly dpr?: number | readonly [number, number];
  readonly autoResize?: boolean;
  readonly powerPreference?: GPUPowerPreference;
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly requiredLimits?: Record<string, number>;
  readonly label?: string;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| canvas | `HTMLCanvasElement \| OffscreenCanvas` | ✖ | `undefined` | Browser-only positional canvas. When provided, `gpu.screen` is configured from `canvas.getContext("webgpu")`. |
| options | `InitOptions` | ✖ | `{}` | Device and screen creation options. If no canvas is passed, this is the first argument. |
| options.adapter | `VGPUAdapter` | ✖ | `undefined` | Explicit adapter. If omitted in `vgpu`, `navigator.gpu.requestAdapter()` is used; if omitted in internal `node`/`mock` creation, an adapter factory is required. |
| options.size | `readonly [number, number]` | ✖ | Canvas size × DPR, or `[1, 1]` for offscreen targets created later | Initial device-pixel canvas size. Also overrides DPR-derived canvas sizing. |
| options.dpr | `number \| readonly [number, number]` | ✖ | `globalThis.devicePixelRatio ?? 1` | Number fixes DPR. Tuple clamps runtime DPR to `[min, max]`. |
| options.autoResize | `boolean` | ✖ | `true` when a canvas screen exists | On each `gpu.frame` advance, resizes `gpu.screen` to current canvas CSS size × DPR. |
| options.powerPreference | `GPUPowerPreference` | ✖ | `undefined` | Forwarded to `navigator.gpu.requestAdapter({ powerPreference })`. |
| options.requiredFeatures | `readonly GPUFeatureName[]` | ✖ | `undefined` | Forwarded to `adapter.requestDevice`. |
| options.requiredLimits | `Record<string, number>` | ✖ | `undefined` | Forwarded to `adapter.requestDevice`. Use for limits such as storage buffers in vertex stage. |
| options.label | `string` | ✖ | `undefined` | Reserved public option; current main API (`vgpu`) device creation does not use it as a debug label. |

**Returns:** `Promise<Gpu>` — resolves to the shared main API (`vgpu`) facade with `device`, `gpu`, optional `screen`, `pass`, `draw`, `compute`, `frame`, targets, buffers, uniforms, and bundles.

**Throws:** `VGPU-RING1-UNSUPPORTED` when WebGPU is unavailable, adapter request returns `null`, a canvas cannot create a `webgpu` context, or an entrypoint lacks an adapter factory — use `vgpu/mock` in tests, `vgpu/node` in Node, or pass a valid canvas/adapter.

## Examples

```ts
import { init } from "vgpu/mock";

const gpu = await init({ size: [64, 64] });
const target = gpu.target({ size: [64, 64], format: "rgba8unorm" });
const pass = gpu.pass(`
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, 0.0, 1.0);
  }
`);

gpu.frame((frame) => {
  frame.pass({ target }, (p) => p.draw(pass));
});
```

```ts
import { init } from "vgpu/mock";

const gpu = await init({ size: [320, 180], dpr: [1, 2], autoResize: false });
const unsubscribe = gpu.onResize((size) => {
  gpu.screen?.resize(size);
});
unsubscribe();
```

## Notes

- `gpu.time`, `gpu.deltaTime`, and `gpu.frameCount` are JS counters advanced by `gpu.frame` / `gpu.frame.loop`; they are never implicit shader bindings.
- `autoResize` affects only canvas-backed `gpu.screen`. Offscreen `gpu.target()` resources resize only when you call `target.resize(size)`.
- In browser code, import from `vgpu`; in Node or CI examples, import from `vgpu/node` or `vgpu/mock` so the adapter exists.
- **See also:** `Gpu`, `FrameRunner`, `Target`, `Pass`, `Draw`, `Compute`.
