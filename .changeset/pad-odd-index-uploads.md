---
"vgpu": patch
---

## Summary

`geometry(gpu, { indices })` now accepts an odd-length (or otherwise non-4-byte-multiple) `Uint16Array`. Previously the owned index buffer's initial upload failed natively with "size is not a multiple of 4 bytes". Only that initial upload is zero-padded to a 4-byte multiple; `indexFormat`, `indexCount`, the logical byte length and `writeIndices` bounds are unchanged, so the padding is never drawable or writable. Subarray views upload only their own bytes. The geometry reference now notes that `writeIndices` cannot rewrite the last index of an odd-length array, and that passing an even-length array with an explicit `indexCount` keeps every index rewritable.

## Migration

None: Existing valid calls keep their signatures, formats, counts and bounds; only inputs that previously failed during creation are newly accepted, and no adaptation is needed.
