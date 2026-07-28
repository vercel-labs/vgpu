---
"vgpu": minor
"@vgpu/core": minor
---

Add per-pass `viewport` and `scissor` options to `FramePassOptions`. Both are emitted once right after the pass opens and apply to every draw in the pass, including replayed bundles. `viewport` is `{ x?, y?, width, height, minDepth?, maxDepth? }` (defaults `x`/`y` `0`, `minDepth` `0`, `maxDepth` `1`) following WebGPU `setViewport` rules — float pixels bounded by device limits, `minDepth <= maxDepth` — and throws `VGPU-PASS-VIEWPORT-INVALID` at pass open otherwise. `scissor` is `[x, y, width, height]` non-negative integers validated at pass open against the target's current pixel size (targets are resizable), throwing `VGPU-PASS-SCISSOR-INVALID` with the current size in the message when out of bounds. The scissor clips draws only; a clearing pass still clears the full attachment.
