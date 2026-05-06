# compile

`compile(wgsl: string)` is the `@vgpu/wgsl` entry point. It accepts a plain WGSL
runtime string and returns a `ResolvedShader` that `@vgpu/core` can turn into a
`Shader` with `device.createShader(...)`.

Public behavior:

- The input WGSL text is passed through byte-for-byte as `resolved.wgsl`.
- Entry-point names are detected for convenience.
- `source`, `sourceMap`, `ast`, `cacheKey`, and `stats` are populated with
  passthrough metadata.
- Any runtime `import` keyword throws a structured error with code
  `VGPU-WGSL-RUNTIME-IMPORT`.

Invariants: `compile()` performs no import resolution, package lookup, shader
rewriting, or semantic validation beyond the explicit import rejection.

Example:

```ts
const resolved = compile("@compute @workgroup_size(1) fn main() {}");
const shader = device.createShader(resolved);
```
