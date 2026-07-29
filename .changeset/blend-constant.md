---
"vgpu": minor
"@vgpu/core": minor
---

Add `DrawOptions.blendConstant` to `draw(gpu)`, closing the gap where `"constant"`/`"one-minus-constant"` blend factors were stuck at the initial `(0, 0, 0, 0)`. The constant is `[r, g, b, a]` finite numbers (values outside `[0, 1]` are allowed), emitted as `setBlendConstant` encoder state after `setPipeline` and before the draw — it is not part of the pipeline, so draws differing only in `blendConstant` share pipelines. A malformed value, or one paired with a `blend` that uses no constant factor, throws `VGPU-BLEND-CONSTANT-INVALID` at construction; constant factors without `blendConstant` stay legal and use the WebGPU pass default. Render bundles cannot set the pass blend constant, so `bundle` rejects recording such draws with `VGPU-BUNDLE-BLEND-CONSTANT`.
