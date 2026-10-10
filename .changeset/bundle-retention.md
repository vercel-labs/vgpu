---
"vgpu": minor
---

## Summary

Stop draws and captured-resource subscriptions from retaining abandoned render bundles, detach stale or failed recordings, and add synchronous idempotent `Bundle.dispose()` for deterministic facade release. Disposal does not destroy borrowed resources or revoke a native render bundle handle saved before disposal.

## Migration

None: Existing recording/replay call shapes and live uniform/resource semantics remain supported; disposal is opt-in and dropping a valid bundle no longer keeps it rooted by draws/resources.
