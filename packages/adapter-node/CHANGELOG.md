# @vgpu/adapter-node

## 0.4.0

### Patch Changes

- @vgpu/core@0.4.0

## 0.3.1

### Patch Changes

- @vgpu/core@0.3.1

## 0.3.0

### Patch Changes

- @vgpu/core@0.3.0
- 12b4efa: Label the CPU software renderer fallback so the native Vulkan/XDG_RUNTIME_DIR startup lines stop reading as fatal errors. The Node adapter now prints one `vgpu: notice — …` block on stderr (once per process, after the adapter is known, so it lands below the native lines it explains) that names the selected CPU renderer, states that rendering continues normally, and says the Dawn/Vulkan loader/Mesa `error`/`Warning` lines above come from the driver stack and are harmless. The notice also covers runs where Dawn selects a CPU adapter directly, not just the consented portable-renderer retry; explicit `adapter: "software"` stays silent.
  - @vgpu/core@0.3.0

## 0.1.7

### Patch Changes

- @vgpu/core@0.2.0

- 3da184f: Add `DrawOptions.unclippedDepth` to `draw(gpu)` and adapter feature checks for `init({ requiredFeatures })`. `unclippedDepth: true` maps to `GPUPrimitiveState.unclippedDepth`, disabling depth clipping so geometry outside `[near, far]` is not clipped; it requires the `"depth-clip-control"` device feature, checked against `device.features` at construction. A non-boolean value, or `true` on a device without the feature, throws `VGPU-UNCLIPPED-DEPTH-INVALID` with the exact `init({ requiredFeatures: ["depth-clip-control"] })` guidance. The option is emitted only when `true` and joins the pipeline cache key only when set, so draws without it — or with an explicit `false` — keep byte-identical descriptors and cache keys, while draws differing only in `unclippedDepth` compile distinct pipelines.

  `init({ requiredFeatures })` now validates requested features against the adapter's supported set before `requestDevice` in the browser, node, and mock adapters, failing with `VGPU-FEATURE-UNSUPPORTED` instead of a cryptic native rejection (`validateRequiredFeatures`/`unsupportedFeaturesError` are exported from `@vgpu/core`). `createMockAdapter({ features })` declares the features the mock adapter supports and `createMockGPUDevice({ features })` creates a device whose `features` set reflects them — faithful to WebGPU, a mock device enables exactly the requested features, so tests can exercise feature-gated paths with and without the grant.

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
