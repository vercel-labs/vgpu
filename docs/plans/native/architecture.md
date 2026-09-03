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

`VGPURender` owns logical vertex layouts, their canonical fingerprints, and logical stream
cardinality without exposing physical buffer indices. `_VGPUMetalRenderImpl` combines that state
with the artifact-fixed shader slots and `vertexBufferPolicy` to derive a pipeline-local Metal
stream map. A pipeline switch that changes the map invalidates the implementation's physical
vertex-buffer cache and rebinds every active logical stream. This keeps backend slot policy out of
the shared rendering API.

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

## Module and product graph

The runtime ships as one Swift package with independent modules and no umbrella module. Backend-
neutral modules remain available as individual products for libraries that do not select a
platform backend:

```text
AppShaders       -> VGPUABI
_VGPUBackendSPI  -> VGPUABI
VGPUCore         -> VGPUABI + _VGPUBackendSPI
VGPUResources    -> VGPUCore + VGPUABI
VGPURender       -> VGPUCore + VGPUResources + VGPUABI
VGPUCompute      -> VGPUCore + VGPUResources + VGPUABI
VGPUScene        -> VGPURender
VGPUQueries      -> VGPURender + VGPUResources
VGPUTesting      -> only the features exercised by its test runner
```

The Metal implementation is physically split at the capability boundary proven by C0:

```text
VGPUMetal                  -> VGPUCore + _VGPUBackendSPI
_VGPUMetalResourcesImpl    -> VGPUMetal + VGPUResources + _VGPUBackendSPI
_VGPUMetalRenderImpl       -> _VGPUMetalResourcesImpl + VGPURender + _VGPUBackendSPI
_VGPUMetalComputeImpl      -> _VGPUMetalResourcesImpl + VGPUCompute + _VGPUBackendSPI
VGPUMetalInterop           -> VGPUMetal + VGPUResources
VGPUMetalKit               -> VGPUMetal + VGPURender
VGPUSwiftUI                -> VGPUMetalKit
```

`_VGPUBackendSPI` and the three `*Impl` targets are package-only. `VGPUTesting` is never an
application dependency.

`VGPUABI` contains only generated-program descriptors, binding wrappers, semantic layouts, and
artifact references. It does not import Metal, MetalKit, SwiftUI, Render, or Compute. A generated
module can therefore describe effects, draws, and compute programs without linking an executor.

`VGPUCore` owns context identity, ordered submission, the clock, errors, capabilities, and
lifecycle. `VGPUResources`, `VGPURender`, and `VGPUCompute` add their `gpu.*` factories through
extensions in their own modules. `VGPUMetal` owns the concrete backend, core conformance, and
explicit constructors. Package-scoped extensions in the three capability implementation targets
add the resource, render, and compute conformances to that same backend type.

C0 showed that separate conformances in separate files of one Metal target still retain all four
protocol witness graphs under Release WMO, `-Osize`, dead stripping, and full LTO. Physical targets
retain exactly the selected graph, so source-file separation is not an implementation option.

Applications select backend-complete, additive SwiftPM products:

| Product selected by the application | Importable public modules                               | Metal capabilities linked  |
| ----------------------------------- | ------------------------------------------------------- | -------------------------- |
| `VGPUMetal`                         | `VGPUCore`, `VGPUMetal`                                 | Core                       |
| `VGPUMetalResources`                | `VGPUCore`, `VGPUResources`, `VGPUMetal`                | Core + Resources           |
| `VGPUMetalRender`                   | `VGPUCore`, `VGPUResources`, `VGPURender`, `VGPUMetal`  | Core + Resources + Render  |
| `VGPUMetalCompute`                  | `VGPUCore`, `VGPUResources`, `VGPUCompute`, `VGPUMetal` | Core + Resources + Compute |
| `VGPUMetalInterop`                  | Resource stack + `VGPUMetalInterop`                     | Core + Resources           |
| `VGPUMetalKit`                      | Render stack + `VGPUMetalKit`                           | Core + Resources + Render  |
| `VGPUSwiftUI`                       | MetalKit stack + `VGPUSwiftUI`                          | Core + Resources + Render  |

These are multi-target selection products, not umbrella modules. Swift source still imports every
module it names. Selecting both `VGPUMetalRender` and `VGPUMetalCompute` forms the union and links
Core and Resources once; there is no combinatorial Render-and-Compute product. A future backend can
mirror the same shape with products such as `VGPUVulkanRender` without changing neutral modules.

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

| Module                    | Must not import                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `VGPUABI`                 | `VGPUCore`, `VGPUResources`, `VGPURender`, `VGPUCompute`, Metal, MetalKit, SwiftUI                           |
| `VGPUCore`                | `VGPUResources`, `VGPURender`, `VGPUCompute`, any backend, UI, Scene, Queries, Testing                       |
| `VGPUResources`           | `VGPURender`, `VGPUCompute`, Metal, MetalKit, SwiftUI, Scene, Queries, Testing                               |
| `VGPURender`              | `VGPUCompute`, Metal, MetalKit, SwiftUI, Scene, Queries, Testing                                             |
| `VGPUCompute`             | `VGPURender`, Metal, MetalKit, SwiftUI, Scene, Queries, Testing                                              |
| `VGPUMetal`               | `VGPUResources`, `VGPURender`, `VGPUCompute`, `VGPUMetalInterop`, MetalKit, SwiftUI, Scene, Queries, Testing |
| `_VGPUMetalResourcesImpl` | `VGPURender`, `VGPUCompute`, `VGPUMetalInterop`, MetalKit, SwiftUI, Scene, Queries, Testing                  |
| `_VGPUMetalRenderImpl`    | `VGPUCompute`, `VGPUMetalInterop`, MetalKit, SwiftUI, Scene, Queries, Testing                                |
| `_VGPUMetalComputeImpl`   | `VGPURender`, `VGPUMetalInterop`, MetalKit, SwiftUI, Scene, Queries, Testing                                 |
| `VGPUMetalInterop`        | `VGPURender`, `VGPUCompute`, MetalKit, SwiftUI, Scene, Queries, Testing                                      |
| `VGPUMetalKit`            | SwiftUI, Scene, Queries, Testing                                                                             |
| `VGPUSwiftUI`             | Scene, Queries, Testing                                                                                      |

Modules are imported explicitly. Selecting a multi-target product makes its public modules
available to the application target, but does not import them in source. The package does not use
`@_exported import` to make transitive modules appear to be part of another module's API.

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

The C0 fixture in `experiments/native-metal-spikes/c0-linking` demonstrates why the Metal driver is
split into capability implementation targets and verifies the exact payload retained by Context,
Render, and Compute consumers. Keep that fixture as a regression gate for compiler and package-
graph changes; public modules must not be split further merely because implementation targets are.
