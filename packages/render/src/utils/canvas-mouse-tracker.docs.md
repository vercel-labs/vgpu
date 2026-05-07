# canvasMouseTracker

Tracks the latest pointer position over a canvas. Use it when a render loop needs the mouse position without storing event handlers in your app code.

```ts
const mouse = canvasMouseTracker({ canvas, normalize: true });
function draw() {
  const [x, y] = mouse.position;
  material.writeUniforms({ mouse: [x, y] });
}
```

Call `dispose()` when the canvas is removed.
