---
"@vgpu/wgsl": patch
"@vgpu/cli": patch
---

Report WGSL reserved words and keywords used as declared identifiers. `resolveShader` (the engine behind `vgpu check` and the loaders) now emits a `VGPU-WGSL-RESERVED-IDENT` error diagnostic — with the offending name, file, line and column — for struct names, struct members, type aliases, module-scope variables, overrides, functions, parameters and local variables whose name is reserved by the WGSL spec (e.g. `struct Paint { from: vec2f }`). Previously these passed `check` with zero diagnostics and only failed later inside Dawn at pipeline creation.

`vgpu check` also serializes diagnostics correctly (their `message` was being dropped by `JSON.stringify` because `Error.message` is not enumerable) and exits with code `1` when any error-severity diagnostic is reported.
