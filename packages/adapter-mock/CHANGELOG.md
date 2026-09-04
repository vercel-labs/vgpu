# @vgpu/adapter-mock

## 0.4.0

### Patch Changes

- @vgpu/core@0.4.0

## 0.3.1

### Patch Changes

- @vgpu/core@0.3.1

## 0.3.0

### Patch Changes

- @vgpu/core@0.3.0
- @vgpu/core@0.3.0

## 0.2.0

### Minor Changes

- 3da184f: Add `DrawOptions.unclippedDepth` to `draw(gpu)` and adapter feature checks for `init({ requiredFeatures })`. `unclippedDepth: true` maps to `GPUPrimitiveState.unclippedDepth`, disabling depth clipping so geometry outside `[near, far]` is not clipped; it requires the `"depth-clip-control"` device feature, checked against `device.features` at construction. A non-boolean value, or `true` on a device without the feature, throws `VGPU-UNCLIPPED-DEPTH-INVALID` with the exact `init({ requiredFeatures: ["depth-clip-control"] })` guidance. The option is emitted only when `true` and joins the pipeline cache key only when set, so draws without it — or with an explicit `false` — keep byte-identical descriptors and cache keys, while draws differing only in `unclippedDepth` compile distinct pipelines.

  `init({ requiredFeatures })` now validates requested features against the adapter's supported set before `requestDevice` in the browser, node, and mock adapters, failing with `VGPU-FEATURE-UNSUPPORTED` instead of a cryptic native rejection (`validateRequiredFeatures`/`unsupportedFeaturesError` are exported from `@vgpu/core`). `createMockAdapter({ features })` declares the features the mock adapter supports and `createMockGPUDevice({ features })` creates a device whose `features` set reflects them — faithful to WebGPU, a mock device enables exactly the requested features, so tests can exercise feature-gated paths with and without the grant.

### Patch Changes

- @vgpu/core@0.2.0

- Updated dependencies [0026ff2]
- Updated dependencies [f526de2]
- Updated dependencies [ccbdd95]
- Updated dependencies [8c186ae]
- Updated dependencies [d030381]
- Updated dependencies [388477e]
- Updated dependencies [e37f89d]
- Updated dependencies [bf7c688]
- Updated dependencies [12aa696]
- Updated dependencies [3da184f]
  - @vgpu/core@0.2.0
