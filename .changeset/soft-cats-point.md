---
"@vgpu/render": minor
---

## Summary

Change `canvasMouseTracker` to expose both normalized and canvas-pixel coordinates on every reading. The removed `normalize` option is replaced by `position.normalized` and `position.canvasPixels`, and both outputs now account for the difference between CSS layout size and drawing-buffer resolution.

## Migration

### Affected usage

Update every `canvasMouseTracker` consumer that passes `normalize` or reads `position` as a coordinate tuple.

### Steps

Remove the `normalize` option. Replace tuple access with the coordinate space needed by the consumer:

```ts
const pointer = canvasMouseTracker({ canvas });

// Relative to the canvas, independent of drawing-buffer resolution.
const [normalizedX, normalizedY] = pointer.position.normalized;

// In the canvas drawing buffer's pixel space.
const [pixelX, pixelY] = pointer.position.canvasPixels;
```

Keep `flipY: true` when the target coordinate system uses a bottom-left origin; it is applied consistently to both outputs.

### Verification

Typecheck all consumers to find remaining tuple access and removed `normalize` options. At runtime, verify pointer alignment with a drawing buffer whose size differs from its CSS layout size, including any low-resolution intermediate buffer later upscaled by postprocessing.
