---
"@vgpu/wgsl": patch
---

`@vgpu/wgsl/runtime` is now reachable from CommonJS. The subpath declared only `types` and `import` conditions, so any consumer that resolved it through `require` — a plain `require("@vgpu/wgsl/runtime")`, a `.cts` file, or a `tsx`/ts-node script in a project without `"type": "module"` — failed with `ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './runtime' is not defined by "exports"`, even though the sibling subpaths (`./loader-webpack`, `./loader-vite`, `./reflect-source`) all already exposed `require`/`default`. `./runtime` now mirrors them and points every condition at the same ESM file, which Node 22 loads through `require(esm)`: the runtime entry has no top-level await and its only ESM-specific constructs are `createRequire(import.meta.url)` calls, both of which are fine under synchronous `require(esm)`.
