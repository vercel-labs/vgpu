---
"@vgpu/wgsl": patch
---

`compile()` now reports the entry points it was previously missing or mangling in runtime WGSL strings. The extractor required the stage attribute to sit directly before `fn`, but WGSL requires `@workgroup_size` on every compute entry point, so that attribute always sits in between and no compute entry point was ever reported: `compile("@compute @workgroup_size(1) fn main() {}").entryPoints` returned `[]`.

Entry point names are also no longer truncated at the first non-ASCII character (`maín` was reported as `"ma"`, `Ωmain` was dropped), and `@vertex` / `@fragment` / `@compute` functions written inside line or block comments are no longer reported as real entry points.

`compile()` remains a byte-for-byte passthrough; the scanner is still not pulled into the browser-facing `@vgpu/wgsl` entry.
