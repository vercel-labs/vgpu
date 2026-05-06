# wgslVitePlugin

`wgslVitePlugin` lets Vite import `.wgsl` files as JavaScript string modules. Plain WGSL files are returned as raw source strings, while files with top-level vgpu-wgsl imports are resolved into one plain WGSL string during Vite transform.

`transformWgsl(source, id)` is the testable transform primitive. It accepts the WGSL source and file id, and returns `ViteLoadResult` with JavaScript code plus `map: null`; the code default-exports the original or resolved WGSL string. The default plugin wraps that primitive with `{ name, transform }` and only handles paths ending in `.wgsl`.

Resolution failures, package export problems, invalid imports, and validation-disabled resolver errors surface as structured `VGPU-WGSL-*` exceptions from the transform. Vite catches those exceptions and presents them as transform failures. Loader options are deliberately small in this release; callers configure module layout through normal file paths, package `exports`, and resolver-compatible source files.
