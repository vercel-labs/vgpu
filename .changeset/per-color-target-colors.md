---
"vgpu": minor
---

Add `DrawOptions.colors` to `draw(gpu)`: per-color-target blend/writeMask overrides for MRT draws, aligned by index with the target's color attachments. `null`/missing entries — and omitted fields of an entry — inherit the top-level `blend`/`writeMask`, so `colors: [null, { writeMask: [] }]` silences the second G-buffer attachment while the first keeps the uniform state. Draws that differ only in `colors` compile distinct pipelines; draws without `colors` keep today's pipeline keys and behavior. A non-array `colors` or an entry that is neither `null` nor `{ blend?, writeMask? }` throws `VGPU-COLORS-INVALID` at construction (entry values reuse the `VGPU-BLEND-INVALID`/`VGPU-WRITEMASK-INVALID` rules), and compiling against a target signature whose color attachment count differs from `colors.length` throws `VGPU-COLORS-INVALID` with both counts in the message.
