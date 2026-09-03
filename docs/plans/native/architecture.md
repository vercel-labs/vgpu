# Native runtime architecture

This document defines the runtime and package boundaries for the first Metal implementation. See
[API contract](./api-contract.md) for public behavior, [rollout](./rollout.md) for verification, and
[decisions](./decisions.md) for accepted and open choices.

## Generated programs are backend input

The generated program is not a prebuilt renderer:

```swift
let gradient = try gpu.effect(
  Gradient.self,
  bindings: .init(params: .init(time: 0, size: surface.size))
)

try gpu.frame { frame in
  try frame.pass(target: surface) { pass in
    try pass.draw(gradient)
  }
}
```

`Gradient` identifies functions and binding layouts. `VGPUEffect<Gradient>` owns mutable binding
values. The `VGPU` context owns device-level caches and creates a pipeline for the complete program,
vertex-layout, target, and render-state signature encountered at draw time.

The first implementation supports macOS and Metal only. Shared public contracts must still avoid
making Metal part of the generated-program ABI or the meaning of rendering primitives. This keeps
a future backend possible without designing speculative Vulkan queues, barriers, or swapchains.

## Platform support boundary

The first alpha supports native `arm64` execution on Apple silicon with macOS 14 or later. An
Intel-based Mac is outside the supported matrix whether Metal selects an Intel integrated GPU or
an AMD discrete GPU. Adding either device class requires recurring execution of the release gates
on physical hardware; a successful compile, simulator, Rosetta process, or one-off remote run is
not equivalent evidence.

That product boundary does not become a runtime tier. Shared APIs and artifacts do not expose a
CPU-architecture, GPU-vendor, or "Apple silicon" mode. The Metal backend selects an `MTLDevice`,
derives effective capabilities from that device, and validates actual resource and pipeline
creation. Resource ownership, synchronization, uploads, and readbacks must not assume unified or
automatically coherent CPU/GPU memory. Host-shareable layouts use reflected, fixed-width contracts
rather than pointer width or Swift's natural layout.

CI may cross-build the runtime, generated package, and clean sample for `x86_64` as an informative
portability check. That proves only that the Swift source and link graph can be produced for the
CPU architecture; it does not load the `.metallib`, create a pipeline, exercise a driver, or make
Intel-based Macs supported. The Metal projection's `metalCompilerTargetTriple` is the exact
AIR/platform/deployment triple passed to Apple's Metal compiler. It is distinct from Swift target
triples such as `arm64-apple-macosx...` or `x86_64-apple-macosx...` and does not identify the build
host CPU or a supported GPU family.

## Product graph

The runtime ships as one Swift package with independent library products and no umbrella module:

```text
AppShaders       -> VGPUABI
_VGPUBackendSPI  -> VGPUABI
VGPUCore         -> VGPUABI + _VGPUBackendSPI
VGPUResources    -> VGPUCore + VGPUABI
VGPURender       -> VGPUCore + VGPUResources + VGPUABI
VGPUCompute      -> VGPUCore + VGPUResources + VGPUABI
VGPUMetal        -> VGPUCore + _VGPUBackendSPI
VGPUMetalInterop -> VGPUMetal + VGPUResources
VGPUMetalKit     -> VGPUMetal + VGPURender
VGPUSwiftUI      -> VGPUMetalKit
VGPUScene        -> VGPURender
VGPUQueries      -> VGPURender + VGPUResources
VGPUTesting      -> only the features exercised by its test runner
```

`_VGPUBackendSPI` is package-only, and `VGPUTesting` is never an application dependency.

`VGPUABI` contains only generated-program descriptors, binding wrappers, semantic layouts, and
artifact references. It does not import Metal, MetalKit, SwiftUI, Render, or Compute. A generated
module can therefore describe effects, draws, and compute programs without linking an executor.

`VGPUCore` owns context identity, ordered submission, the clock, errors, capabilities, and
lifecycle. `VGPUResources`, `VGPURender`, and `VGPUCompute` add their `gpu.*` factories through
extensions in their own modules. `VGPUMetal` implements the package-private backend SPI.

The SPI is one internal target but four protocol families from the start: core, resources, render,
and compute. A single Metal driver may implement all four initially. Keeping the conformances
separate lets the implementation move into capability-specific targets if the C0 link-map fixture
shows that protocol witness tables retain code an application did not select.

The placement rule is strict: context identity, device access, queue ordering, cache use, or
resource ownership justifies a `gpu.*` receiver. CPU-only math, geometry recipes, color helpers,
scheduling, UI, loaders, build tooling, and testing stay outside `VGPU` and in opt-in modules.
Methods that operate on a created value stay on that value.

There is no implicit backend constructor. Importing `VGPUMetal` makes `VGPU.metal()`,
`VGPU.metal(device:)`, and `VGPU.metal(commandQueue:)` available. The default and device overloads
create a private command queue. The queue overload retains an application-owned queue, derives its
device, and lets existing Metal work and vgpu work share explicit enqueue order without exposing
that queue through the backend-neutral API.

## Negative import matrix

Declared products are insufficient if implementation imports recreate a monolith. CI rejects the
following dependencies even when their measured size is small:

| Module | Must not import |
| --- | --- |
| `VGPUABI` | `VGPUCore`, `VGPUResources`, `VGPURender`, `VGPUCompute`, Metal, MetalKit, SwiftUI |
| `VGPUCore` | `VGPUResources`, `VGPURender`, `VGPUCompute`, any backend, UI, Scene, Queries, Testing |
| `VGPUResources` | `VGPURender`, `VGPUCompute`, Metal, MetalKit, SwiftUI, Scene, Queries, Testing |
| `VGPURender` | `VGPUCompute`, Metal, MetalKit, SwiftUI, Scene, Queries, Testing |
| `VGPUCompute` | `VGPURender`, Metal, MetalKit, SwiftUI, Scene, Queries, Testing |
| `VGPUMetal` | `VGPUResources`, `VGPURender`, `VGPUCompute`, `VGPUMetalInterop`, MetalKit, SwiftUI, Scene, Queries, Testing |
| `VGPUMetalInterop` | `VGPURender`, `VGPUCompute`, MetalKit, SwiftUI, Scene, Queries, Testing |
| `VGPUMetalKit` | SwiftUI, Scene, Queries, Testing |
| `VGPUSwiftUI` | Scene, Queries, Testing |

Products are imported explicitly. The package does not use `@_exported import` to make transitive
modules appear to be part of another module's API.

## Native Metal interop

Metal resource import and inspection is an opt-in leaf rather than another responsibility of the
backend constructor. `VGPUMetalInterop` accepts `MTLBuffer` and `MTLTexture` values and returns the
backend-neutral `VGPUBuffer` and `VGPUTexture` wrappers consumed by Resources, Render, and Compute.
Consequently, shared render and compute modules never mention an `MTL*` type.

The package-private global identity registry for imported `MTLResource` objects belongs to
`VGPUMetal`, not `VGPUMetalInterop`. This gives every current or future Metal-specific leaf one
registry without making the Metal core depend on public resource modules. The registry is
internally synchronized because contexts can live in different actor domains. It permits one live
wrapper for one exact native object, retains that object while claimed, and counts encoded and
in-flight uses. Closing a wrapper stops new work immediately; the claim remains until every use
completes. A handoff closes the old wrapper, awaits that context's settled snapshot, and only then
imports into the next context. Heap aliases, texture views, and commands submitted outside vgpu
remain the application's synchronization responsibility.

## Surface boundary

`VGPUSurface` is a backend-neutral, non-`Sendable` semantic handle defined by `VGPURender`. It has
no `MTKView`, drawable, layer, or other platform type in its public shape. The selected host adapter
constructs it with an opaque backend payload.

`VGPUMetalKit` provides the `@MainActor` factory `gpu.surface(_ view: MTKView)`, drawable
acquisition and presentation, `VGPUViewDriver`, and its registry of borrowed views. That registry
is keyed by `MTKView` identity and remains in `VGPUMetalKit`; all of its access is main-actor
isolated. The neutral surface handle itself has no global actor annotation and remains in the same
owner isolation domain as its non-`Sendable` context graph.

There is no public `VGPUMetalSurface` or speculative `VGPUWindowSurface` in the first API. A future
host adapter can construct the same `VGPUSurface` contract without changing renderers or exposing
its native presentation object through the shared module.

## Backend-neutral command meaning

The shared API uses vgpu texture formats, resource usages, target signatures, and capabilities
rather than `MTLPixelFormat`, `MTLTexture`, or `MTLBuffer`.

One `VGPUFrame` represents one ordered logical submission. Metal v1 implements that submission
with one command buffer, but the public contract does not require every future backend to use
exactly one native command-buffer object. Returning normally submits once; throwing while the
frame remains open cancels it and rethrows the original error. An explicit earlier submission
cannot be rolled back.

Resource usage, binding access, render-pass boundaries, and submission order remain explicit enough
for another backend to implement its own transitions. Backend-internal transitions are not public
API and are not compared across platforms.

## Code-size boundaries

Modularity is a tested contract. Release fixtures cover ABI-only, context-only, effect-only,
low-level draw, one scene recipe, compute-only, view integration, and the full runtime. CI checks
declared target dependencies, negative imports, public symbol graphs, final link maps, linked
frameworks, stripped Mach-O payloads, and packaged resources. A forbidden feature is a failure even
when its measured size is negligible.

A configuration emits one generated Swift module and one `.metallib`. The generated package is
therefore also the shader-payload boundary: selecting only `VGPURender` avoids the compute executor,
but it does not remove compute functions already placed in that generated `.metallib`. Programs
distributed as independent optional features belong in separate configurations and generated
packages.

The [C0 gate](./rollout.md#shipping-gates) decides whether the initially unified Metal driver can
remain one implementation target. Public API products are not split further based on assumptions
about Swift's linker.
