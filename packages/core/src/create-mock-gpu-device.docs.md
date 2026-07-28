# createMockGPUDevice

`createMockGPUDevice()` creates the in-memory WebGPU-shaped object used by the mock
adapter. It is public so `@vgpu/adapter-mock` can expose the same adapter contract as
other adapters while keeping mock storage logic local to core tests.

The mock device exposes stable, plausible `limits` and a setlike `features` object
so tests can exercise capability inspection through `Device.limits` and
`Device.features`. Optional features are not enabled by default; pass
`createMockGPUDevice({ features: [...] })` to create a device whose `features`
set reflects the given names, mirroring a device requested with those
`requiredFeatures`.

Query paths are testable end-to-end: `createQuerySet` returns an instrumented mock
query set (`type`, `count`, `label`, `destroy()`), render pass descriptors may carry
`timestampWrites`, the command encoder's `resolveQuerySet` writes deterministic fake
u64 values into the destination mock buffer's storage — query index `i` resolves to
`i * i * 1e6`, so a timestamp pair `(2k, 2k + 1)` decodes to a positive, per-pair-distinct
delta of `(4k + 1)` ms — and `copyBufferToBuffer` copies bytes between mock buffers so
staged readbacks observe them.

Occlusion query scopes are recorded: the mock render pass encoder implements
`beginOcclusionQuery`/`endOcclusionQuery` as instrumented no-ops
(`instrumentation.occlusionQueryOps` holds `["begin", index]` / `["end"]` in encode
order), while the mock render bundle encoder deliberately lacks both methods,
matching WebGPU. Read as occlusion results (zero vs non-zero), the deterministic
`resolveQuerySet` values decode query index `0` to hidden (`0`) and every other
index to visible (non-zero), covering both decode paths end-to-end.
