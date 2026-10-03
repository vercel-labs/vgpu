---
"vgpu": patch
---

## Summary

Route 3D scene tasks from the public skill to a dedicated `scene.md` reference. Keep scene
composition and optional numerical-library guidance in that reference so it can evolve
independently of the main skill. Preserve the authored reference during skill regeneration.

## Migration

None: Runtime APIs and dependencies are unchanged. The public skill includes the linked scene
reference; the main skill links to it for 3D scene work.
