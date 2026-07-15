# `StructuredUniform`

Structured uniforms are the low-level version of ring-1 `set()` packing. New shaders should declare WGSL structs and call `draw.set({ params: { ... } })`; use `StructuredUniform` only when you explicitly need a reusable ring-0 resource.
