# RenderPass

Minimal command-encoding render pass. Construct with a core `Device` and color
attachments, call `setPipeline(...)`, `draw(...)`, then `end()` to submit work.
It exposes `.gpu` for direct `GPURenderPassEncoder` access.
