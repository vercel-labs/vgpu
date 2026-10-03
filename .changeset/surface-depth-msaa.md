---
"vgpu": minor
---

## Summary

Add opt-in depth and MSAA to canvas surfaces, so depth-tested, antialiased 3D — including `vgpu/scene` instance geometry — renders straight to the canvas without an offscreen target and present pass. `surface(gpu, canvas, { depth, msaa })` accepts `depth: true` (`"depth24plus"`) or an explicit depth-aspect format (`"depth16unorm"`, `"depth24plus"`, `"depth24plus-stencil8"`, `"depth32float"`, `"depth32float-stencil8"`, subject to native features), and `msaa: true` or `4` for four samples. Invalid values throw the new `VGPU-SURFACE-DEPTH-INVALID` and `VGPU-SURFACE-MSAA-INVALID`. `surface.depth` is an owned texture, stable until resize or dispose; the MSAA color attachment is private and resolves into `surface.color`, which remains the single-sample current canvas texture. `compile(surface)`, `compileSync(surface)`, Draw `targets`, and `bundle(gpu, { target: surface }, ...)` prepare against the configured format, depth format, and sample count without acquiring a canvas texture.

Surface resize now prepares replacement attachments before committing the new canvas size, DPR, and attachments together, then notifies and destroys the old attachments. A synchronous allocation failure destroys partial replacements and leaves the previous size, DPR, and attachments in place; a throwing listener no longer stops later listeners or the old-attachment cleanup, and its error is rethrown afterwards. Resizing the same surface from any replacement notification throws `VGPU-SURFACE-RESIZE-REENTRANT`. Direct `canvas.width`/`height` writes between frames reconcile owned attachments at the next frame boundary before user encoding, without public `onResize` callbacks; the pass descriptor also reconciles later writes before acquiring the canvas texture. Resize before encoding commands that use the attachments. `dispose()` destroys owned attachments even when an `onDestroy` listener throws.

## Migration

None: Existing `surface()` calls keep no depth attachment and one sample, so their pipelines, bundles, and render signatures are unchanged, and offscreen `target(gpu, { depth })` two-pass workflows remain supported. Direct canvas size writes still do not notify public resize listeners. A depth attachment is created only when you pass `depth`; bind an explicit single-sample `surface.depth` and rebind it after each resize, and read the current presentation with `surface.color` only before it presents. Use `surface.resize(...)` outside the frame to notify listeners and rebind the new depth before encoding.
