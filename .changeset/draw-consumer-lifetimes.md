---
"vgpu": patch
---

## Summary

Remove resource and cache roots that retain abandoned render and compute consumers, keep retained bundles independently valid, and report already-destroyed tracked binding candidates through the binding-specific diagnostic.

## Migration

None: Existing binding, recording and replay calls remain supported; abandoned consumers can be collected without explicit cleanup, and retained bundles preserve captured-resource validation and live uniform behavior.
