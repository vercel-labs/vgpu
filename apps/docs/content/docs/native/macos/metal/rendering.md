---
title: "Render WGSL with Metal"
description: "Compile imported WGSL into a generated package and draw with your own Metal pipeline, vertex buffer, and render pass."
---

Write shader behavior in WGSL. Your Swift code chooses the vertex data, target formats, pipeline,
and commands. The generated package connects the compiled shader functions to that native code;
it does not introduce an effect, frame, or renderer object.

> Warning: Native build tooling is under development. The `vgpu native` shim exists, but its
> operational companion and complete installed workflow are not published yet.
> This guide defines the first compiler-to-render example. The build input below is the proposed
> command configuration; it is exercised through the internal compiler adapter until the companion
> workflow is available. The compiler also supports the fixed uniform profile described in
> [Pack uniforms for Metal](/native/macos/metal/uniforms).

## Share shader code

Create a pure module containing the color calculation:

```wgsl
// shaders/palette.wgsl
export fn color() -> vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
```

Import it from the entry shader:

```wgsl
// shaders/triangle.wgsl
import { color } from "./palette.wgsl";

@vertex
fn vertex_main(@location(0) position: vec2f) -> @builtin(position) vec4f {
  return vec4f(position, 0.0, 1.0);
}

@fragment
fn fragment_main() -> @location(0) vec4f {
  return color();
}
```

These are the same [WGSL modules](/concepts/wgsl-modules) used by the TypeScript API. Resolution
follows the imports before Tint validates and translates the selected entry points. Changing the
imported function changes the generated shader; Swift does not need a copy of that calculation.

The vertex input at location `0` is supplied by a native vertex descriptor. It is not a WGSL
`@group`/`@binding` resource. This example needs no generated resource-binding helper.

## Select the program

Select the two entry points that form the program:

```json
{
  "moduleName": "AppShaders",
  "programs": [
    {
      "name": "Triangle",
      "source": "shaders/triangle.wgsl",
      "entryPoints": {
        "vertex": "vertex_main",
        "fragment": "fragment_main"
      }
    }
  ]
}
```

Source paths are relative to the configuration. Imports remain relative to their importing module.
The compiler checks the selected stages and records their shader interfaces before building a
library. Your call to `makeRenderPipelineState` validates the native pipeline configuration,
including its stage compatibility. The compiler does not infer a renderer from the program's name
or put target formats in the shader configuration.

The internal adapter currently receives the source modules explicitly. Reading a configuration
from disk, installing the compiler, and publishing output directories are separate command work.
Generation returns a complete package's files only after translation and offline compilation
succeed. A failed compile does not return Swift paired with an older library.

## Create a native pipeline

After adding the generated package, load the selected functions on your application's `device`:

```swift
import Metal
import AppShaders

let triangle = try Triangle.load(device: device)

let vertices = MTLVertexDescriptor()
vertices.attributes[0].format = .float2
vertices.attributes[0].offset = 0
vertices.attributes[0].bufferIndex = 0
vertices.layouts[0].stride = 8
vertices.layouts[0].stepFunction = .perVertex

let descriptor = MTLRenderPipelineDescriptor()
descriptor.vertexFunction = triangle.vertex
descriptor.fragmentFunction = triangle.fragment
descriptor.vertexDescriptor = vertices
descriptor.colorAttachments[0].pixelFormat = .rgba8Unorm

let pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
```

`attributes[0]` matches the shader's `@location(0)`. Each vertex contains two 32-bit floats, so
the stride is eight bytes. The vertex stream uses Metal buffer index `0`, chosen by the application.
That choice is valid for this resource-free program; a program with shader buffers must keep
vertex streams disjoint from the generated vertex-stage shader and internal buffer slots.
Fragment-stage buffer slots use a separate namespace.

The pipeline format must match the actual attachment. Loading the functions does not validate
your vertex buffer, create a target, or choose blending, depth, sample count, or culling.

## Provide vertex data

A full-screen triangle needs three positions:

```swift
let positions: [Float] = [-1, -1, 3, -1, -1, 3]
let vertexBuffer = positions.withUnsafeBufferPointer { pointer in
  device.makeBuffer(
    bytes: pointer.baseAddress!,
    length: pointer.count * MemoryLayout<Float>.stride,
    options: .storageModeShared
  )!
}
```

This is application-owned vertex data with an explicitly configured Metal format, not a copy of
a Swift struct into a WGSL uniform layout. The short example assumes allocation succeeds; handle
Metal's optional allocation results in application code.

## Encode the draw

Use your existing render command encoder, whose attachment matches the pipeline:

```swift
encoder.setRenderPipelineState(pipeline)
encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)
encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
```

The application creates the render pass and command buffer, ends encoding, and submits the work.
For this shader, a covered pixel is opaque red. Changing the imported helper to return
`vec4f(0.0, 1.0, 0.0, 1.0)` makes it green after regeneration, without changing the Swift draw code.

Do not overwrite shared vertex bytes while submitted GPU work still reads them. Native command
completion and pipeline-execution errors remain the application's responsibility, including when
it mixes generated shaders with other Metal commands.

## Keep the compiler profile explicit

The render compiler adapter requires one selected vertex and one selected fragment stage per
program. Resources can be fixed uniform structs containing `f32`, `vec2f`, `vec3f`, and `vec4f`
members. Active overrides, other resource kinds, and effective compiler-required internal buffers
or storage-size payloads are rejected. Source features outside this profile
fail explicitly; the compiler does not produce a package whose required data cannot be supplied.

If translation reports an effective internal payload, assuming that the missing bytes would be
zero does not make that shader safe to use. Support follows a generated binding contract and an
executed test, not just successful MSL generation. The check uses the compiler's actual metadata;
it does not infer payload requirements merely from the presence of a built-in such as `vertex_index`.

This compiler boundary is narrower than the [function loader](/native/macos/metal/functions),
which can already expose a selected compute function or a single render stage from a compiled
library. Storage buffers, textures, specialization, and compiler-supported language
features are added through their own documented integration, without adding a Swift renderer.

Compiler failures identify their stage: source resolution, native validation/translation, or
offline Metal compilation. Authored locations are reported only when a real source mapping is
available; a resolved-source diagnostic is not relabeled as an authored line number. An unknown
worker, mismatched response identity, unsupported metadata, cancellation, or failed compiler
process fails the build instead of returning an unchecked package.
