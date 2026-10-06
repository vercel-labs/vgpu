---
"vgpu": minor
---

## Summary

Fix abandoned Draw, Effect, and Compute retention and add optional `dispose()` methods with exact disposed-consumer diagnostics. Disposal releases consumer state without destroying borrowed resources or invalidating native work already encoded or saved, while managed bundles recorded from the consumer become stale. Letting a consumer be collected without disposing it leaves its retained bundles valid through independent resource snapshots. Raw `GPUBuffer` and `GPUBufferBinding` buffer bindings now reject checkably invalid usage and byte ranges at `set()`, keeping the previous binding, and bind a snapshot of the canonical `{ buffer, offset, size }` range; tracked Buffer, Uniform-like, and provider bindings add the same checkable range validation while retaining synchronous usage validation. Compute rejects writable aliases by underlying allocation, including a tracked Buffer bound beside its raw `GPUBuffer`, and compatible generated texture views are reused without changing `Texture.createView()` freshness. Bundled Draw, Effect, and Compute documentation covers the new lifetime and binding behavior.

## Migration

### Affected usage

Code that handles `VGPU-BUFFER-DISPOSED` specifically when `Draw.set()`, `Effect.set()`, or `Compute.set()` receives an already-destroyed tracked Buffer, Uniform-like value, or provider is affected. Those binding-boundary failures now use `VGPU-R1-BINDING-DESTROYED`; direct core Buffer operations continue to report `VGPU-BUFFER-DISPOSED` unchanged.

Code that passes a raw `GPUBuffer` or `{ buffer: GPUBuffer, offset?, size? }` with checkably invalid usage or byte range is also affected. Those failures previously surfaced later from native bind-group validation; `set()` now throws `VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE` with a binding-specific fix and leaves the binding's previous value in place. An `offset` or `size` of `null` or a numeric string is rejected the same way instead of being passed to WebGPU. Valid raw ranges and ordinary WGSL struct values whose numeric members happen to be named `buffer`, `offset`, or `size` behave as before.

Compute code that binds one allocation as a tracked `Buffer` and as its raw `GPUBuffer` (or a range of it) in two storage bindings, at least one writable, is affected: dispatch now reports `VGPU-R1-STORAGE-ALIASING` before encoding, as it already did when both bindings used the same spelling.

Code that passes a live tracked Buffer, Uniform-like value, or provider with a checkably invalid range is affected too. Native-usage failures continue to report `VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE` synchronously at `set()`; reflected-minimum, granted-maximum, and storage-size failures that previously reached native bind-group validation now report it there too.

Code that records one Draw or Effect into multiple managed bundles and changes a bound resource or claimed group while recording a later bundle is affected. The earlier completed bundle now becomes stale; recording another bundle no longer exempts that cross-recording rebind. Rebinding between draw calls inside one bundle remains supported and that bundle captures each recorded identity.

The new consumer `dispose()` methods remain opt-in; existing call sites do not need to add them. Callers relying on the cross-recording rebind behavior above must instead adapt their bundle ownership as described below.

### Steps

Update only binding `set()` error handling that branches on `VGPU-BUFFER-DISPOSED` to recognize `VGPU-R1-BINDING-DESTROYED`. Keep `VGPU-BUFFER-DISPOSED` handling for direct Buffer operations such as `write()` and `read()`.

For raw and tracked bindings, create the buffer with the reflected slot's `uniform` or `storage` usage. Use a safe-integer offset aligned to the device's granted `minUniformBufferOffsetAlignment` or `minStorageBufferOffsetAlignment`, and a positive in-bounds size that satisfies the reflected minimum and granted maximum. Storage sizes must be multiples of 4. Omitted raw `offset` defaults to `0`; omitted raw `size` defaults to `buffer.size - offset`; only `undefined` selects those defaults. `set()` snapshots a raw descriptor, so call it again after changing a range.

For compute, bind writable storage and any other storage view of it from separate allocations, for example with `pingPongStorage(gpu)`, whichever spelling each binding uses.

For separately replayable bundles with different resource identities, use a stable Draw or Effect for each recording. Alternatively, after rebinding a shared consumer, record its replacement bundle, swap it in, and dispose or drop the stale bundle. Ping-pong bundle pairs should use two stable consumers, one for each direction.

Applications that want deterministic consumer teardown may call `dispose()` after their last Draw, Effect, or Compute use. Re-record managed bundles after disposing a consumer they recorded; already encoded commands and previously saved native bundle handles remain native work and are not revoked.

### Verification

Exercise the existing binding failure path with an already-destroyed tracked Buffer, Uniform-like value, or provider and confirm `set()` reports `VGPU-R1-BINDING-DESTROYED` with the binding details. Separately exercise a direct operation on a destroyed core Buffer and confirm it still reports `VGPU-BUFFER-DISPOSED`. If adopting consumer disposal, verify later consumer calls reject with `VGPU-DRAW-DISPOSED` or `VGPU-COMPUTE-DISPOSED` and managed bundle replay requires re-recording.

Bind two aligned ranges of one raw allocation and verify each reads its own bytes. Pass an invalid raw range and confirm `set()` reports `VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE`, includes the binding coordinates and alignment/size fix, and leaves the prior accepted binding active. Pass a tracked buffer created without the reflected usage and confirm the same code is thrown at `set()` with the tracked vgpu usage-array fix. For compute, use separate allocations whenever either storage binding is writable; even disjoint ranges of one allocation, or a tracked `Buffer` beside its raw `GPUBuffer`, intentionally report `VGPU-R1-STORAGE-ALIASING` before dispatch.

Record bundle A from a consumer, then rebind that consumer while recording bundle B and confirm managed replay of A reports `VGPU-R3-BUNDLE-STALE`. Confirm either two stable consumers or a re-recorded replacement bundle produces the expected output.
