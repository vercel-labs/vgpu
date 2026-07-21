---
"@vgpu/wgsl": patch
"@vgpu/core": patch
"vgpu": patch
---

Reflect each entry point's transitive static binding use and use it to build stage-exact pipeline layouts. This avoids consuming vertex storage limits for fragment-only resources, adds actionable vertex/fragment storage-limit errors, and types device `requiredLimits` passthrough. Raw claimed layouts that guessed the previous broad visibility should be rebuilt from `draw.layout(group)`.
