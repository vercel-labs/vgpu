---
title: Bind Metal buffers
summary: Validate explicit uniform ranges and use generated slot metadata with your own Metal encoder.
websitePath: /native/macos/metal/bindings
keywords: native, macos, metal, swift, bindings, uniform buffer, range, slots, encoder
---

# Bind Metal buffers

The generated binding helper connects application-owned buffers to a program's Metal slots.
It does not own a pipeline, resource pool, or command buffer. You can use the helper for ordinary
render encoding or read the same slot metadata from your own native code.

> Warning: Native build tooling is under development and no native command is published yet.
> The fixed-uniform render path is tested through the internal compiler adapter and native
> consumers. Device execution coverage is Apple silicon; this is not a release support matrix.

## Describe the uniform region

Use the `Gradient` shader and packed buffer from [Pack uniforms for Metal](/native/macos/metal/uniforms).
Load the functions on the same device that created the buffer:

```swift
let gradient = try Gradient.load(device: device)
let layout = Gradient.Uniforms.params

let bindings = Gradient.Bindings(
  params: ShaderBufferRange(
    buffer: uniforms,
    offset: offset,
    length: layout.byteCount
  )
)
```

`ShaderBufferRange` stores immutable `buffer`, `offset`, and `length` properties. Constructing it
does not encode commands or validate it against a program. `Bindings` also stores immutable
properties; create another value when you want to select a different region or buffer.

The range retains its buffer reference. The application still owns GPU lifetime and synchronization,
including command buffers configured not to retain their resources. A retained Swift value does
not prove that earlier GPU work has finished reading the bytes.

## Validate before encoding

With the matching pipeline and vertex stream already selected, bind the uniforms before drawing:

```swift
try gradient.bind(bindings, to: encoder)
encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
```

`bind` checks the full binding set and the encoder's device before calling any Metal setters.
It rejects negative offsets or lengths, ranges extending beyond their buffers, ranges smaller
than the shader's required size, misaligned offsets, and resources from another Metal device.
Containment checks do not add untrusted integers in a way that can overflow.

Validation failures throw `ShaderBindingError`. Its cases distinguish `invalidRange`,
`insufficientRange`, `misalignedOffset`, `resourceDeviceMismatch`, and `encoderDeviceMismatch`.
The first four identify the authored binding name; size and alignment failures include the
required and supplied values. No slots have been changed when one of these checks fails.

The required buffer-offset alignment covers both the shader layout and native binding constraints.
The candidate uses the Apple GPU family's four-byte constant-buffer minimum and a conservative
256-byte fallback outside that tested device family, combined with the layout's alignment. That
fallback is a compatibility policy, not a claim that every Metal GPU requires 256 bytes or that
Intel support has been verified. See Apple's
[Metal feature set tables](https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf).

This requirement is not the same property as `layout.alignment`, which describes WGSL packing.
Do not infer an application's allocation strategy from a shader's group or binding number.

After validation, the helper sets only the program's recorded shader buffer slots. It does not
clear unrelated slots, change a pipeline, supply vertex data, draw, end encoding, or submit work.
Call it again after selecting another binding set or after native code overwrites one of those slots.

## Use the slot metadata directly

You do not need to use the convenience encoder method. Validate without encoding, then set the
same buffers yourself:

```swift
try gradient.validate(bindings)

for slot in layout.slots {
  switch slot.stage {
  case .vertex:
    encoder.setVertexBuffer(bindings.params.buffer, offset: bindings.params.offset, index: slot.index)
  case .fragment:
    encoder.setFragmentBuffer(bindings.params.buffer, offset: bindings.params.offset, index: slot.index)
  case .compute:
    preconditionFailure("This example selects a render program")
  }
}
```

`layout.slots` is an immutable array of stage-qualified `ShaderBufferSlot` values, each with
`stage` and `index` properties. A WGSL `@group(0) @binding(0)` declaration does not promise Metal
index `0`; use the generated mapping. A binding read by both stages has a mapping for each stage.

`validate` checks resources against the loaded program's device. Unlike `bind`, it does not have
an encoder to check: native code must use a compatible encoder and pipeline. Neither method
can inspect your current vertex descriptor, vertex stream slots, attachment formats, resource
contents, or application synchronization.

Vertex streams and shader buffers share the vertex stage's buffer namespace. Keep your vertex
stream slots disjoint from the generated vertex-stage slots. Fragment-stage slots are independent.

## Keep the boundary explicit

The first binding profile covers fixed-size uniform buffers in render programs without effective
compiler-internal payloads. It does not accept textures, storage buffers, runtime-sized arrays,
compute encoders, or compiler-specific data merely because Metal has a setter for them.

An explicit `length` is host-side metadata. Metal's direct buffer setters bind a buffer and an
offset, not a hardware-enforced bounded subrange. This helper does not provide memory isolation
between regions of a buffer.

Shared, managed, and private buffers remain native resources. Pack into CPU-visible memory;
for private storage, perform your own staging copy. Apply any synchronization required by your
chosen storage mode, and do not overwrite a region while submitted GPU work reads it.

The direct slot metadata is useful outside convenience rendering, but it is not a general indirect
command buffer contract. Indirect commands also require compatible pipelines, resource residency,
and any compiler-required internal data. Those capabilities need their own documented integration.
