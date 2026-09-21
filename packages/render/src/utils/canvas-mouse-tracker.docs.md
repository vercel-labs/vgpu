# canvasMouseTracker

Tracks pointer coordinates relative to a canvas layout and drawing buffer.

## Import

```ts
import { canvasMouseTracker } from "@vgpu/render/utils";
```

## Signature

```ts
export function canvasMouseTracker(spec: CanvasMouseTrackerSpec): CanvasMouseTracker;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| spec | CanvasMouseTrackerSpec | ✔ | — | Options. |
| spec.canvas | HTMLCanvasElement | ✔ | — | Event target. |
| spec.flipY | boolean | ✖ | false | Flips Y in both outputs. |

**Returns:** `CanvasMouseTracker` — live `position` and `dispose()`.

## Examples

```ts
import { canvasMouseTracker } from "@vgpu/render/utils";

const canvas = document.createElement("canvas");
const mouse = canvasMouseTracker({ canvas, flipY: true });

const { normalized, canvasPixels } = mouse.position;
const targetPixels = [normalized[0] * 960, normalized[1] * 540];
console.log(canvasPixels, targetPixels);
```

## Notes

- Positions start at `[0, 0]`. Scale `normalized` for another target; `canvasPixels` uses the canvas buffer.
- **See also:** `canvasResolution`, `frameClock`

---

# CanvasMouseTrackerSpec

Tracker options.

## Fields

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| canvas | HTMLCanvasElement | ✔ | — | Canvas to track. |
| flipY | boolean | ✖ | false | Makes Y increase upward. |

---

# CanvasMouseTracker

Pointer tracker.

## Fields

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| position | CanvasMousePosition | ✔ | — | Frozen coordinate snapshot. |
| dispose | () => void | ✔ | — | Removes the listener. |

---

# CanvasMousePosition

Pointer coordinates.

## Fields

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| normalized | readonly [number, number] | ✔ | — | Canvas-relative position, normally `[0, 1]`. |
| canvasPixels | readonly [number, number] | ✔ | — | Drawing-buffer position. |
