---
"vgpu": patch
---

## Summary

Avoid redundant persistent-buffer uploads for managed uniforms used by frame draws and compute dispatches. `set()` still validates and packs values immediately; frames upload their captured values in batches, and one-shot draws/dispatches upload pending persistent values only when needed. Uniforms recorded in render bundles remain live, as do shared uniform buffers whose implementation-level buffer handles have been exposed. Storage and explicit buffer writes keep their existing behavior.

## Migration

None: Public call signatures, per-operation frame snapshots, one-shot results, bundle replay, and storage semantics are unchanged. Validation still rejects invalid values at `set()`. Stable buffers exposed for direct WebGPU use are flushed before exposure and continue receiving immediate updates, so existing raw consumers do not need a new flush call.
