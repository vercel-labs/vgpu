# Surface

Canvas-backed render target created by `gpu.surface(canvas, opts)`. Use it for browser canvases, `OffscreenCanvas`, multi-canvas rendering, and resize-driven derived targets.

## Import

```ts
import type { Surface, SurfaceOptions, SurfaceResizeEvent } from "vgpu";
```

## Signature

```ts
import type { Target } from "vgpu";

interface SurfaceOptions {
  readonly autoResize?: boolean;
  readonly dpr?: number | readonly [number, number];
  readonly size?: readonly [number, number];
  readonly format?: GPUTextureFormat;
  readonly alphaMode?: GPUCanvasAlphaMode;
  readonly colorSpace?: PredefinedColorSpace;
  readonly label?: string;
}

interface SurfaceResizeEvent {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly surface: Surface;
}

interface Surface extends Target {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly context: GPUCanvasContext;
  readonly autoResize: boolean;
  readonly layoutBacked: boolean;
  readonly dpr: number;
  readonly disposed: boolean;
  onResize(cb: (event: SurfaceResizeEvent) => void): () => void;
  dispose(): void;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| gpu.surface.canvas | `HTMLCanvasElement \| OffscreenCanvas` | ✔ | — | Must return a `GPUCanvasContext` from `getContext("webgpu")`. |
| gpu.surface.opts | `SurfaceOptions` | ✖ | `{}` | Canvas configuration and resize behavior. |
| opts.autoResize | `boolean` | ✖ | `true` for layout-backed canvases, `false` when `size` is provided or when the canvas has no numeric `clientWidth` | Auto-resize is checked at the frame boundary before user frame callbacks. Explicit `true` on buffer-only canvases throws. |
| opts.dpr | `number \| readonly [number, number]` | ✖ | `globalThis.devicePixelRatio ?? 1` | Number fixes DPR. Tuple clamps runtime DPR to `[min, max]`; layout-backed surfaces re-read DPR each frame. |
| opts.size | `readonly [number, number]` | ✖ | Layout-backed: `clientWidth/clientHeight × dpr`; buffer-only: existing `canvas.width/height` | Physical pixel size. When provided, initial canvas buffer is set and `autoResize` defaults to `false`. |
| opts.format | `GPUTextureFormat` | ✖ | `navigator.gpu.getPreferredCanvasFormat() ?? "bgra8unorm"` | Canvas swapchain format. |
| opts.alphaMode | `GPUCanvasAlphaMode` | ✖ | `"premultiplied"` | Passed to `GPUCanvasContext.configure`. |
| opts.colorSpace | `PredefinedColorSpace` | ✖ | `"srgb"` | Passed to `GPUCanvasContext.configure`. |
| opts.label | `string` | ✖ | `undefined` | Used in error messages and texture labels. |
| onResize.cb | `(event: SurfaceResizeEvent) => void` | ✔ | — | Called synchronously immediately on subscription and after future size changes. |
| event.width | `number` | ✔ | — | Physical pixel width, equal to `surface.size[0]` and `canvas.width`. |
| event.height | `number` | ✔ | — | Physical pixel height, equal to `surface.size[1]` and `canvas.height`. |
| event.dpr | `number` | ✔ | — | Effective DPR used for the current size. |
| event.surface | `Surface` | ✔ | — | Surface that resized, useful for shared handlers. |
| surface.resize.size | `readonly [number, number]` | ✔ | — | Manual physical pixel size. Values are floored and clamped to at least `1`. |

**Returns:** `gpu.surface()` returns `Surface`; `onResize()` returns an unsubscribe function; `dispose()` returns `void`.

**Throws:** `VGPU-SURFACE-CONTEXT` when `getContext("webgpu")` returns `null`; `VGPU-SURFACE-DUPLICATE` when a live surface already owns the canvas; `VGPU-SURFACE-AUTORESIZE-UNSUPPORTED` for explicit `autoResize: true` on buffer-only canvases; `VGPU-SURFACE-DISPOSED` when using a disposed surface; `VGPU-SURFACE-RESIZE-REENTRANT` when resizing the same surface from its own resize callback; `VGPU-FRAME-REENTRANT` when `gpu.frame()` is called from any `onResize` callback. The immediate `onResize` fire on subscription also counts as being inside an `onResize` callback, so call `gpu.frame()` before subscribing or from code outside the callback.

## Examples

```ts
import { init } from "vgpu";

declare const canvas: HTMLCanvasElement;

const gpu = await init();
const surface = gpu.surface(canvas, { dpr: [1, 2] });
const wave = gpu.effect(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.2, 0.6, 1, 1); }`);

gpu.frame((frame) => {
  frame.pass({ target: surface }, (pass) => pass.draw(wave));
});
```

```ts
import { init } from "vgpu/mock";

const gpu = await init();
declare const canvas: HTMLCanvasElement;
const surface = gpu.surface(canvas);

const bloomSize = (w: number, h: number): [number, number] => [w / 2, h / 2];
const bloom = gpu.target({ size: bloomSize(surface.size[0], surface.size[1]) });
const brightPass = gpu.effect(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);
const composite = gpu.effect(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);

surface.onResize(({ width, height }) => {
  bloom.resize(bloomSize(width, height));
  brightPass.set({ resolution: [width / 2, height / 2] });
});

gpu.frame((frame) => {
  frame.pass({ target: bloom }, (pass) => pass.draw(brightPass));
  frame.pass({ target: surface }, (pass) => pass.draw(composite));
});
```

```ts
import { init } from "vgpu";

declare const canvasA: HTMLCanvasElement;
declare const canvasB: HTMLCanvasElement;

const gpu = await init();
const main = gpu.surface(canvasA);
const preview = gpu.surface(canvasB, { autoResize: false, size: [320, 180] });
const effect = gpu.effect(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);

gpu.frame((frame) => {
  frame.pass({ target: main }, (p) => p.draw(effect));
  frame.pass({ target: preview }, (p) => p.draw(effect));
});
```

```ts
import { init } from "vgpu";

declare const offscreen: OffscreenCanvas;
declare function postMessage(message: unknown): void;

const gpu = await init();
const surface = gpu.surface(offscreen);
const half = gpu.target({ size: [Math.max(1, surface.size[0] / 2), Math.max(1, surface.size[1] / 2)] });

surface.onResize(({ width, height }) => {
  half.resize([width / 2, height / 2]);
  postMessage({ type: "resized", width, height });
});

surface.resize([640, 360]);
```

```ts
import { init } from "vgpu/mock";

declare const canvas: HTMLCanvasElement;

const gpu = await init();
const surface = gpu.surface(canvas);
const draw = gpu.effect(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);
let statics = gpu.bundle({ target: surface }, (bundle) => bundle.draw(draw));

surface.onResize(() => {
  statics = gpu.bundle({ target: surface }, (bundle) => bundle.draw(draw));
});

gpu.frame((frame) => frame.pass({ target: surface }, (pass) => pass.bundles(statics)));
```

## Notes

- Layout-backed detection is structural: `typeof canvas.clientWidth === "number"`; it does not use `instanceof`.
- Resize callbacks run in surface creation order at the frame boundary, before the user frame callback.
- Manual `surface.resize()` fires callbacks synchronously at the call site and works for `OffscreenCanvas`.
- `surface.read()` returns RGBA bytes. Canvas formats `bgra8unorm` and `bgra8unorm-srgb` are supported and swizzled to RGBA, which matters on platforms where `navigator.gpu.getPreferredCanvasFormat()` returns BGRA.
- A canvas can have only one live surface. Call `surface.dispose()` before creating another one for the same canvas.
- **See also:** `init`, `Gpu.surface`, `Target`, `Frame`, `Bundle`.
