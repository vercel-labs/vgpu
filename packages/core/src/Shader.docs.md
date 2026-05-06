# Shader

Opaque core shader object created by `device.createShader(...)` from a plain WGSL
string or a `ResolvedShader` from `@vgpu/wgsl`. It exposes `.gpu` for the raw
`GPUShaderModule` escape hatch and keeps WGSL metadata local to the shader seam.
