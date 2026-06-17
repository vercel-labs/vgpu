---
"@vgpu/render": minor
"vgpu": minor
---

Add `@vgpu/render/perf` (`gpuFrameTime`, `pixelDiff`) — tooling to measure GPU time per frame and diff renders for the optimize loop, built on `Frame`/`Texture`/`device.queue.flush`. Not for hot paths.

Add performance authoring guides under `docs/topics` (change-frequency model, pattern catalog, optimize pass, measuring, authoring-for-perf), served by `vgpu docs` as a first-class `guides` doc kind. `vgpu generate:docs` now auto-discovers guide docs and emits a generated skill mirror (`docs/skill`: a SKILL.md router + one `references/` file per doc) alongside the docs manifest.
