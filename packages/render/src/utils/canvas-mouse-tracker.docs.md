# canvasMouseTracker

Tracks the latest pointer position over a canvas. Use it when a render loop needs mouse coordinates without storing DOM event handlers in app state.

```ts
import { canvasMouseTracker } from "@vgpu/render/utils";

const mouse = canvasMouseTracker({ canvas, normalize: true });
function frame() {
  pass.set({ mouse: mouse.position });
}
```

Call `dispose()` when the canvas is removed.
