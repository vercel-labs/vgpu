---
"vgpu": patch
---

## Summary

Managed uniform `set()` calls whose packed bytes are unchanged no longer start a new frame snapshot revision, so later draws and dispatches in the same frame reuse the snapshot already captured. Storage bindings and live uniforms (recorded into a render bundle, or a `uniforms()` object whose buffer was accessed) are still written on every `set()`. Frame uniform pages are now pooled and reused across frames with bounded idle retention, and their bind groups are reused by frames that repeat the same draws in the same order, without a whole-cache invalidation scan on frame completion. Raw `GPUBuffer` and `GPUBufferBinding` values set on uniform or storage buffer bindings are now bound as live resources keyed by buffer, offset and size instead of being treated as struct values.

## Migration

None: Public call signatures, per-operation frame snapshots, live bundle, storage and raw-buffer semantics, and error codes are unchanged. Raw buffers or buffer ranges passed to `set()` for buffer bindings previously failed as struct values and now bind the supplied range; redundant `set()` calls remain valid.
