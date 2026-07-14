# `createRenderBundle` / `RenderBundleRecorder`

Low-level render-bundle escape hatch. Prefer ring-1 `gpu.bundle({ target }, recorder => recorder.draw(draw))`, which derives formats/sample count from the target and participates in R3 staleness detection.
