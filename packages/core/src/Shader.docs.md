# Shader

`Shader` is the core opaque shader object created by `device.createShader(...)`.
It accepts either a raw WGSL string or a `ResolvedShader` from `@vgpu/wgsl`, then
owns the resulting `GPUShaderModule` while keeping WGSL metadata behind a small
stable seam.

Public shape:

- `.kind` is `"wgsl"` for S2 plain-WGSL shaders.
- `.gpu` exposes the raw `GPUShaderModule` escape hatch.
- `.source`, `.entryPoints`, and `.stats` forward read-only metadata from the
  resolved WGSL object.
- `ShaderInput` is either `string` or `ResolvedShader`.

Invariants: creating a shader from a string still goes through the WGSL compiler
seam internally, but no runtime resolver is loaded. `dispose()` is a no-op in S2
because WebGPU shader modules have no destroy method.

Example:

```ts
const shader = device.createShader("@compute @workgroup_size(1) fn main() {}");
console.log(shader.kind); // "wgsl"
```
