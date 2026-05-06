# compile

`compile(wgsl: string)` accepts plain WGSL runtime strings and returns a
`ResolvedShader` that `@vgpu/core` can turn into a GPU shader module.

S2 intentionally rejects any `import` keyword with `VGPU-WGSL-RUNTIME-IMPORT`.
Import resolution belongs to the future `@vgpu/wgsl/runtime` seam.
