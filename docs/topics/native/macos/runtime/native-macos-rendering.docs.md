---
title: Rendering primitives
summary: Create a VGPU context and compose effects and draws through ordered frames and render passes.
websitePath: /native/macos/rendering
keywords: macos, metal, swift, vgpu, effect, draw, compute, frame, pass, submission, target, geometry, command queue
relatedSymbols:
  - Gpu
  - Surface
  - Target
  - Effect
  - Draw
  - Compute
  - Frame
  - FramePass
  - Submission
---

# Rendering primitives

Everything starts from one `VGPU` context. Surfaces, targets, program instances, resources, and frames created from it share one Metal device, command queue, clock, and pipeline cache.

Create long-lived resources outside rendering code. A frame should update data and encode commands, not rebuild pipelines, textures, or geometry.

> Warning: Native macOS support is a docs-first API proposal. The Swift APIs on this page are not implemented yet.

## Create a context

Use an existing Metal device when the application already selected one:

```swift
import Metal
import VGPUCore
import VGPUMetal

guard let device = MTLCreateSystemDefaultDevice() else {
  throw VGPUError.metalUnavailable
}

let gpu = try VGPU.metal(device: device)
```

`VGPU.metal()` chooses the system default Metal device. `VGPU.metal(device:)` retains the supplied device and creates a private command queue for the context. Neither overload destroys or reconfigures an application-supplied device.

The first alpha is tested and supported on Apple silicon with macOS 14 or later. These constructors do not expose an Apple-silicon mode or branch on CPU architecture or GPU vendor. They validate the actual `MTLDevice`; a device outside the tested matrix may satisfy those checks, but that does not make it a supported target without physical-hardware coverage.

Adopt an existing command queue when vgpu must be ordered with a Metal renderer that already owns submission:

```swift
guard let commandQueue = device.makeCommandQueue() else {
  throw VGPUError.metalUnavailable
}

let gpu = try VGPU.metal(commandQueue: commandQueue)
```

This overload retains the queue and derives its device from `commandQueue.device`; it never destroys or reconfigures either object. Command buffers are ordered by when they are enqueued, not when they are created. Serialize host and vgpu submission through the same application owner: commit host work before calling vgpu to place it first, and enqueue later host work after the vgpu call to place it last. A vgpu submission on that serial queue cannot complete before commands enqueued ahead of it, including host commands. Its token does not adopt the host commands' readbacks or error delivery, and `gpu.settled()` only observes work registered by vgpu.

Selecting the backend explicitly keeps `VGPU` independent of Metal-specific initialization. Read [Resources and Metal interop](/native/macos/resources) before sharing native resources, and [Ownership and lifecycle](/native/macos/lifecycle) before choosing the actor that owns the context.

`gpu.capabilities` is an immutable snapshot of the actual `MTLDevice` features and limits. Program construction validates required shader features, while target creation and `compile(for:)` validate formats, sample counts, resource limits, and render-state combinations before encoding. A missing required capability fails with `VGPUError.deviceUnsupported` instead of surfacing later as an opaque pipeline error.

## Create a surface and targets

A surface borrows an application-owned `MTKView`. The MetalKit factory is `@MainActor` because it reads the view, but the backend-neutral `VGPUSurface` handle has no global actor annotation:

```text
public extension VGPU {
  @MainActor
  func surface(_ view: MTKView) throws -> VGPUSurface
}
```

Create the surface from the same main-actor owner that manages the view:

```swift
import MetalKit
import VGPUMetalKit

view.device = device
view.colorPixelFormat = .bgra8Unorm
view.sampleCount = 1

let surface = try gpu.surface(view)
```

The surface reads the view's current drawable size, color format, and sample count. It does not install an `MTKViewDelegate`, change the view, or own its lifecycle. Keep a view-backed surface and its context in that main-actor object graph. Only one live vgpu surface may borrow a view at a time. The first render alpha requires `sampleCount == 1`; later releases accept only sample counts reported by both the runtime and device.

A pass reports whether it encoded work:

```swift
public enum VGPUFramePassResult: Sendable {
  case encoded
  case unavailable
}
```

`frame.pass` is `@discardableResult`. An offscreen pass returns `.encoded`. A drawable can be temporarily unavailable while a window is hidden, minimized, resizing, or zero-sized. In that case a surface pass returns `.unavailable` without running its closure. This is a normal result, not a runtime error: offscreen passes in the frame remain encoded, and the view loop may try the surface again later. A normally returning frame still commits one ordered submission and returns its token even if every surface pass was unavailable or the frame encoded no passes.

`surface.size` floors the drawable size and clamps each dimension to at least `1`, so it is always valid for an offscreen texture even when the platform view is temporarily zero-sized. A frame attempts acquisition once per surface, caches either the drawable or its unavailability, reuses an acquired drawable across that frame's surface passes, and presents it exactly once on submit. A cancelled frame never presents. If code explicitly submits before throwing, that submitted work cannot be rolled back and may present.

Create offscreen targets from the same context:

```swift
let scene = try gpu.target(
  size: surface.size,
  format: .rgba16Float,
  depth: .depth32Float,
  sampleCount: 1,
  clearColor: [0.02, 0.02, 0.04, 1]
)
```

`VGPUTarget` owns its attachments. Bind the target itself to sample its first color attachment and keep that binding current across resize:

```swift
let linear = try gpu.sampler(
  minFilter: .linear,
  magFilter: .linear
)

let present = try gpu.effect(
  Present.self,
  bindings: .init(
    source: scene,
    sourceSampler: linear
  )
)
```

Resize a target when the drawable changes:

```swift
try scene.resize(surface.size)
```

The `VGPUTarget` keeps stable identity and publishes a new texture generation when resize replaces its attachments. Bindings that received the target follow that generation automatically. `scene.color` is the current concrete texture, so a binding that received that snapshot must be set again after resize.

Readback and texture-generation ownership are covered in [Resources and Metal interop](/native/macos/resources).

## Create effects

An effect is a full-screen fragment program. Create as many instances as you need from one generated descriptor:

```swift
let horizontal = try gpu.effect(
  Blur.self,
  bindings: .init(
    source: scene,
    sourceSampler: linear,
    params: .init(direction: SIMD2<Float>(1, 0))
  )
)

let vertical = try gpu.effect(
  Blur.self,
  bindings: .init(
    source: temporary,
    sourceSampler: linear,
    params: .init(direction: SIMD2<Float>(0, 1))
  )
)
```

Each instance owns its bindings and render options. Pipelines remain device-level cached objects, so creating two instances does not compile the same pipeline twice.

For one shader and one offscreen target, draw directly:

```swift
let submission = try gradient.draw(to: scene)
```

The one-shot form creates and commits its own command buffer and render pass, then returns a `VGPUSubmission` for that work. Returning a token from one-shot effect, draw, and dispatch calls is an intentional Swift extension; the corresponding TypeScript calls return `void`. It does not advance `gpu.clock`. It rejects a `VGPUSurface`, because drawable acquisition and presentation must stay inside `gpu.frame`. Use explicit frames for a surface, multiple passes, or multiple draws into one target.

## Compose passes in one frame

A frame is one ordered logical submission. Metal v1 encodes it into one command buffer; each render pass targets one surface or offscreen target and contains any number of effects and draws:

```swift
let submission = try gpu.frame { frame in
  try frame.pass(
    target: scene,
    color: .clear([0.02, 0.02, 0.04, 1])
  ) { pass in
    try pass.draw(background)
    try pass.draw(particles)
  }

  try frame.pass(
    target: temporary,
    color: .clear([0, 0, 0, 0])
  ) { pass in
    try pass.draw(horizontal)
  }

  try frame.pass(
    target: scene,
    color: .clear([0, 0, 0, 0])
  ) { pass in
    try pass.draw(vertical)
  }

  try frame.pass(
    target: surface,
    color: .clear([0, 0, 0, 1])
  ) { pass in
    try pass.draw(present)
  }
}
```

Pass order is execution order, and draw order inside a pass is paint order. A normally returning callback commits the frame once and returns its `VGPUSubmission`, including for an empty frame. The return value is discardable, so a render loop can submit without creating a token variable.

The scoped frame contract is:

```text
public extension VGPU {
  @discardableResult
  func frame(
    _ body: (VGPUFrame) throws -> Void
  ) throws -> VGPUSubmission
}

public extension VGPUFrame {
  @discardableResult
  func submit() throws -> VGPUSubmission
}
```

`frame.submit()` is idempotent while the callback remains in scope. Repeated calls do not enqueue more work and return tokens for the same stable logical submission. If the callback explicitly submits and then returns normally, the outer `gpu.frame` call returns that same token.

If the callback throws before submission, vgpu cancels the frame and rethrows the original error. The outer call cannot return a token because no submission exists. Code that intentionally wants to preserve partial work can call `frame.submit()` in its own `catch` before rethrowing; an explicit submission cannot be rolled back. In that case the outer call still throws, so the token remains available only if the callback saved the result of `frame.submit()` before throwing.

Frames and passes are runtime-scoped values. A captured `VGPUFrame` becomes invalid when the `gpu.frame` callback returns; a captured `VGPUFramePass` becomes invalid as soon as its pass callback returns. Later use throws `VGPUError.frameClosed` or `VGPUError.passClosed` before touching Metal.

Only one frame and one pass may be open synchronously on a context. Opening another frame throws `VGPUError.frameReentrant`; opening a pass from inside another pass throws `VGPUError.nestedPass`; calling `frame.submit()` while a pass is active throws `VGPUError.framePassActive`. A pass-body error cannot remove Metal commands that were already encoded. Let that error escape the outer `gpu.frame` callback when the whole frame should be cancelled.

One-shot effect and draw `draw(to:)` calls also return a discardable `VGPUSubmission`; they never join a surrounding frame. Calling one while `gpu.frame` is active throws `VGPUError.nestedSubmission`; encode through `frame.pass` and `pass.draw` instead. A concurrent call from another isolation domain fails earlier with `VGPUError.concurrentAccess`. Read [Ownership and lifecycle](/native/macos/lifecycle) for the complete completion, error, and access rules.

### Preserve existing attachments

Pass color state uses an enum instead of JavaScript's `boolean | ClearColor` union:

```swift
try frame.pass(
  target: scene,
  color: .preserve
) { pass in
  try pass.draw(overlay)
}
```

The load policy stays aligned across the attachments, matching JavaScript:

| Color option                | Color                          | Depth                                     | Stencil                                     |
| --------------------------- | ------------------------------ | ----------------------------------------- | ------------------------------------------- |
| Omitted or `.targetDefault` | Clear with `target.clearColor` | Clear to `1`                              | Clear to `0`                                |
| `.clear(color)`             | Clear with `color`             | Clear to `1`, or the explicit depth value | Clear to `0`, or the explicit stencil value |
| `.preserve`                 | Preserve                       | Preserve                                  | Preserve                                    |

`.preserve` cannot be combined with an explicit depth or stencil clear. A read-only depth/stencil aspect cannot be cleared, and every draw in that pass must disable writes to the corresponding aspect. The runtime preserves the existing values for testing without exposing backend load/store actions as public API.

When multisampling becomes available, `.preserve` remains invalid for an MSAA target because its multisampled attachments are transient; only the resolved color texture survives the pass.

Pass options also carry viewport, scissor, read-only depth, timer, and visibility state when the installed runtime reports those capabilities.

## Draw geometry

A draw combines generated vertex and fragment functions with geometry and render state. Add the optional `VGPUScene` product from the vGPU Swift package to use the same pure geometry recipes as `vgpu/scene`:

```swift
import AppShaders
import simd
import VGPURender
import VGPUScene

let geometry = try gpu.geometry(.box(size: 1))

let cube = try gpu.draw(
  LitCube.self,
  geometry: geometry,
  bindings: .init(
    camera: .init(viewProjection: camera.viewProjection),
    model: .init(model: matrix_identity_float4x4)
  ),
  cull: .back,
  depth: .init(write: true, compare: .greater)
)
```

Render it into a target with depth:

```swift
try cube.update(\.model) { model in
  model.model = orbit(gpu.clock.time)
}

try gpu.frame { frame in
  try frame.pass(
    target: scene,
    color: .targetDefault,
    depth: .clear(0)
  ) { pass in
    try pass.draw(cube)
  }

  try frame.pass(target: surface) { pass in
    try pass.draw(present)
  }
}
```

Clearing depth to `0` matches the draw's reversed-Z `greater` comparison. Use the default clear of `1` with the default `.lessEqual` comparison.

The same draw may render into a different target signature. `LitCube` contains shader functions and binding layouts, not a color format. `VGPU` creates or reuses the correct pipeline for the program and entry points, vertex layouts and topology, target formats and sample count, per-attachment color state, primitive state, depth/stencil state, multisample state, and fixed overrides.

### Supply custom vertex data

Use generated vertex types for the interleaved common case:

```swift
let geometry = try gpu.geometry(
  vertices: vertices as [LitCube.Vertex],
  indices: indices,
  topology: .triangleList
)
```

The raw overload accepts backend-neutral `VGPUBuffer` values plus explicit vertex layouts. Import an existing `MTLBuffer` through the opt-in `VGPUMetalInterop` product first; `VGPURender` itself never exposes Metal types. Buffer ownership, usage validation, and handoff are covered in [Resources and Metal interop](/native/macos/resources).

Geometry exposes logical vertex streams, not Metal buffer indices. The backend assigns their physical indices when it creates the complete draw pipeline, immediately after that program's highest occupied vertex-stage shader-buffer interval. It rejects a layout that would cross the artifact's exclusive external-buffer ceiling. Because two pipelines may map the same logical stream to different physical indices, changing to a pipeline with a different stream mapping makes the encoder rebind every active vertex stream before the next draw.

Leave geometry out for procedural vertices. Counts remain instance state and may be overridden per call:

```swift
let smoke = try gpu.draw(
  Smoke.self,
  vertices: 3,
  instances: 10_000,
  bindings: smokeBindings,
  blend: .additive
)

try pass.draw(smoke, instances: 500)
```

## Dispatch compute work

A compute instance owns generated bindings just like an effect or draw:

```swift
import VGPUCompute

let update = try gpu.compute(
  StepParticles.self,
  bindings: .init(
    particles: particles,
    params: .init(deltaTime: 0)
  )
)

try update.update(\.params) { params in
  params.deltaTime = gpu.clock.deltaTime
}

let submission = try update.dispatch(
  x: (particles.count + 63) / 64
)
```

The first native compute API preserves the current JavaScript ordering boundary: `gpu.compute` creates and validates its compute pipeline synchronously, and `dispatch` creates and commits its own command buffer. It returns a discardable `VGPUSubmission`, just like a one-shot render. There is no separate compute `compile()` call. A render frame submitted afterward observes those writes through queue order.

```swift
try update.dispatch(x: groupCount)

try gpu.frame { frame in
  try frame.pass(target: surface) { pass in
    try pass.draw(particleDraw)
  }
}
```

Calling the one-shot `dispatch` from inside `gpu.frame` throws `VGPUError.nestedSubmission`; it cannot join that command buffer. A future `frame.compute` should land in both JavaScript and Swift with one shared ordering contract instead of becoming a native-only behavior.

Every successful frame, one-shot effect, one-shot draw, and dispatch returns a token for exactly that logical submission. Await `submission.settled()` only at an explicit synchronization boundary, such as a test or resource handoff. Awaiting every token inside an animation loop serializes CPU encoding with GPU execution and defeats normal in-flight rendering. See [Ownership and lifecycle](/native/macos/lifecycle#wait-for-submitted-work) for the scoped and context-wide wait contracts.

## Pre-warm render pipelines

Metal libraries are compiled ahead of time, but render pipeline state is still specialized at runtime. Like every async API on a live context object, `compile` inherits the caller's actor:

```text
public extension VGPUEffect {
  func compile(
    for signature: VGPURenderTargetSignature,
    isolation: isolated (any Actor)? = #isolation
  ) async throws
}

public extension VGPUDraw {
  func compile(
    for signature: VGPURenderTargetSignature,
    isolation: isolated (any Actor)? = #isolation
  ) async throws
}
```

Move compilation out of the first visible frame. Await each actor-owned instance in order; starting child tasks with stored non-`Sendable` instances would move those values out of the owner's isolation domain:

```swift
@MainActor
func preparePipelines() async throws {
  try await gradient.compile(for: scene)
  try await cube.compile(for: scene)
  try await present.compile(for: surface.signature)
}
```

The cache belongs to `VGPU`, so equivalent instances share the result. Resizing a target without changing its format, depth format, or sample count does not create a new pipeline. A future bulk API may register several requests synchronously and return `Sendable` compilation handles without sharing the live instances.

## Next steps

- [Create resources and import Metal buffers or textures](/native/macos/resources)
- [Understand ownership, errors, and cleanup](/native/macos/lifecycle)
- [Configure generated programs and bindings](/native/macos/programs)
- [Integrate the renderer with SwiftUI or MetalKit](/native/macos/views)
- [Verify the compiler, artifact, and pixels](/native/macos/build)
