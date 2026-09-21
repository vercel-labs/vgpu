---
title: "Encode native indirect dispatch"
description: "Use generated functions and prepared binding data in an application-owned Metal indirect command buffer."
---

An application can keep Metal command encoding outside vgpu. This example takes the `Count`
shader and buffer ranges from [Dispatch WGSL compute](/native/macos/metal/compute/dispatch), then
encodes one reusable indirect compute command. There is no generated command-buffer wrapper.

> Warning: Native tests on Apple silicon execute this CPU-encoded command, replay it, and reset it
> for changed buffer ranges. This is a bounded composition example, not general indirect-command
> support. The command shim exists; the generated package, operational companion, and complete
> installed workflow are provided by the optional beta companion.

## Create a compatible pipeline

Use the same loaded `count` functions and `bindings` as the dispatch guide. Replace its ordinary
pipeline creation with a descriptor that enables indirect commands:

```swift
let pipelineDescriptor = MTLComputePipelineDescriptor()
pipelineDescriptor.computeFunction = count.compute
pipelineDescriptor.supportIndirectCommandBuffers = true
let pipeline = try device.makeComputePipelineState(
  descriptor: pipelineDescriptor,
  options: [],
  reflection: nil
)
let prepared = try count.prepare(bindings)
```

Preparation validates the ranges and computes the compiler-required bytes. It does not establish
indirect pipeline support; the native pipeline creation above can fail. See Apple's
[indirect pipeline setting](https://developer.apple.com/documentation/metal/mtlcomputepipelinedescriptor/supportindirectcommandbuffers).

## Encode one command

This command stores its own pipeline and buffers rather than inheriting them from the encoder.
Reserve the generated buffer-slot range, including internal slots:

```swift
let slots = Count.Storage.values.slots
  + Count.Storage.output.slots
  + prepared.internalData.map(\.slot)
precondition(slots.allSatisfy { $0.stage == .compute })

let descriptor = MTLIndirectCommandBufferDescriptor()
descriptor.commandTypes = .concurrentDispatch
descriptor.inheritPipelineState = false
descriptor.inheritBuffers = false
descriptor.maxKernelBufferBindCount = (slots.map(\.index).max() ?? -1) + 1
let indirectCommands = device.makeIndirectCommandBuffer(
  descriptor: descriptor,
  maxCommandCount: 1,
  options: []
)!
let indirect = indirectCommands.indirectComputeCommandAt(0)
indirect.reset()
indirect.setComputePipelineState(pipeline)

for slot in Count.Storage.values.slots {
  indirect.setKernelBuffer(prepared.bindings.values.buffer, offset: prepared.bindings.values.offset, at: slot.index)
}
for slot in Count.Storage.output.slots {
  indirect.setKernelBuffer(prepared.bindings.output.buffer, offset: prepared.bindings.output.offset, at: slot.index)
}

var internalUploads: [any MTLBuffer] = []
for payload in prepared.internalData {
  let buffer = payload.bytes.withUnsafeBytes { bytes in
    device.makeBuffer(bytes: bytes.baseAddress!, length: bytes.count, options: .storageModeShared)!
  }
  indirect.setKernelBuffer(buffer, offset: 0, at: payload.slot.index)
  internalUploads.append(buffer)
}
indirect.concurrentDispatchThreadgroups(
  MTLSize(width: 1, height: 1, depth: 1),
  threadsPerThreadgroup: Count.workgroupSize
)
```

The short example assumes allocations succeed. Internal uploads use offset `0`, satisfying their
alignment. They contain the bytes from `prepare`; the application does not construct a Tint size
table. Indirect commands accept buffers, so the ordinary `count.bind` convenience is not used.
See Apple's [indirect compute command reference](https://developer.apple.com/documentation/metal/mtlindirectcomputecommand).

## Execute and retain the resources

Declare access to the indirectly referenced buffers on the executing encoder:

```swift
let commandBuffer = queue.makeCommandBuffer()!
let encoder = commandBuffer.makeComputeCommandEncoder()!
encoder.useResource(prepared.bindings.values.buffer, usage: .read)
encoder.useResource(prepared.bindings.output.buffer, usage: .write)
for buffer in internalUploads {
  encoder.useResource(buffer, usage: .read)
}
encoder.executeCommandsInBuffer(indirectCommands, range: 0..<1)
encoder.endEncoding()
withExtendedLifetime((pipeline, prepared, indirectCommands, internalUploads)) {
  commandBuffer.commit()
  commandBuffer.waitUntilCompleted()
}
precondition(commandBuffer.status == .completed, String(describing: commandBuffer.error))
```

Waiting here makes the small example's lifetime explicit; a frame loop would retain these objects
until its completion callback. Read the shared output buffer only after completion. The expected
results remain `[2, 202]` for a `28`-byte input view and `[4, 404]` for a `52`-byte view.

The encoded command can be executed again with the same binding snapshot and retained uploads.
To change a visible range, prepare new bindings and reset and encode the command again after its
previous execution completes. Do not rewrite an in-flight command, upload, or resource range.

This example covers one CPU-encoded command, shared storage, fixed workgroup dimensions, and
explicit pipeline and buffer state. It does not establish GPU-authored commands, multiple-command
barriers, arbitrary argument buffers, cross-queue synchronization, or TypeScript render-bundle
semantics. Those remain application-owned Metal integrations with their own tests.
