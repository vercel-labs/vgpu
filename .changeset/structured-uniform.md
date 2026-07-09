---
"@vgpu/render": minor
"@vgpu/core": patch
---

Add `StructuredUniform`, a schema-typed uniform buffer with generated WGSL layout, partial field writes, lazy bind group objects, and custom-bind-group composition support.

Fix `bind.resource()` to unwrap VGPU buffer-like objects before generic GPU buffer binding objects so wrappers exposing `.gpu` bind as buffers.
