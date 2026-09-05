---
title: GPU-driven drawing
summary: Let compute produce draw arguments that a later render submission consumes without a CPU readback.
websitePath: /native/macos/gpu-driven-drawing
keywords: macos, swift, vgpu, compute, draw, indirect, gpu driven, storage, buffer, queue
relatedSymbols:
  - Storage
  - Buffer
  - Compute
  - Draw
  - FramePass
---

# GPU-driven drawing

An indirect draw reads its vertex and instance counts from a buffer. A compute program can write
that buffer, then a render submission can consume it without copying the counts back to Swift.
This keeps culling, compaction, and variable workloads on the GPU.

> Warning: Native macOS support is a docs-first API proposal. The Swift APIs on this page are not implemented yet.

## Create storage for indirect arguments

Storage buffers already include their binding and copy usages. Add `.indirect` when the same bytes
will also supply command arguments:

```swift
let arguments = try gpu.storage(
  UInt32.self,
  count: 9,
  access: .readWrite,
  additionalUsage: [.indirect],
  initial: [
    0, 0, 0, 0, // Control packet: draw nothing.
    3, 1, 3, 0, // Stale packet: draw three vertices starting at vertex 3.
    0,          // Color signal read by the fragment program.
  ]
)
```

`access` describes how WGSL bindings may use the storage resource. `additionalUsage` describes
other operations the buffer may perform. Both are fixed when the resource is created; read-write
storage does not implicitly opt into indirect commands.

`arguments.buffer` is a bounded `VGPUBuffer` view over the same allocation. It does not copy bytes
or create another allocation owner. Slice a packet by byte range when one allocation contains more
than one command:

```swift
let drawArguments = try arguments.buffer.slice(bytes: 16..<32)
```

The range is relative to the buffer view, not to its underlying allocation. The slice preserves
the same context, usage, resource generation, and effective extent as its source. This makes a
subrange safe to pass around without exposing bytes outside the source view. Creating the slice
does not register GPU work or acquire an in-flight lease.

## Write on the GPU, then draw

Create the compute and draw instances once. In this example, `PrepareDraw` writes words `4...8` of
`arguments`. `IndirectTriangles` contains two procedural full-screen triangles and reads word `8`
as its color signal:

```swift
let prepare = try gpu.compute(
  PrepareDraw.self,
  bindings: .init(produced: arguments)
)

let triangles = try gpu.draw(
  IndirectTriangles.self,
  bindings: .init(consumed: arguments)
)
```

Dispatch compute, then submit the render frame. Do not await the compute submission between the two
calls:

```swift
_ = try prepare.dispatch(x: 1)

_ = try gpu.frame { frame in
  try frame.pass(
    target: output,
    color: .clear([0, 0, 1, 1])
  ) { pass in
    try pass.draw(triangles, indirect: drawArguments)
  }
}
```

The compute dispatch and frame are separate submissions on the context's ordered queue. The frame
therefore observes the compute writes without an intermediate `await`, `settled()`, or buffer
readback. Awaiting between every compute and render call would serialize CPU encoding with GPU
execution and remove the main benefit of this pattern.

When the draw is encoded, vgpu snapshots the slice's exact resource generation and byte range and
acquires its normal in-flight lease. That generation remains alive until the render submission
completes, even if application code later disposes its public resource wrapper.

This ordering and lifetime contract is backend-neutral. Each backend is responsible for the
resource transitions required by its native command API; those transitions do not appear in the
Swift surface.

## Use the correct packet layout

The consuming operation determines how many bytes it reads:

| Operation | Words, in order | Size |
| --- | --- | --- |
| Non-indexed draw | `vertexCount`, `instanceCount`, `firstVertex`, `firstInstance` as `u32` | 16 bytes |
| Indexed draw | `indexCount: u32`, `instanceCount: u32`, `firstIndex: u32`, `baseVertex: i32`, `firstInstance: u32` | 20 bytes |
| Indirect dispatch | `x`, `y`, `z` as `u32` | 12 bytes |

The same `VGPUBuffer` and `slice(bytes:)` API can represent any of these packets. A future
`dispatch(indirect:)` consumes the 12-byte layout; the buffer view itself does not encode one
specific command kind.

Offsets must be multiples of four bytes. A slice may be larger than the packet, but the complete
layout required by the selected draw or dispatch must fit inside its bounded range.

## Handle validation errors

Indirect validation happens synchronously when the command is encoded:

- A buffer from another `VGPU` preserves the normal `VGPUError.contextMismatch` error.
- A buffer without `.indirect`, a misaligned slice, or a range too short for the selected packet
  throws `VGPU-INDIRECT-INVALID`.

These failures occur before work registration or submission. They return no submission token and
are not delivered again through `gpu.onError`.

## Read back only when testing

Application rendering does not need to read either the packet or the target. A test can read the
final target after the render submission to make the dependency observable:

```swift
let pixels = try await output.read()
XCTAssertEqual(pixels, expectedGreenPixels)
```

For a diagnostic fixture, clear the target blue, initialize the active packet and signal so stale
data renders red, and have compute replace them with a packet that renders green. Blue means the
indirect draw did not execute, red means it consumed stale data, and green proves that the render
submission consumed the compute-produced values. This readback is a test boundary, not part of the
GPU-driven frame loop.

## Next steps

- [Create storage and bounded buffer views](/native/macos/resources)
- [Compose render and compute submissions](/native/macos/rendering)
- [Wait for submitted work at explicit boundaries](/native/macos/lifecycle#wait-for-submitted-work)
