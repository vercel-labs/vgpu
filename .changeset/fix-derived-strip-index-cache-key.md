---
"vgpu": patch
---

Fix render-pipeline cache collisions for strip-topology geometries that derive `stripIndexFormat` from `indexFormat`. The derived format now participates in the cache key exactly as it does in the WebGPU pipeline descriptor, so `uint16` and `uint32` strip meshes cannot incorrectly share a pipeline.
