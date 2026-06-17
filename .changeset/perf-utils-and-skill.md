---
"@vgpu/render": minor
"vgpu": minor
---

Add `@vgpu/render/perf` (`gpuFrameTime`, `pixelDiff`) — tooling to measure GPU time per frame and diff renders for the optimize loop, built on `Frame`/`Texture`/`device.queue.flush`. Not for hot paths.

Add three `@vgpu/render` pipeline/buffer primitives:

- Raw-descriptor pipeline support — `createRenderPipelineFromDescriptor` / `createRenderPipelineFromDescriptorAsync` forward a hand-built `GPURenderPipelineDescriptor` straight to WebGPU while keeping the same async→sync compatibility fallback as `createRenderPipelineAsync`, so an existing descriptor no longer has to be reshaped into `RenderPipelineOptions` just to get the fallback.
- `Uniform` — a single-buffer uniform helper (one `uniform | copy_dst` buffer plus a fixed binding-0 bind group, caller change-gated via `write()`) for the common "globals/camera per pass" case, where `UniformPool`'s dynamic-offset ring allocator is the wrong shape.
- `StorageBuffer` — the storage-buffer counterpart to `Uniform` (one `storage | copy_dst` buffer plus a fixed binding-0 bind group) for large/array/runtime-sized data. `access: "read"` (default) builds a `read-only-storage` binding; `access: "read-write"` builds a `storage` binding. Both default to `FRAGMENT | COMPUTE` visibility (no `VERTEX`): read-write storage is forbidden in the vertex stage, and read-only storage needs `maxStorageBuffersInVertexStage > 0` (0 on many adapters, including software/CI Vulkan), so vertex-stage storage is opt-in via an explicit `visibility` plus raised `requiredLimits`.

Add performance authoring guides under `docs/topics` (change-frequency model, pattern catalog, optimize pass, measuring, authoring-for-perf), served by `vgpu docs` as a first-class `guides` doc kind. `vgpu generate:docs` now auto-discovers guide docs and emits a generated skill mirror (`skills/vgpu`: a SKILL.md router + one `references/` file per doc) alongside the docs manifest.
