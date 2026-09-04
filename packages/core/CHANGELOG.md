# @vgpu/core

## 0.4.0

### Patch Changes

- Updated dependencies [8b2282c]
  - @vgpu/wgsl@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [e2b4c4a]
  - @vgpu/wgsl@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [b86fe6e]
  - @vgpu/wgsl@0.3.0
- Updated dependencies [1451232]
- Updated dependencies [6ea8edf]
- Updated dependencies [42bffb4]
- Updated dependencies [1e27582]
- Updated dependencies [836116e]
- Updated dependencies [43dfa78]
- Updated dependencies [d1b73c8]
- Updated dependencies [1255833]
- Updated dependencies [9812605]
  - @vgpu/wgsl@0.3.0

## 0.2.0

### Minor Changes

- 0026ff2: Add `DrawOptions.blendConstant` to `draw(gpu)`, closing the gap where `"constant"`/`"one-minus-constant"` blend factors were stuck at the initial `(0, 0, 0, 0)`. The constant is `[r, g, b, a]` finite numbers (values outside `[0, 1]` are allowed), emitted as `setBlendConstant` encoder state after `setPipeline` and before the draw — it is not part of the pipeline, so draws differing only in `blendConstant` share pipelines. A malformed value, or one paired with a `blend` that uses no constant factor, throws `VGPU-BLEND-CONSTANT-INVALID` at construction; constant factors without `blendConstant` stay legal and use the WebGPU pass default. Render bundles cannot set the pass blend constant, so `bundle` rejects recording such draws with `VGPU-BUNDLE-BLEND-CONSTANT`.
- f526de2: Adopt a `GPUDevice` vgpu did not create, so an ML runtime and vgpu can share one device and one queue instead of round-tripping tensors through the CPU.

  `initFromDevice(device)` — exported from `vgpu`, `vgpu/node` and `vgpu/mock` — returns the same `Gpu` as `init()`, wrapping a device owned by someone else (ONNX Runtime Web, WebLLM, transformers.js, a host engine). It is a separate entry point rather than an `init()` option on purpose: a program that lets vgpu create its own device never bundles the adoption path. Adoption is non-owning — `gpu.dispose()` drops vgpu's wrapper and leaves the native device to its owner — and because that owner can destroy or lose the device at any time, every entry point re-checks it instead of trusting the handle. The device is validated structurally (not by `instanceof`, so a device from a worker, an iframe or a test double is accepted) and a malformed one throws `VGPU-INIT-DEVICE-INVALID`; a device that is already lost is detected before `initFromDevice()` resolves, so you never get back a `Gpu` that fails on first use.

  `Device.wrapBuffer(gpuBuffer)` (`@vgpu/core`) wraps a caller-owned `GPUBuffer` as a vgpu `Buffer` without taking ownership of its native lifetime — size, usage and label are read off the buffer itself. Disposing the wrapper releases only vgpu's handle; the runtime that allocated the buffer still owns it. A value that is not a live `GPUBuffer` with finite `size`/`usage` throws `VGPU-EXTERNAL-BUFFER-INVALID`.

- ccbdd95: Add `timer(gpu)` for GPU pass timing. `timer.span(name)` passed as `FramePassOptions.timer` writes a begin/end timestamp pair around the pass via the pass descriptor's `timestampWrites`; each frame appends a single `resolveQuerySet` of the contiguous used range to the frame encoder before submit, and results are read back through rotated staging buffers without ever blocking a frame. Decoded durations arrive in milliseconds through `timer.onResults(cb)`, keyed by span name, typically 1–2 frames after submit; timestamps are implementation-defined ns ticks and negative deltas (counter resets) are clamped to 0. Requires the `"timestamp-query"` device feature — `timer(gpu)` throws `VGPU-TIMER-INVALID` at creation without it, pointing at `init({ requiredFeatures: ["timestamp-query"] })`. The same code covers duplicate span names within one frame, spans used across gpus, malformed `timer` options, and disposed timers; capacity starts at 32 spans and grows only at frame boundaries up to WebGPU's 4096-query set limit (2048 spans per frame, beyond which `VGPU-TIMER-CAPACITY` throws). Failed asynchronous query readbacks are dropped without rejecting the frame and reported through `gpu.onError` as `VGPU-QUERY-READBACK`. The mock GPU device now supports the full path — `createQuerySet` (instrumented), `timestampWrites` on pass descriptors, `resolveQuerySet` writing deterministic fake u64 values, and real `copyBufferToBuffer` between mock buffers — so timing is testable end-to-end with `createMockAdapter({ features: ["timestamp-query"] })`.
- 8c186ae: Add `visibility(gpu)` for occlusion queries — core WebGPU, no device feature required. A pass opened with the new `FramePassOptions.visibility` carries the instance's occlusion query set, and the new `FramePass.occlusion(query, body)` wraps a proxy draw (a `Draw`, an `Effect`, or a callback encoding several draws) in `beginOcclusionQuery`/`endOcclusionQuery` on a per-frame contiguous slot; one `resolveQuerySet` of the used range is appended to the frame encoder before submit and read back without ever blocking a frame. Results are zero vs non-zero only, per the WebGPU occlusion semantics, and latch asynchronously into stable `vis.query(label)` handles: `q.hidden` is `true` only when a completed query confirmed zero passing samples (unknown/visible read as `false` — the safe default is to draw), `q.state` reports `"visible" | "hidden" | "unknown"`, and `q.age` counts frames since the last applied result. `reset()` (per handle or whole instance) flips state to `"unknown"` immediately and discards in-flight pre-reset readbacks, for camera cuts; `dispose()` frees a handle's label for reuse safely. Capacity is a declared contract (`{ capacity }`, default 64, max 4096 — `VGPU-VIS-CAPACITY-LIMIT`); overflowing it throws `VGPU-VIS-CAPACITY` at the offending `occlusion()` call. Validation also covers `VGPU-VIS-LABEL-DUPLICATE`, `VGPU-VIS-DISPOSED`, `VGPU-VIS-NO-DEPTH` (occlusion culling needs a depth attachment), `VGPU-QUERY-NO-VISIBILITY`, `VGPU-QUERY-NESTED`, `VGPU-QUERY-DUPLICATE` (same handle twice in one frame, across passes too), and `VGPU-VIS-INVALID` for mismatched instances or gpus. Draws replayed from bundles inside an occlusion scope count toward the active query. Failed asynchronous query readbacks are dropped without rejecting the frame and reported through `gpu.onError` as `VGPU-QUERY-READBACK`. The mock GPU render pass encoder now records `beginOcclusionQuery`/`endOcclusionQuery` scopes (instrumented no-ops), so the whole path is testable end-to-end.
- d030381: Add GPU-driven indirect draws and compute dispatches. `storage(gpu, bytes, { indirect: true })` — the second argument now also accepts a `StorageOptions` bag `{ access?, indirect? }` — appends the `"indirect"` buffer usage. `DrawCallOptions.indirect` (a `StorageBuffer` or `{ buffer, offset? }`, offset defaulting to `0`) encodes `drawIndirect` for non-indexed draws (4 u32 arguments, 16 bytes) or `drawIndexedIndirect` for indexed geometries (5 32-bit arguments, 20 bytes; the index buffer is still set), in one-shot `draw.draw()`, `FramePass.draw`, and `bundle` recording alike. `Compute.dispatch({ indirect })` encodes `dispatchWorkgroupsIndirect` (3 u32 counts, 12 bytes); positional `dispatch(x, y?, z?)` is unchanged. `VGPU-INDIRECT-INVALID` throws at call time for a malformed value, a buffer created without the indirect flag, an offset that is not a non-negative multiple of 4, arguments that do not fit the buffer, or `indirect` combined with CPU-side counts in the same call. Per the WebGPU spec, a non-zero buffered `firstInstance` needs the `"indirect-first-instance"` feature or the indirect draw is treated as a no-op — GPU-side data that cannot be validated on the CPU.
- e37f89d: Add per-pass `viewport` and `scissor` options to `FramePassOptions`. Both are emitted once right after the pass opens and apply to every draw in the pass, including replayed bundles. `viewport` is `{ x?, y?, width, height, minDepth?, maxDepth? }` (defaults `x`/`y` `0`, `minDepth` `0`, `maxDepth` `1`) following WebGPU `setViewport` rules — float pixels bounded by device limits, `minDepth <= maxDepth` — and throws `VGPU-PASS-VIEWPORT-INVALID` at pass open otherwise. `scissor` is `[x, y, width, height]` non-negative integers validated at pass open against the target's current pixel size (targets are resizable), throwing `VGPU-PASS-SCISSOR-INVALID` with the current size in the message when out of bounds. The scissor clips draws only; a clearing pass still clears the full attachment.
- bf7c688: Add `DrawOptions.stencil` to `draw(gpu)` and `FramePassOptions.clearStencil` to `Frame.pass`. `stencil` is constructor-only `{ front?, back?, readMask?, writeMask?, ref? }` state for targets whose depth format has a stencil aspect: `front`/`back` map to `GPUDepthStencilState.stencilFront`/`stencilBack` (`compare`/`fail`/`depthFail`/`pass` → `compare`/`failOp`/`depthFailOp`/`passOp`, defaults `"always"`/`"keep"`), omitted `back` mirrors the normalized `front`, and `readMask`/`writeMask` (u32, default `0xFFFFFFFF`) map to `stencilReadMask`/`stencilWriteMask`, merging into the same depth-stencil state as the `depth` option. Unset fields stay omitted, so draws without the option keep byte-identical descriptors and pipeline cache keys; draws that differ only in stencil pipeline state compile distinct pipelines. `ref` is encoder state emitted as `setStencilReference` before the draw (only when provided, including an explicit `0`) and stays out of the pipeline key, so draws differing only in `ref` share pipelines; render bundles reject recording draws whose stencil has `ref` with `VGPU-BUNDLE-STENCIL-REF` (bundle encoders cannot set the pass stencil reference), while stencil without `ref` records fine. Malformed stencil options throw `VGPU-STENCIL-INVALID` at construction, and any stencil state against a signature whose depth format lacks a stencil aspect throws `VGPU-STENCIL-INVALID` at compile/draw time suggesting `depth: "depth24plus-stencil8"`. `clearStencil` (integer in `[0, 0xFFFFFFFF]`, default `0`, masked by WebGPU to the stencil aspect's bit width) threads into the pass depth-stencil attachment's `stencilClearValue`; invalid values or a target without a stencil aspect throw `VGPU-PASS-CLEARSTENCIL-INVALID`, and combining it with `clear: false` throws `VGPU-PASS-PRESERVE-CLEARSTENCIL`.
- 12aa696: Support float texture formats in texture/target readback, closing the gap where `target.read()` on an HDR target threw `VGPU-CORE-UNSUPPORTED-FORMAT`.

  `Texture.read()`, `Target.read()`, and `Surface.read()` now copy back `rgba16float`, `rgba32float`, `r16float`, `rg16float`, `r32float`, `rg32float`, `r8unorm`, and `rg8unorm` in addition to the existing `rgba8unorm` / `rgba8unorm-srgb` / `bgra8unorm` / `bgra8unorm-srgb`. `read()` keeps its `Promise<Uint8Array>` signature and returns the raw unpadded texel bytes of the texture's own format (`width * height * bytesPerPixel`), so `rgba8unorm` readback is byte-for-byte unchanged.

  New `Texture.readFloats()` / `Target.readFloats()` / `Surface.readFloats()` return a `Float32Array` with one f32 per component (row-major, `width * height * components` long): binary16 texels are widened to f32 (subnormals, infinities, and NaN included), f32 texels are copied verbatim, and `unorm8` texels are normalized to `[0, 1]` without srgb gamma conversion — so HDR values above `1` and negatives survive the readback instead of being clamped into bytes.

  Formats outside that table (depth/stencil, packed such as `rgb10a2unorm` / `rg11b10ufloat`, snorm/uint/sint, and compressed) still throw `VGPU-CORE-UNSUPPORTED-FORMAT`, now listing the supported formats in the message.

  The mock device also gained a real `queue.writeTexture` and allocates its texel storage from the texture's format and layer count, so `writeTexture` + `read()` / `readFloats()` round-trips per format on the mock adapter with the same byte layout a real device produces: `bytesPerRow` / `rowsPerImage` padding, `origin` (including array layers) and the `bgra*` → RGBA swizzle all behave as they do on a real readback, `read()` returns layer 0 like `copyTextureToBuffer` does, and unsupported formats are rejected on the mock exactly as they are on a real device. The mock stores mip 0 only, so `writeTexture` with `mipLevel > 0` now throws instead of silently corrupting mip 0.

  Note for custom `Target` implementers (pre-1.0): the `Target` interface gained a required `readFloats(): Promise<Float32Array>` member. Delegating to `this.color.readFloats()` — what `target(gpu)` and `surface(gpu)` do — is enough.

- 3da184f: Add `DrawOptions.unclippedDepth` to `draw(gpu)` and adapter feature checks for `init({ requiredFeatures })`. `unclippedDepth: true` maps to `GPUPrimitiveState.unclippedDepth`, disabling depth clipping so geometry outside `[near, far]` is not clipped; it requires the `"depth-clip-control"` device feature, checked against `device.features` at construction. A non-boolean value, or `true` on a device without the feature, throws `VGPU-UNCLIPPED-DEPTH-INVALID` with the exact `init({ requiredFeatures: ["depth-clip-control"] })` guidance. The option is emitted only when `true` and joins the pipeline cache key only when set, so draws without it — or with an explicit `false` — keep byte-identical descriptors and cache keys, while draws differing only in `unclippedDepth` compile distinct pipelines.

  `init({ requiredFeatures })` now validates requested features against the adapter's supported set before `requestDevice` in the browser, node, and mock adapters, failing with `VGPU-FEATURE-UNSUPPORTED` instead of a cryptic native rejection (`validateRequiredFeatures`/`unsupportedFeaturesError` are exported from `@vgpu/core`). `createMockAdapter({ features })` declares the features the mock adapter supports and `createMockGPUDevice({ features })` creates a device whose `features` set reflects them — faithful to WebGPU, a mock device enables exactly the requested features, so tests can exercise feature-gated paths with and without the grant.

### Patch Changes

- Updated dependencies [2856407]
- Updated dependencies [3731a3c]
- Updated dependencies [eba8e4d]

  - @vgpu/wgsl@0.2.0

- 388477e: Implement `copyTextureToTexture` on the mock command encoder so code that builds mip chains or copies between textures boots on the mock adapter.
- Updated dependencies [47f7ec8]
- Updated dependencies [f526de2]
- Updated dependencies [8fc4daf]
  - @vgpu/wgsl@0.2.0
