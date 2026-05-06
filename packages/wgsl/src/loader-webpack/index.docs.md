# wgslWebpackLoader

`wgslWebpackLoader` lets webpack-compatible bundlers import `.wgsl` files as JavaScript string modules. Plain WGSL files are emitted unchanged as `export default "..."`; files with top-level vgpu-wgsl imports are resolved to one plain WGSL string before webpack receives the module.

The loader input is the WGSL source and the webpack loader context, including `resourcePath`. It outputs JavaScript module source whose default export is the resolved WGSL string. Imported files are read relative to `resourcePath`, so normal webpack file watching should include the entry file while resolver errors identify missing or invalid imported modules.

The loader must run in asynchronous loader mode when imports are present. If async mode is unavailable, or if resolution fails, it reports a structured `VGPU-WGSL-*` error through webpack's callback. Loader options are intentionally minimal in this release; package resolution is controlled by filesystem/package metadata rather than loader-specific syntax.
