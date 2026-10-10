---
"vgpu": patch
---

## Summary

Document the boundary between scene composition and general CPU math, with checked examples for
using pmndrs/math matrices in instance collections, external hierarchies, and camera uniforms.
The CLI documentation explains representation, projection, ownership, and explicit update rules.

## Migration

None: Existing exports, signatures, validation, and runtime dependencies are unchanged. The
optional math integration uses existing array inputs; math is only a repository development
dependency for checking the examples.
