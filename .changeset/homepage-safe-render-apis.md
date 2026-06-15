---
"@vgpu/core": minor
"@vgpu/render": minor
---

Add descriptor-like render pipeline options and async render pipeline creation with explicit fallback policy. The `@vgpu/core` minor covers formal mock GPU test utilities: async render-pipeline mock support plus mock device instrumentation for validating homepage-safe render hot paths. Documentation now calls out raw `.gpu` escape hatches, Frame's one-encoder/one-submit contract, render bundle rebuild lifecycle caveats, and render hot-path caveats.
