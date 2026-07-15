# canvasResolution

Reads the current drawing buffer size of a canvas and optionally watches for resize changes. Use it when you need `[width, height]` uniforms without wiring observers manually.

## Import

```ts
import { canvasResolution } from "@vgpu/render/utils";
```

## Signature

```ts
export function canvasResolution(
  canvas: HTMLCanvasElement,
  opts?: { readonly observe?: boolean },
): CanvasResolution;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| canvas | HTMLCanvasElement | ✔ | — | Target element; `width`/`height` are read from its drawing buffer, not CSS pixels. |
| opts | { observe?: boolean } | ✖ | — | Optional behavior flags. |
| opts.observe | boolean | ✖ | false | When true, attaches a `ResizeObserver` that keeps the cached width/height in sync. |

**Returns:** `CanvasResolution` — exposes `width`, `height`, and `dispose()`. `width/height` update lazily or via the observer depending on options.

## Examples

```ts
const resolution = canvasResolution(canvas, { observe: true });

function frame() {
  pass.set({ resolution: [resolution.width, resolution.height] });
  requestAnimationFrame(frame);
}

frame();
// Later:
resolution.dispose();
```

## Notes

- When `observe` is `false`, `width`/`height` report the last stored values; update the canvas attributes yourself when resizing.
- The helper calls `ResizeObserver.observe(canvas)` only when `observe: true`; call `dispose()` before removing the canvas to disconnect the observer.
- The returned values reflect the drawing buffer size (`canvas.width/height`), which already accounts for DPR scaling if you manage it manually.
- **See also:** `canvasMouseTracker`, `frameClock`
