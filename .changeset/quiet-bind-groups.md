---
"@vgpu/render": patch
---

Fix `RenderPass.setBindGroup` so omitted dynamic offsets are not forwarded to WebGPU as an explicit `undefined` argument.
