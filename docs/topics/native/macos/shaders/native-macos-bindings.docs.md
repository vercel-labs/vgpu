---
title: Bindings and generated types
summary: Initialize and update typed Swift bindings while preserving WGSL names, layouts, and resource ownership.
websitePath: /native/macos/bindings
keywords: macos, metal, swift, native bindings, uniforms, storage, generated types, wgsl
relatedSymbols:
  - effect
  - draw
  - compute
  - resolveShader
---

# Bindings and generated types

`vgpu native build` turns reflected WGSL types and bindings into ordinary Swift values and typed vgpu resource handles. Generated descriptors describe programs; effect, draw, and compute instances own their binding state.

> Warning: Native macOS support is a docs-first API proposal. The Swift API on this page is not implemented yet.

## Understand generated program types

Each program conforms to one specialized protocol:

```swift
public protocol VGPUProgram {
  associatedtype Bindings: VGPUBindingSet
  static var artifact: VGPUProgramArtifact { get }
}

public protocol VGPUEffectProgram: VGPUProgram {}
public protocol VGPUDrawProgram: VGPUProgram {}
public protocol VGPUComputeProgram: VGPUProgram {}
```

Given this WGSL:

```wgsl
struct Params {
  time: f32,
  size: vec2f,
  accent: vec3f,
}

@group(0) @binding(0) var<uniform> params: Params;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(params.accent * (0.5 + 0.5 * sin(params.time + uv.x)), 1.0);
}
```

the package exposes the following simplified module interface. This is the public shape consumers see, not the generated implementation source:

```text
public enum Gradient: VGPUEffectProgram {
  public struct Params: Sendable {
    public var time: Float
    public var size: SIMD2<Float>
    public var accent: SIMD3<Float>

    public init(
      time: Float,
      size: SIMD2<Float>,
      accent: SIMD3<Float>
    )
  }

  public struct Bindings: VGPUBindingSet {
    public var params: VGPUUniformBinding<Params>

    public init(params: Params)
    public init(params: VGPUUniform<Params>)
  }

  public static let artifact: VGPUProgramArtifact
}
```

The public values are ordinary Swift scalars, SIMD vectors, matrices, arrays, and typed vgpu resources. Private generated code implements the initializers and packs values at the offsets reflected from WGSL; it never copies a Swift struct according to `MemoryLayout`.

Generated value-only types such as `Gradient.Params` conform to `Sendable`. Generated binding-set types and any wrapper that can hold a context-owned resource do not, regardless of the case stored by one particular value. Keep them in the same application-chosen isolation domain as their `VGPU` context.

Types referenced by more than one program are generated once at module scope. A `Particle` used by both `StepParticles` and `ParticleDraw` has one Swift identity, so the same `VGPUStorage<Particle>` can bind to both programs.

## Initialize every binding

Pass a complete generated `Bindings` value when you create a program instance:

```swift
let gradient = try gpu.effect(
  Gradient.self,
  bindings: .init(
    params: .init(
      time: 0,
      size: surface.size.float,
      accent: SIMD3<Float>(0.35, 0.55, 1.0)
    )
  )
)
```

A program with no bindings has an overload that omits `bindings`. Requiring complete initial bindings makes an unrenderable instance impossible to construct; native code does not defer a missing-binding error until its first draw.

There are no global uniforms and no reserved binding names. Time comes from `gpu.clock`, resolution comes from a surface or target, and both cross into WGSL only when you bind them.

## Update bindings

Replace one top-level WGSL binding with a typed key path:

```swift
try gradient.set(\.params, to: .init(
  time: gpu.clock.time,
  size: surface.size.float,
  accent: SIMD3<Float>(0.35, 0.55, 1.0)
))
```

For several fields in the same uniform block, mutate its retained host value and upload it once:

```swift
try gradient.update(\.params) { params in
  params.time = gpu.clock.time
  params.size = surface.size.float
}
```

Replace all bindings when that is clearer:

```swift
try gradient.set(.init(
  params: .init(
    time: 0,
    size: surface.size.float,
    accent: SIMD3<Float>(1, 0.4, 0.2)
  )
))
```

`set` and `update` change the instance's host state immediately. They validate and pack into a temporary value first, then commit the complete mutation atomically. If validation or packing fails, neither the host value nor its packed bytes change.

The context copies that packed state into a uniform slot for the current in-flight frame; it never overwrites memory still used by an earlier Metal command buffer. Every draw of one instance in the same frame refers to the same slot, so the last successful update before submission wins. A slot becomes reusable only after its command buffer completes.

Match updates to their real frequency: constants at creation, size values on resize, and time once per active frame.

The same rule as JavaScript applies inside a frame. GPU work is recorded before the command buffer executes, so two passes that need different values use two program instances:

```swift
let horizontal = try gpu.effect(Blur.self, bindings: horizontalBindings)
let vertical = try gpu.effect(Blur.self, bindings: verticalBindings)
```

Instances are cheap. Pipelines live in the `VGPU` context cache and are shared when the program, target signature, and render state match.

## Choose value or resource ownership

The initial binding fixes each buffer binding's ownership mode, matching JavaScript. Passing `Params` creates instance-owned uniform state; passing `VGPUUniform<Params>` shares a resource instead:

```swift
let sharedParams = try gpu.uniform(
  Gradient.Params(
    time: 0,
    size: surface.size.float,
    accent: SIMD3<Float>(0.35, 0.55, 1.0)
  )
)

let first = try gpu.effect(
  Gradient.self,
  bindings: .init(params: sharedParams)
)
let second = try gpu.effect(
  Gradient.self,
  bindings: .init(params: sharedParams)
)

try sharedParams.update { params in
  params.time = gpu.clock.time
}
```

An instance-owned binding cannot later switch to a shared resource, and a shared binding cannot switch to a plain value; `set` reports `VGPUError.bindingOwnership` at the attempted change. `update` is available only while the binding is value-owned. Update a shared `VGPUUniform` directly.

## Bind resources by WGSL name

Texture, sampler, uniform, and storage fields retain their authored names:

```wgsl
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
```

```swift
let present = try gpu.effect(
  Present.self,
  bindings: .init(
    source: scene,
    sourceSampler: linearSampler
  )
)
```

Generated code uses the Metal projection's translated slot mapping. It never assumes that WGSL `@binding(1)` means Metal texture, buffer, or sampler index `1`.

Bind a `VGPUTarget` directly when the resource must follow resize. The runtime observes its texture generation and rebuilds only the affected argument state. `target.color` returns the current concrete texture; code that binds that snapshot must call `set` again after `target.resize` replaces it.

## Next steps

- [Configure native programs](/native/macos/programs)
- [Inspect generated artifacts](/native/macos/artifacts)
- [Compose native rendering primitives](/native/macos/rendering)
- [Build and verify native artifacts](/native/macos/build)
