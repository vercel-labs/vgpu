# ResolvedShader and ShaderSource

`ResolvedShader` is the plain-WGSL shader description shared by `@vgpu/wgsl` and
`@vgpu/core`. It is intentionally data-only: `compile(wgsl)` returns it, and
`device.createShader(resolved)` turns it into a GPU shader module.

Public `ResolvedShader` shape includes:

- `kind: "wgsl"` and `wgsl`: the unchanged WGSL source.
- `source`, `ast`, `sourceMap`: passthrough metadata with empty import and
  diagnostics lists.
- `cacheKey`: deterministic source key for future shader caches.
- `entryPoints`: names detected from `@vertex`, `@fragment`, and `@compute`
  declarations.
- `stats`: line count, UTF-8 byte count, and placeholder bind-group count.

`ShaderSource` is the smaller artifact emitted by the Vite and webpack `.wgsl`
loaders:

```ts
interface ShaderSource {
  readonly version: 1;
  readonly wgsl: string;
}
```

It intentionally contains no reflection, layouts, or `bindings` map. The
`bindings` field is reserved for a future format version and is not emitted in
v1. Ring-1 APIs (`gpu.pass`, `gpu.draw`, and `gpu.compute`) accept either a raw
WGSL string or this object and normalize at the API boundary.

Invariants: `compile()` does not resolve imports, mangle names, or build full
reflection. Runtime strings containing `import` are rejected before a
`ResolvedShader` is created. Consumers should treat fields as read-only and
pass objects across package boundaries rather than depending on placeholder AST
internals.

Imported modules are pure: structs/functions live in modules, while every
`@group/@binding` resource is declared by the entry module. That keeps `set()`
name reflection source-facing without binding renumbering or a binding map.

```wgsl
// noise.wgsl
export struct NoiseConfig { seed: u32 }
export fn noise(cfg: NoiseConfig) -> f32 { return f32(cfg.seed); }

// entry.wgsl
import { NoiseConfig, noise } from "./noise.wgsl";
@group(0) @binding(0) var<uniform> cfg: NoiseConfig;
@fragment fn main() -> @location(0) vec4f { return vec4f(noise(cfg)); }
```

Examples:

```ts
const resolved = compile(wgslSource);
const shader = device.createShader(resolved);

import shaderSource from "./shader.wgsl";
gpu.pass(shaderSource); // ShaderSource is accepted directly by ring-1 APIs.
```
