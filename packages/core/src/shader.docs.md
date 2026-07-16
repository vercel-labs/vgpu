# Shader

`Shader` is the core opaque shader object created by `device.createShader(...)`.
It accepts either a raw WGSL string or a `ResolvedShader` from `@vgpu/wgsl`, then
owns the resulting `GPUShaderModule` while keeping WGSL metadata available
through a stable object.

Public shape:

- `.kind` is `"wgsl"` for WGSL shaders.
- `.gpu` exposes the raw `GPUShaderModule` escape hatch.
- `.source`, `.entryPoints`, and `.stats` forward read-only metadata from the
  resolved WGSL object.
- `ShaderInput` is either `string` or `ResolvedShader`.

Invariants: creating a shader from a string still goes through the WGSL
compiler path internally, but no runtime resolver is loaded. `dispose()` is a
no-op because WebGPU shader modules have no destroy method.

Example:

```ts
import { createMockAdapter } from "@vgpu/adapter-mock";

const device = await createMockAdapter().requestDevice();
const shader = device.createShader("@compute @workgroup_size(1) fn main() {}");
console.log(shader.kind); // "wgsl"
device.destroy();
```
