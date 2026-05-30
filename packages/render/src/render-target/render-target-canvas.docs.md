# renderTargetForCanvas

`renderTargetForCanvas(context, options?)` adapts the current texture from a
`GPUCanvasContext` into a render target that can be passed to `pass()` and other
`@vgpu/render/passes` helpers.

The returned target resolves its `color` view lazily each time it is read, so it
tracks `context.getCurrentTexture()` across frames. Use `label` and `clearColor`
in the options object to configure the generated attachment metadata and default
clear color.

```ts
const target = renderTargetForCanvas(canvasContext, { label: "screen" });
pass({ mesh, material, target });
```
