---
title: "Dispatch WGSL compute"
description: "Run a generated compute function with application-owned Metal buffers, a pipeline, and an explicit workgroup grid."
---

A generated compute program exposes a Metal function, its WGSL workgroup size, and helpers for
binding its resources. Your application creates the pipeline and decides when and how much work
to dispatch.

> Warning: The internal compiler and generated bindings execute this guide in native tests on
> Apple silicon, including GPU readback for both visible ranges. The command shim exists; the
> generated package, operational companion, and complete installed workflow are not published yet.
> These tests do not establish the release support matrix.

## Read a bounded storage view

This shader reports how many particles are visible through a binding and the last particle's ID:

```wgsl
// shaders/count.wgsl
struct Particle {
  @size(8) mass: u32,
  id: u32,
}

struct Values {
  prefix: u32,
  particles: array<Particle>,
}

@group(0) @binding(0) var<storage, read> values: Values;
@group(0) @binding(1) var<storage, read_write> output: array<u32, 2>;

@compute @workgroup_size(1)
fn count_main() {
  let count = arrayLength(&values.particles);
  output[0] = count;
  output[1] = 0u;
  if (count > 0u) {
    output[1] = values.particles[count - 1u].id;
  }
}
```

The prefix occupies four bytes. Each particle occupies twelve: four for `mass`, four bytes of
padding from `@size(8)`, and four for `id`. A visible range of `28` bytes contains the prefix and
two particles. A range of `52` bytes contains the prefix and four particles. The fixed output
array requires eight bytes for its two results.

Select the compute entry point in the proposed
[build configuration](/native/macos/metal/tooling/configuration):

```json
{
  "schemaVersion": 1,
  "moduleName": "AppShaders",
  "programs": [
    {
      "name": "Count",
      "source": "shaders/count.wgsl",
      "entryPoints": { "compute": "count_main" }
    }
  ],
  "output": "Generated/AppShaders"
}
```

A compute program selects one compute entry point, not a vertex/fragment pair. It uses the same
WGSL module resolver and generated Swift package as the render integration.

## Create the native pipeline

```swift
import Metal
import AppShaders

let count = try Count.load(device: device)
let pipeline = try device.makeComputePipelineState(function: count.compute)
```

`Count.workgroupSize` is an `MTLSize` containing the authenticated, fixed WGSL dimensions.
For this shader it is `(1, 1, 1)`. Pass those dimensions as `threadsPerThreadgroup`; they are part
of the shader's execution contract, not a suggested tuning parameter or a grid size.

The application checks the native pipeline and device limits. The initial compute profile uses
compile-time workgroup dimensions without overrides and complete threadgroups; specialized sizes and partial
threadgroup dispatch need separate support.

## Provide the storage bytes

For this small integer-only fixture, write the declared layout explicitly. This is not a general
packer or a copy of a Swift struct:

```swift
let offset = 256
let words: [UInt32] = [
  99,          // prefix
  1, 0, 101,   // mass, padding, id
  2, 0, 202,
  3, 0, 303,
  4, 0, 404,
]
let valuesBuffer = device.makeBuffer(length: offset + 52, options: .storageModeShared)!
for (index, word) in words.enumerated() {
  valuesBuffer.contents().storeBytes(
    of: word.littleEndian,
    toByteOffset: offset + index * 4,
    as: UInt32.self
  )
}
let outputBuffer = device.makeBuffer(length: 8, options: .storageModeShared)!
```

The short example assumes allocations succeed. The buffer holds all four particles, but the
binding below exposes only its first `28` bytes from `offset`:

```swift
let bindings = Count.Bindings(
  values: ShaderBufferRange(buffer: valuesBuffer, offset: offset, length: 28),
  output: ShaderBufferRange(buffer: outputBuffer, offset: 0, length: 8)
)
```

The generated integration derives runtime-array size data from `length`. It does not substitute
`valuesBuffer.length - offset`, which would expose all four particles to `arrayLength`.

## Encode and submit

On your application's compute command encoder:

```swift
encoder.setComputePipelineState(pipeline)
try count.bind(bindings, to: encoder)
encoder.dispatchThreadgroups(
  MTLSize(width: 1, height: 1, depth: 1),
  threadsPerThreadgroup: Count.workgroupSize
)
```

This dispatch runs one complete workgroup. Larger kernels usually derive their grid from the
application's data and perform shader-side bounds checks. See Apple's
[dispatchThreadgroups reference](https://developer.apple.com/documentation/metal/mtlcomputecommandencoder/dispatchthreadgroups(_:threadsperthreadgroup:)).

End encoding and submit your command buffer. After successful GPU completion, the two output
words are `[2, 202]`. Construct bindings with `length: 52` and dispatch again to produce
`[4, 404]`. Neither the backing allocation nor the shader needs to change.

A range may end partway through another element. For example, `length: 31` still produces
`[2, 202]`: the remaining three bytes do not form a complete particle. The offset must satisfy the
buffer layout's alignment; the length does not need to be a multiple of four.

Do not read the output before completion or overwrite input bytes still in use by submitted work.
The application owns command failures, synchronization, pipeline state, and resource lifetime.

## Keep compiler data consistent with bindings

`bind` validates the entire resource set and the encoder's device before setting anything. For
this profile, it also supplies effective compiler-required size bytes through Metal's inline-byte
binding. It does not allocate persistent buffers or infer application state that is absent from
the binding set.

You can prepare the resource snapshot and internal bytes explicitly, then either reuse the
convenience helper or upload them yourself. Continue with
[Use prepared compute bindings](/native/macos/metal/compute/prepared-bindings).

The explicit range is not a hardware-enforced Metal memory boundary. It supplies validation and
compiler metadata for the supported shader profile; it does not provide isolation between buffers
or validate arbitrary native commands.

## Stay within the initial resource profile

Compute programs currently support read-only and read/write storage buffers with `f32`, `i32`,
and `u32` scalars, vectors, float matrices, fixed arrays, and fixed nested structs. A runtime array
can be the binding's root type or the final member of its root struct. The application writes
storage bytes using the WGSL layout; this profile does not generate storage packers.

Active uniform buffers, textures, atomics, `f16`, and shader overrides fail compilation in this
profile. Fixed workgroup sizes can use constants from imported modules. A generated package may
contain both render and compute programs, with each program's resource profile checked separately.
