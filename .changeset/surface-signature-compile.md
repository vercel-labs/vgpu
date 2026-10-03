---
"vgpu": minor
---

## Summary

Prepare pipelines and render bundles against a live `Surface` outside a frame. `Draw`/`Effect` `compile()` and `compileSync()`, Draw constructor `targets`, and `bundle(gpu, { target: surface }, ...)` now read the surface's configured render signature — its `format`, configured depth format, and sample count — without acquiring a canvas texture, reading or allocating attachments, resizing the canvas, or submitting work. A surface and the equivalent explicit signature share cached pipelines, and size-only resizes keep compiled pipelines and recorded bundles valid. Preparing against a disposed surface still throws `VGPU-SURFACE-DISPOSED`; drawing to a surface outside a frame still throws `VGPU-SURFACE-NOT-IN-FRAME`, now with a fix that points to the accepted preparation calls.

## Migration

None: Existing target/signature preparation remains supported; Surface preparation is newly accepted outside frames and rendering still uses frame/frameLoop.
