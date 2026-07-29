---
"vgpu": minor
"@vgpu/core": minor
"@vgpu/adapter-mock": minor
"@vgpu/adapter-node": patch
---

Add `DrawOptions.unclippedDepth` to `draw(gpu)` and adapter feature checks for `init({ requiredFeatures })`. `unclippedDepth: true` maps to `GPUPrimitiveState.unclippedDepth`, disabling depth clipping so geometry outside `[near, far]` is not clipped; it requires the `"depth-clip-control"` device feature, checked against `device.features` at construction. A non-boolean value, or `true` on a device without the feature, throws `VGPU-UNCLIPPED-DEPTH-INVALID` with the exact `init({ requiredFeatures: ["depth-clip-control"] })` guidance. The option is emitted only when `true` and joins the pipeline cache key only when set, so draws without it — or with an explicit `false` — keep byte-identical descriptors and cache keys, while draws differing only in `unclippedDepth` compile distinct pipelines.

`init({ requiredFeatures })` now validates requested features against the adapter's supported set before `requestDevice` in the browser, node, and mock adapters, failing with `VGPU-FEATURE-UNSUPPORTED` instead of a cryptic native rejection (`validateRequiredFeatures`/`unsupportedFeaturesError` are exported from `@vgpu/core`). `createMockAdapter({ features })` declares the features the mock adapter supports and `createMockGPUDevice({ features })` creates a device whose `features` set reflects them — faithful to WebGPU, a mock device enables exactly the requested features, so tests can exercise feature-gated paths with and without the grant.
