---
"@vgpu/wgsl": patch
---

## Summary

Make WGSL loader metadata packing eligibility more conservative using distinct substantial uniform layouts, while preserving exact prepared ShaderSource values and existing packing for eligible inputs.

## Migration

None: Author imports and loader configuration, public prepareShader output, and the ShaderSource v2 own-data contract are unchanged. Rebuild through the existing loader to use the revised selection; no source changes are required.
