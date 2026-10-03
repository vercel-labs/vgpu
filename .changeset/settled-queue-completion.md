---
"vgpu": patch
---

## Summary

`gpu.settled()` now snapshots queue work already submitted when it is called while preserving its resolve-only result and existing tracked error deliveries. Fulfillment can take longer and remains a completion signal, not a successful-execution guarantee. If a queue's `onSubmittedWorkDone()` throws synchronously, `compute.dispatch()` has already submitted its work and now reports one `VGPU-COMPUTE-VALIDATION` with `where: "<label>.completion"` through `gpu.onError` instead of throwing after submission.

## Migration

None: Call signatures are unchanged, and conforming WebGPU queues retain their existing error channels. `settled()` now waits for the already-submitted queue work captured when called, while already-lost/disposed wrappers retain their existing tracked waits without creating a new fence. The only error-channel change affects a queue whose completion method throws synchronously: `compute.dispatch()` reports the already-submitted work once through `gpu.onError` as `VGPU-COMPUTE-VALIDATION` with `where: "<label>.completion"`, so normal consumers do not need to adapt.
