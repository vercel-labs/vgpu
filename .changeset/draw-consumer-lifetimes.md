---
"vgpu": minor
---

## Summary

Add optional `dispose()` methods for Draw, Effect, and Compute with exact disposed-consumer diagnostics. Disposal releases consumer state without destroying borrowed resources or invalidating native work already encoded or saved, while managed bundles recorded from the consumer become stale. Letting a consumer be collected without disposing it leaves its retained bundles valid through independent resource snapshots.

## Migration

### Affected usage

Code that handles `VGPU-BUFFER-DISPOSED` specifically when `Draw.set()`, `Effect.set()`, or `Compute.set()` receives an already-destroyed tracked Buffer, Uniform-like value, or provider is affected. Those binding-boundary failures now use `VGPU-R1-BINDING-DESTROYED`; direct core Buffer operations continue to report `VGPU-BUFFER-DISPOSED` unchanged.

The new consumer `dispose()` methods are opt-in. Existing call sites do not need to add them, and valid calls on live consumers retain their behavior.

### Steps

Update only binding `set()` error handling that branches on `VGPU-BUFFER-DISPOSED` to recognize `VGPU-R1-BINDING-DESTROYED`. Keep `VGPU-BUFFER-DISPOSED` handling for direct Buffer operations such as `write()` and `read()`.

Applications that want deterministic consumer teardown may call `dispose()` after their last Draw, Effect, or Compute use. Re-record managed bundles after disposing a consumer they recorded; already encoded commands and previously saved native bundle handles remain native work and are not revoked.

### Verification

Exercise the existing binding failure path with an already-destroyed tracked Buffer, Uniform-like value, or provider and confirm `set()` reports `VGPU-R1-BINDING-DESTROYED` with the binding details. Separately exercise a direct operation on a destroyed core Buffer and confirm it still reports `VGPU-BUFFER-DISPOSED`. If adopting consumer disposal, verify later consumer calls reject with `VGPU-DRAW-DISPOSED` or `VGPU-COMPUTE-DISPOSED` and managed bundle replay requires re-recording.
