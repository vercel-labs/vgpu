---
"@vgpu/render": patch
---

Fix `canvasMouseTracker` reporting positions at `1 / devicePixelRatio` scale.

`PointerEvent.offsetX/offsetY` are CSS pixels, but the tracker measured them against
`canvas.width`/`canvas.height`, which are drawing-buffer pixels. On any canvas sized for a
device pixel ratio — what `surface(gpu, canvas, { dpr: [1, 2] })` does — the two units differ,
so `normalize: true` reached only `1 / dpr` instead of `1`, and `flipY` in pixel mode computed
`bufferHeight - cssY`, leaving the flipped value stuck in the top part of its range.

Pointer readings are now scaled from the CSS box into the drawing buffer before being
normalized or flipped. Behavior at `dpr: 1` is unchanged.
