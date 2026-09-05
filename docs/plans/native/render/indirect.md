# Compute-to-draw indirect contract

Status: the isolated DC1 WebGPU, portable Swift, and connected Swift/Metal gates pass. Production
integration remains open.

## Public shape

Indirect capability is an immutable creation-time buffer usage, separate from WGSL storage access:

```swift
let arguments = try gpu.storage(
  UInt32.self,
  count: 8,
  access: .readWrite,
  additionalUsage: [.indirect]
)

let packet = try arguments.buffer.slice(bytes: 16..<32)

try gpu.frame { frame in
  try frame.pass(target: target) { pass in
    try pass.draw(draw, indirect: packet)
  }
}
```

Storage and copy capability remain intrinsic to `gpu.storage`; `additionalUsage` adds roles such as
`.indirect`, and later `.vertex` or `.index`, without suggesting that callers can remove the
intrinsic usages. Changing storage `access` does not change buffer usage, and usage cannot change
after allocation.

`VGPUStorage.buffer` returns a bounded `VGPUBuffer` view over the storage resource. It neither
copies bytes nor creates another allocation owner. `VGPUBuffer.slice(bytes:)` returns another
bounded view whose byte range is relative to the receiver's effective range:

```swift
let secondPacket = try arguments.buffer.slice(bytes: 16..<32)
try pass.draw(draw, indirect: secondPacket)
```

A slice preserves the same context, concrete generation, and usage set as its source while deriving
a narrower logical extent from the requested subrange. An accepted consumer acquires the normal generation lease while encoding; creating a view
does not itself register in-flight work. Nested slices remain relative to their immediate receiver. Bounds are never inferred from a Metal
allocation's physical length. This keeps imported subranges and runtime-sized storage views from
silently exposing bytes outside their effective range.

The consumer defines the packet layout. A non-indexed draw reads 16 bytes, an indexed draw reads
20, and a future `dispatch(indirect:)` reads 12. The buffer view is deliberately not named after one
of those consumers because one allocation may contain packets for several operations.

## Validation and ordering

The consuming draw or dispatch validates context identity, `.indirect` usage, the effective absolute
offset's four-byte alignment, integer overflow, and the complete required byte range synchronously. Missing usage, bad alignment,
overflow, or an insufficient range throws `VGPU-INDIRECT-INVALID`; a resource from another context
preserves the shared `VGPU-NATIVE-CONTEXT-MISMATCH` error. Either failure occurs before work
registration, backend submission, or `onError` delivery.

An accepted command snapshots the buffer generation and bounded range and holds its lease through
GPU completion. A preceding one-shot compute submission and following render submission use the
same ordered queue. The application does not await a submission token or read the packet between
them:

```swift
_ = try prepare.dispatch(x: 1)

_ = try gpu.frame { frame in
  try frame.pass(target: target) { pass in
    try pass.draw(draw, indirect: packet)
  }
}
```

Metal encodes a direct indirect draw from the snapshotted buffer and offset. It does not require a
Metal indirect-command buffer. A future Vulkan backend inserts its required compute-write to
indirect-read barrier internally; resource transitions are not part of the public command graph.

Indirect usage, slices, and command data are runtime resource state. They add no fields to the
backend-neutral semantic contract or Metal projection.

## DC1 falsifiable fixture

DC1 uses one eight-`u32` allocation. Words `0...3` are the zero-count decoy
`[0, 0, 0, 0]`. Words `4...7`, at bytes `16..<32`, are the real non-indexed draw packet. The target clears
blue, and the draw instance's direct vertex count is zero so ignoring the indirect overload is also
observable. The vertex program contains two full-screen triangles and derives their colors from
`vertex_index`. The initial packet `[3, 1, 3, 0]` selects the red triangle; compute replaces it with
`[3, 1, 0, 0]`, selecting the green triangle. Passing the bounded
`slice(bytes: 16..<32)` proves the non-zero offset path; accidentally consuming byte zero selects
the decoy and leaves the target blue. The observable outcomes are therefore distinct:

| Result | Meaning                                        |
| ------ | ---------------------------------------------- |
| Blue   | The indirect draw did not execute.             |
| Red    | The draw consumed the stale packet.            |
| Green  | The draw consumed the compute-produced packet. |

The accepted-work trace is exactly two ordered submissions: one compute dispatch, then one render
frame containing the indirect draw. There is no packet readback, CPU wait, or intermediate
settlement. Target readback happens only after both submissions and must be exact green.

Negative cases remove `.indirect`, cross contexts, misalign the slice, and provide fewer than the
required 16 bytes. Missing usage, misalignment, and insufficient range must synchronously produce
`VGPU-INDIRECT-INVALID`; context mismatch must produce `VGPU-NATIVE-CONTEXT-MISMATCH`. Each leaves
the accepted-work trace unchanged and produces neither a submission token nor an `onError` event.

DC1 is one direct gate. There is no separate DC1a milestone.

## Passing isolated evidence

The public WebGPU oracle and connected Metal path reproduce the exact blue, red, and green controls.
The Metal fixture records `computeCommit` followed by `frameCommit` on one queue, the same allocation
and generation at both consumers, view range `[16, 32]`, consumer offset `0`, physical offset `16`,
and one authenticated library load. It performs no packet readback or application await between the
dispatch and frame; target readback is the first suspension after both commits.

The portable recording backend additionally proves nested relative slices and five synchronous
rejections: missing `.indirect`, foreign context, misaligned effective offset, short range, and
integer overflow. Every rejection leaves submission, token, and `onError` counts unchanged. The
connected artifact is deterministic, relocatable, source-free after generation, and keeps generated
`AppShaders` dependent only on `VGPUABI` while Compute and Render remain separate products.

This evidence covers one ordinary fixed-size storage allocation and a 16-byte non-indexed draw on
the available Apple-silicon device. The `x86_64` result is compile-only. Indexed draw, indirect
dispatch, imported or runtime-sized views, Vulkan transitions, production distribution, and the
complete target lifecycle remain open.
