---
"@vgpu/wgsl": minor
"@vgpu/wgsl-std": patch
---

Prune unused resolved WGSL declarations conservatively so broad utility imports do not inflate emitted shader size. DCE is always-on for shaders with entry points in this release with no opt-out; cache keys remain deterministic and are not made insensitive to unused imported source changes.
