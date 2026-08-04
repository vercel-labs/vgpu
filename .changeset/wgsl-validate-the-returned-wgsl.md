---
"@vgpu/wgsl": patch
---

`resolveShader()` now validates the WGSL it actually returns, whatever the minify mode. Previously the post-minify validation pass ran only for `minify: true` / `minify: { identifiers: "safe" }`; whitespace-only minification (`minify: { whitespace: true }`, which is what the object form defaults to) was never re-validated, so a whitespace-stage minifier bug returned `validation: { attempted: true, ok: true }` together with WGSL that fails `createShaderModule` in the consumer's app. The `VGPU-WGSL-MINIFY-DANGLING-IDENT` self-check could not cover this: it is scoped to identifier renaming.

The guarantee now: with `validate` other than `"off"`, if `resolveShader()` resolves with `validation.ok === true`, the exact `wgsl` string it hands back was accepted by the device. Corrupt minifier output throws `VGPU-WGSL-NAGA-UNKNOWN` at resolve time instead of surfacing as a shader-module failure later.

Observable change: a whitespace-only minified shader whose minified text the device rejects now **throws** where it previously resolved. That is the fix — the previous success was a false one — but it can turn a silently-broken build into a failing one. `validate: "off"` (or `VGPU_VALIDATE=off`) is unaffected and still never touches a device; both bundler loaders already pass `validate: false`, so webpack/vite/turbopack builds are unchanged.

Validation still runs first on the unminified emission, because that text is what yields accurate line/column diagnostics against your source modules; the second pass on the final text reuses the same leased device and is skipped entirely when minification changed nothing, so a non-minifying resolve still validates exactly once.
