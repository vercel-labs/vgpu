---
title: Use prepared compute bindings
summary: Keep resource ranges and compiler-required bytes together, with a direct Metal path for uploading and binding them yourself.
websitePath: /native/macos/metal/compute/prepared-bindings
keywords: native, macos, metal, swift, compute, prepared bindings, internal data, indirect commands
---

# Use prepared compute bindings

Some translated shaders need compiler-generated data alongside application buffers. A runtime
array's visible length is one example. Preparing a binding set keeps its ranges and these bytes
together so native code does not accidentally combine a new range with an old size table.

> Warning: Native tests on Apple silicon execute both the prepared helper and manual upload path
> with the exact WGSL from the dispatch guide. The package and build commands are not published
> yet. This guide does not establish support for indirect command buffer execution.

## Prepare one binding snapshot

Continue with the shader, loaded functions, and resources from
[Dispatch WGSL compute](/native/macos/metal/compute/dispatch):

```swift
let prepared = try count.prepare(bindings)
```

The result is a program-specific `Count.PreparedBindings`. It has no public initializer and
exposes immutable `bindings` and `internalData` properties. `bindings` contains the same typed
`ShaderBufferRange` values that were validated. `internalData` contains owned CPU bytes and the
stage-qualified slots needed by this compiled program.

Preparation validates the full set, including device identity, range containment, required size,
alignment, and whether visible lengths fit the compiler's size representation. It returns no
partially prepared value on failure. It does not write application memory, create GPU resources,
or encode commands. Only lengths included in an effective compiler size table must fit `UInt32`;
a fixed buffer that does not contribute a size word has no additional `UInt32` length limit.

Invalid ranges use the shared `ShaderBindingError` cases described in
[Bind Metal buffers](/native/macos/metal/bindings). A size-table length that cannot be represented
throws `unrepresentableLength(binding:maximum:actual:)` before conversion or encoding.

The snapshot retains resource references; it does not freeze buffer contents or prove their GPU
lifetime. Changing a buffer's bytes can be intentional, but changing a visible range requires a
new binding value and another call to `prepare`.

## Reuse the convenience helper

```swift
encoder.setComputePipelineState(pipeline)
try count.bind(prepared, to: encoder)
encoder.dispatchThreadgroups(
  MTLSize(width: 1, height: 1, depth: 1),
  threadsPerThreadgroup: Count.workgroupSize
)
```

`count.bind(bindings, to: encoder)` is the short form that prepares and binds once. Use the
prepared form when you need to inspect or reuse the CPU description. Encoder-device validation
still happens before any setter; preparation does not validate a future encoder or pipeline.

The prepared value belongs to the actual Metal device used to load its program. Binding it through
functions loaded on a different device throws `preparedDeviceMismatch` before any setter.
Reloading the same program on the same device does not invalidate the snapshot.

Preparing fixed-uniform-only render bindings is not required by this compute API. The additional
snapshot exists to keep resource-dependent compiler bytes and their source ranges consistent.

## Upload internal bytes yourself

Each `ShaderInternalBufferData` value exposes `slot`, `bytes`, and `offsetAlignment`.
`slot` is a `ShaderBufferSlot`; `bytes` is an immutable `[UInt8]`; `offsetAlignment` is the required
alignment if you place those bytes in a region of a native buffer. An empty effective internal
payload produces no entry. The metadata does not invent an allocation for every reserved slot.
For example, a shader that reads only a runtime-array struct's fixed prefix may need no size table.
When a table is needed, its entries preserve physical buffer-slot indices, including zero-filled
holes. Application code should upload the provided bytes without constructing that table itself.

Allocate the upload buffers using your own Metal device:

```swift
var internalUploads: [any MTLBuffer] = []
for payload in prepared.internalData {
  precondition(payload.slot.stage == .compute)
  let buffer = payload.bytes.withUnsafeBytes { bytes in
    device.makeBuffer(bytes: bytes.baseAddress!, length: bytes.count, options: .storageModeShared)!
  }
  encoder.setBuffer(buffer, offset: 0, index: payload.slot.index)
  internalUploads.append(buffer)
}
```

This short example assumes allocation succeeds. Offset `0` satisfies each upload's alignment;
for a suballocated region, satisfy `offsetAlignment`, copy exactly `bytes.count` bytes, and bind
that region's offset. Keep the upload buffers alive until the GPU has finished with them.

Set the application buffers from the same prepared value:

```swift
for slot in Count.Storage.values.slots {
  encoder.setBuffer(prepared.bindings.values.buffer, offset: prepared.bindings.values.offset, index: slot.index)
}
for slot in Count.Storage.output.slots {
  encoder.setBuffer(prepared.bindings.output.buffer, offset: prepared.bindings.output.offset, index: slot.index)
}
```

Use a compatible compute encoder and pipeline, then dispatch as in the first guide. Both this
manual path and `count.bind(prepared, to: encoder)` must produce `[2, 202]` for the `28`-byte view
and `[4, 404]` for the `52`-byte view. No application code writes Tint-private offsets or size words.

## Keep advanced Metal work explicit

The first profile handles internal size data derived entirely from validated buffer ranges.
An internal role that also depends on dispatch or other application state needs an explicit input
and a tested contract; missing state is not silently replaced with zero.

Ordinary encoding can copy these small payloads through Metal's inline-byte API. Native indirect
compute commands instead expose buffer arguments, which is why the prepared bytes are available
for caller-owned uploads. See Apple's
[MTLIndirectComputeCommand reference](https://developer.apple.com/documentation/metal/mtlindirectcomputecommand).

This does not make an arbitrary pipeline or resource set safe for indirect commands. The
application still configures indirect pipeline support, buffer inheritance, resource residency,
barriers, storage-mode synchronization, and lifetime. An actual indirect-command execution test
is a separate support gate, not a consequence of being able to inspect the bytes.
