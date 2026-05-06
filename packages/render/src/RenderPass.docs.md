# RenderPass

`RenderPass` is a command-encoding wrapper for drawing into color
attachments. Construct it with a core `Device` and `RenderPassOptions`, encode
render commands, then call `end()` to finish the pass and submit the command
buffer through `Device.queue`.

`RenderPassOptions` contains `colorAttachments` and an optional `label`.
`ColorAttachment.view` accepts either a core `Texture` or a raw
`GPUTextureView`; `loadOp`, `storeOp`, and `clearValue` are forwarded to WebGPU.

Commands mirror the WebGPU render pass encoder:

- `setPipeline(pipeline)` binds a raw `GPURenderPipeline`.
- `setBindGroup(index, group, dynamicOffsets?)` binds a raw `GPUBindGroup`.
- `setVertexBuffer(slot, buffer, offset?, size?)` binds a core `Buffer` or raw
  `GPUBuffer` for vertex input.
- `draw({ vertexCount, instanceCount?, firstVertex?, firstInstance? })` issues a
  non-indexed draw. The numeric WebGPU-style `draw(vertexCount, ...)` call is
  also accepted.

Use `gpu` when you need direct `GPURenderPassEncoder` access for commands that
are not wrapped yet.

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
pass.setBindGroup(0, uniforms);
pass.setVertexBuffer(0, vertices);
pass.draw({ vertexCount: 3 });
pass.end();
```
