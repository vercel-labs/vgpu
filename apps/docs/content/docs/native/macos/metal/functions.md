---
title: "Load Metal functions"
description: "Load generated shader programs on your Metal device and use their functions in native pipelines."
---

A generated shader package gives your Metal code access to selected shader functions without
requiring a vgpu renderer. You create the device, resources, pipelines, encoders, and command buffers.
vgpu generates the package and resolves its compiled function names.

> Warning: This is the direct Metal API under development. The command shim exists, but its
> operational companion and complete installed workflow are provided by the optional beta companion. This page defines
> the first function-loading slice; generated uniform packing and resource binding helpers are
> separate work, not APIs implemented by this example.

## Add the generated package

One generated configuration produces one Swift package with one library product and one `.metallib`
resource. Add that local package to your application and select its library product. For a module
named `AppShaders`, your Swift files import `AppShaders`.

The first package is self-contained: it depends on system frameworks, not `VGPUABI`, a vgpu context,
or a separately installed Swift support package. Independent shader packages can coexist in an app.
Qualify program names with their module when two modules define the same name.

Each package needs a distinct module identity. Module and program names must be supported Swift
identifiers and must not collide with generated declarations, imported module names, or another
generated file on a case-insensitive filesystem. Generation reports a naming error instead of
silently renaming a program.

The build tool records the selected emitted function names and the library's expected SHA-256 in
generated Swift. Those names and resource paths are implementation details, not arguments the
application must supply. Keep the generated source and its library together; do not edit either file.

## Load a render program

Assume your generated package contains a render program named `Triangle` with a selected vertex
and fragment entry point:

```swift
import Metal
import AppShaders

let triangle = try Triangle.load(device: device)

let descriptor = MTLRenderPipelineDescriptor()
descriptor.vertexFunction = triangle.vertex
descriptor.fragmentFunction = triangle.fragment
descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm

let pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
```

`device` is the application's existing `MTLDevice`. `Triangle.load(device:)` returns
`Triangle.Functions` with nonoptional `vertex` and `fragment` properties. Both conform to
`MTLFunction`. The loader verifies their stages before returning; Swift's Metal API does not give
vertex and fragment functions different static protocol types.

A program with only a selected vertex or fragment stage exposes only that stage's property. A
compute program exposes `compute`. Missing selected functions fail loading rather than returning
optional properties that the caller must unwrap.

The application configures vertex layouts, attachment formats, blending, depth, sample count, and
pipeline options. Loading a shader does not create a pipeline or decide whether that pipeline is
compatible with the application's render pass.

## Load a compute program

A generated compute program uses the same loading pattern:

```swift
let step = try StepParticles.load(device: device)
let pipeline = try device.makeComputePipelineState(function: step.compute)
```

You create the compute encoder, bind resources, and dispatch work through Metal. Loading functions
does not dispatch anything. Uniform packing, shader resource slots, and compiler-required internal
data must be handled by the matching binding integration; this loading API alone does not establish
that arbitrary shader resources have been bound correctly.

Shader overrides are selected before compilation. This slice does not perform runtime Metal
function-constant specialization. It rejects any remaining function-constant metadata, including
constants with defaults, rather than implicitly selecting a different specialization policy.

## Keep ownership explicit

Load once for a program and device, then retain the returned functions or the pipeline you create
from them. Each `load` call may load the packaged library again; there is no global library cache,
device registry, or hidden context. Reuse is controlled by your application.

The loader reads its private package resource, checks the library bytes, and asks the supplied
device to create a Metal library. Returned functions belong to that device. It creates no other
GPU resources, queues, pipelines, command buffers, submissions, or completion observers.

You own the lifetime and synchronization of resources used by your commands. This API neither
tracks external work nor replaces Metal completion handling. Swift build still requires Swift
tooling, but the built application needs no Node.js, Tint, or Apple shader compiler at runtime.

## Handle loading errors

The generated module exposes `ShaderLoadError`. Errors distinguish an unavailable or unreadable
library file inside the package resource bundle, changed library bytes, a Metal library creation failure, a missing selected
function, an unexpected function stage, and unsupported function-constant specialization.
Function errors identify the authored program and selected stage; system failures retain their
underlying error. Do not parse diagnostic strings or rely on a physical resource path.

Include the complete SwiftPM resource bundle when distributing your application. If the entire
bundle is missing, SwiftPM's generated `Bundle.module` accessor can terminate the process before
the loader can return `ShaderLoadError`. The loader uses standard SwiftPM resource lookup; it does
not recover from an incorrectly packaged application by searching arbitrary filesystem locations.

```swift
do {
  let triangle = try Triangle.load(device: device)
  // Use triangle.vertex and triangle.fragment in your native pipeline.
} catch let error as AppShaders.ShaderLoadError {
  // Report the shader-loading failure through your application's error UI.
  print(error)
}
```

An integrity hash detects accidental changes or crossed package contents; it is not a signature
that authenticates an untrusted package. Use trusted package sources. Failures from creating or
executing your Metal pipeline remain Metal errors, not loading errors from this generated module.

## Continue with Metal

See [Render WGSL with Metal](/native/macos/metal/rendering) for an imported WGSL program consumed
by an application-owned vertex descriptor, buffer, and render pipeline.

Loaded functions can be used in compatible native pipelines, including multiple color outputs.
The loader does not impose a single-color target, a frame loop, or an encoder abstraction.
Native indirect command buffers have their own pipeline, resource, and device requirements; this
loader does not implement TypeScript render-bundle semantics or a general ICB binding adapter.

The initial deployment target is macOS 14 on Apple silicon. The exact supported Swift/Xcode matrix
still needs release validation; successfully loading a function on one machine is not that matrix.
