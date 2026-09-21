---
"@vgpu/wgsl": patch
---

## Summary

Fix `compile()` entry-point metadata for runtime WGSL strings. Compute functions with intervening attributes are now included, Unicode XID names are preserved in full, and functions inside comments or unrelated declarations are ignored. Entry-point discovery recognizes WGSL whitespace and line breaks and terminates safely on incomplete declarations ending in line comments.

## Migration

None: the `compile()` API and byte-for-byte shader passthrough are unchanged; consumers receive corrected `entryPoints` metadata automatically.
