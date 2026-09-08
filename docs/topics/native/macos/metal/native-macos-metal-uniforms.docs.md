---
title: Pack uniforms for Metal
summary: Write generated Swift values into application-owned memory using the shader's binding layout.
websitePath: /native/macos/metal/uniforms
keywords: native, macos, metal, swift, uniforms, packing, buffer, alignment
---

# Pack uniforms for Metal

A WGSL uniform describes bytes, not a Swift memory layout. The generated package gives you an
ordinary Swift value and a binding-specific packer. You decide where the bytes live and when the
GPU can read them.

> Warning: Native build tooling is under development. The `vgpu native` shim exists, but its
> operational companion and complete installed workflow are not published yet.
> This example is tested through the internal compiler adapter: WGSL reflection, generated Swift
> packing and bindings, and a native render pass with GPU pixel readback. The current profile
> covers fixed uniform structs with flat `f32`, `vec2f`, `vec3f`, and `vec4f` members.

## Declare shader data

Keep the data declaration beside the entry shader that uses it:

```wgsl
struct Params {
  accent: vec3f,
  gain: f32,
  phase: vec2f,
}

@group(0) @binding(0) var<uniform> params: Params;

@vertex
fn vertex_main(@location(0) position: vec2f) -> @builtin(position) vec4f {
  return vec4f(position, 0.0, 1.0);
}

@fragment
fn fragment_main() -> @location(0) vec4f {
  let color = params.accent * params.gain;
  return vec4f(color + vec3f(params.phase, 0.0), 1.0);
}
```

Name this program `Gradient` in the same build input used by
[the rendering guide](/native/macos/metal/rendering). The generated value is `Gradient.Params`;
the packer for the `params` binding is `Gradient.Uniforms.params`.

Layout belongs to the binding, not to Swift's `MemoryLayout<Gradient.Params>`. For this shader,
`accent` starts at byte `0`, `gain` at byte `12`, and `phase` at byte `16`. The binding occupies
`32` bytes with an alignment of `16`. The packer writes each float at its reflected WGSL offset
and fills padding with zero.

A generated value type can be shared by bindings with the same fields. Each binding still has
its own packer and physical layout; use the packer for the destination binding.

## Pack into CPU memory

Use a generated value to supply fields by name:

```swift
import AppShaders

let layout = Gradient.Uniforms.params
let params = Gradient.Params(
  accent: SIMD3<Float>(0.35, 0.55, 1.0),
  gain: 0.8,
  phase: SIMD2<Float>(0.0, 0.0)
)

var bytes = [UInt8](repeating: 0, count: layout.byteCount)
try bytes.withUnsafeMutableBytes { destination in
  try layout.pack(params, into: destination)
}
```

`pack` works with a writable raw byte span. It does not need a Metal device, create a buffer, or
retain the destination. The span can start at an unaligned CPU address: individual scalar bytes
are written without treating the destination as a Swift struct.

The destination must contain at least `layout.byteCount` bytes. A shorter span throws
`ShaderPackingError.destinationTooSmall(required:actual:)` before changing any bytes. A larger
span is allowed; bytes after `layout.byteCount` remain untouched. Only pass memory that is valid
and writable for the duration of the call.

The first packing profile covers flat structs containing `f32`, `vec2f`, `vec3f`, and `vec4f`.
Nested structs, arrays, matrices, integer fields, and runtime-sized storage need their own
validated packing support; an unsupported layout fails generation instead of using a guessed
Swift representation.

## Write a shared Metal buffer

The same packer can write into a region of an application-owned buffer:

```swift
import Metal

let offset = 256
let uniforms = device.makeBuffer(
  length: offset + layout.byteCount,
  options: .storageModeShared
)!

try layout.pack(
  params,
  into: UnsafeMutableRawBufferPointer(
    start: uniforms.contents().advanced(by: offset),
    count: layout.byteCount
  )
)
```

This short example assumes allocation succeeds. The prefix before `offset` is not modified.
The example's offset is an allocation choice, not a claim that all Metal buffers require
256-byte offsets. `layout.alignment` describes WGSL layout; the native binding must also satisfy
the buffer-offset requirements for the device and address space. See Apple's
[Metal feature set tables](https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf).

Packing does not synchronize access. Wait until earlier GPU work has finished reading a shared
region before writing it again, or use another region. For a private buffer, pack into CPU-visible
staging memory and encode your own copy. Do not call `contents()` on a private buffer.

## Bind an explicit region

The planned binding helper takes a buffer, offset, and visible length:

```swift
let gradient = try Gradient.load(device: device)
let bindings = Gradient.Bindings(
  params: ShaderBufferRange(
    buffer: uniforms,
    offset: offset,
    length: layout.byteCount
  )
)

try gradient.bind(bindings, to: encoder)
encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
```

The application has already selected a matching pipeline, supplied its vertex stream, and
created the render pass. `bind` validates every supplied range before setting any shader buffer
slots. It does not allocate persistent GPU resources, change the pipeline, draw, or submit work.

The range's `length` is host-side validation metadata, not a Metal memory-access boundary.
Metal's direct buffer setters receive a buffer and offset, not a bounded range. Keep the full
buffer alive and synchronize its use as you would for handwritten Metal commands.

See [Bind Metal buffers](/native/macos/metal/bindings) for validation guarantees and direct
stage-qualified slot access. A vertex-stage slot and a fragment-stage slot with the same index
do not collide. A native vertex stream must avoid the generated vertex-stage buffer slots.

Direct packing and direct Metal resources are the integration boundary. They do not require
vgpu to own a frame loop, resource pool, renderer, or SwiftUI view.
