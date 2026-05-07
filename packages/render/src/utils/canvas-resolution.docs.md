# canvasResolution

Reads the drawing size of a canvas. Use it when shaders or render targets need the current canvas width and height.

```ts
const size = canvasResolution(canvas, { observe: true });
function draw() {
  material.writeUniforms({ resolution: [size.width, size.height] });
  renderer.draw({ target, material, mesh });
}
```

Call `dispose()` to stop observing size changes.
