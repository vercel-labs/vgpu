---
"@vgpu/wgsl": patch
---

Document that `@vgpu/wgsl/runtime` is ESM-only in the `resolveShader` reference. The `./runtime` subpath declares only an `import` condition, so calling it from a CommonJS entry point fails with Node's `ERR_PACKAGE_PATH_NOT_EXPORTED` rather than a `VGPU-*` code — name the script `.mjs`/`.mts` or set `"type": "module"`.
