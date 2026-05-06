# RenderPass

`RenderPass` is the S2 command-encoding wrapper for drawing into color
attachments. Construct it with a core `Device` and `RenderPassOptions`, call
`setPipeline(...)`, issue `draw(...)`, then call `end()` to finish the pass and
submit the command buffer through `Device.queue`.

`RenderPassOptions` contains `colorAttachments` and an optional `label`.
`ColorAttachment.view` accepts either a core `Texture` or a raw
`GPUTextureView`; `loadOp`, `storeOp`, and `clearValue` are forwarded to WebGPU.

Invariants: a pass is single-use. After `end()`, the underlying
`GPURenderPassEncoder` is invalid, so `RenderPass.gpu` throws `VGPUError` with
code `VGPU-RENDER-PASS-ENDED`. Calling `end()` more than once is safe and is a
no-op after the first submission.

Example:

```ts
const pass = new RenderPass(device, {
  colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
});
pass.setPipeline(pipeline);
pass.draw(3);
pass.end();
```
