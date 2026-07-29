---
"vgpu": minor
---

Add configurable depth state to `draw(gpu)` and a per-pass depth clear value. `DrawOptions.depth` takes `false` to disable depth testing or `{ write?, compare?, bias?, biasSlopeScale?, biasClamp? }`; invalid values throw `VGPU-DEPTH-INVALID` at construction. `FramePassOptions.clearDepth` sets the depth clear value in `[0, 1]` (default `1`); use `0` with `depth: { compare: "greater" }` for reversed-Z. Render passes on combined depth-stencil targets (`"depth24plus-stencil8"`, `"depth32float-stencil8"`) now emit the required `stencilLoadOp`/`stencilStoreOp` instead of producing invalid passes, and the stencil-only `"stencil8"` depth format is rejected at target creation with `VGPU-TARGET-DEPTH-STENCIL-ONLY`.

BREAKING CHANGE (pre-1.0): the default depth compare for draws on depth targets changes from `"less"` to `"less-equal"`.

- Before: fragments at exactly the depth already in the buffer failed the depth test, so re-drawing coplanar geometry left the first result in place.
- After: fragments at equal depth pass and overwrite, so decals/coplanar re-draws land without a bias.
- Who is affected: draws on targets with a depth attachment that rely on coplanar re-draws being rejected — i.e. that expect strict `"less"` semantics. Draws without a depth target, or with an explicit `compare`, are unchanged.
- Fix to restore the old behavior: `draw(gpu, { ..., depth: { compare: "less" } })`.
