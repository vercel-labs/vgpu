---
"@vgpu/wgsl": patch
"@vgpu/cli": patch
---

Report WGSL reserved words and keywords used as declared identifiers on every build-time path. Struct names, struct members, type aliases, module-scope variables, overrides, functions, parameters and local variables whose name is reserved by the WGSL spec (e.g. `struct Paint { from: vec2f }`) now produce a `VGPU-WGSL-RESERVED-IDENT` error diagnostic with the offending name, file, line and column. Previously these passed with zero diagnostics and only failed later inside Dawn at pipeline creation.

- `resolveShader()` collects the diagnostics per loaded module, so imported modules report their own location.
- The Vite plugin and the webpack loader fail the build on error-severity diagnostics — in both the leaf-shader path and the import-graph path — with a message listing `file:line:column`. Warnings such as `VGPU-WGSL-PKG-CONDITIONAL` stay non-fatal.
- `vgpu check` serializes diagnostics correctly (their `message` was being dropped by `JSON.stringify` because `Error.message` is not enumerable) and exits with code `1` when any error-severity diagnostic is reported.

`compile()` keeps its byte-for-byte passthrough behavior: running the pass there would pull the scanner into the browser-facing `@vgpu/wgsl` entry (688 B → 4062 B gzip against a 1024 B budget), and runtime WGSL strings are reported by the driver at `createShaderModule`.

The reserved-word and keyword lists are now verbatim from the WGSL spec: this adds `non_coherent`, `noncoherent` and `type`, and moves `binding_array` (dropped from the current spec list) into a separate legacy set that still blocks identifier minification from generating it.
