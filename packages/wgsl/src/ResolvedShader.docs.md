# ResolvedShader

Opaque plain-WGSL shader description shared by `@vgpu/wgsl` and `@vgpu/core`.
Callers should pass it to `device.createShader(...)` instead of depending on its
internal fields. S2 carries source, cache, stats, and empty reflection hooks.
