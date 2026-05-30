# Frame

`Frame` owns one `GPUCommandEncoder` for an explicit sequence of commands. Use
`beginFrame(device)` when one render frame needs multiple render passes, query
commands, or copies in a user-authored order, then call `submit()` once.

VGPU does not infer pass order, bind group layouts, or pipeline layouts. The
helpers keep the native WebGPU lifecycle visible while removing repeated
boilerplate around pass begin/end and final submission.

## Native WebGPU baseline

Without `Frame`, a multipass render frame is one command encoder, multiple
passes ended in order, then one finish/submit:

```ts
const encoder = device.gpu.createCommandEncoder({ label: "hero.frame" });

const lightPass = encoder.beginRenderPass(lightPassDescriptor);
lightPass.executeBundles([lightBundle]);
lightPass.end();

encoder.writeTimestamp(querySet, 0);
encoder.copyBufferToBuffer(srcBuffer, 0, dstBuffer, 0, byteLength);

const compositePass = encoder.beginRenderPass(compositePassDescriptor);
compositePass.setPipeline(compositePipeline);
compositePass.setBindGroup(0, compositeBindGroup);
compositePass.draw(3);
compositePass.end();

device.queue.gpu.submit([encoder.finish()]);
```

## With VGPU Frame

`Frame` keeps that same lifecycle: one encoder, explicit pass order, finish once,
submit once.

```ts
const frame = beginFrame(device, { label: "hero.frame" });

frame.renderPass(lightPassDescriptor, (pass) => {
  pass.executeBundles([lightBundle]);
});

frame.gpu.writeTimestamp(querySet, 0);
frame.copyBufferToBuffer(srcBuffer, dstBuffer, byteLength);

frame.renderPass(compositePassDescriptor, (pass) => {
  pass.setPipeline(compositePipeline);
  pass.setBindGroup(0, compositeBindGroup);
  pass.draw(3);
});

frame.submit();
```

`frame.renderPass(options, callback)` begins a `RenderPass` wrapper on the
frame-owned encoder, runs the callback, and ends that pass in a `finally` block.
Unlike constructing a standalone `RenderPass`, a pass created by `Frame` does
**not** finish or submit the command encoder when it ends. `frame.submit()` is
the only submission point.

The raw command encoder is available as `frame.gpu` for WebGPU operations that
are intentionally not wrapped, such as `writeTimestamp()` or `resolveQuerySet()`.
Direct raw encoder calls follow native WebGPU behavior; VGPU only guards its own
helper methods after `submit()`.

`copyBufferToBuffer(source, destination, size, sourceOffset?, destinationOffset?)`
is a small typed helper that accepts either core `Buffer` instances or raw
`GPUBuffer`s. For all other encoder commands, use `frame.gpu` directly.

A `Frame` is single-use. Calling VGPU helper methods after `submit()` throws
`VGPUError` with code `VGPU-FRAME-SUBMITTED`.
