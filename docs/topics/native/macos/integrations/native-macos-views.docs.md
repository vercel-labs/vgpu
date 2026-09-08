---
title: Earlier proposal — SwiftUI and MetalKit
summary: Earlier proposal for generic SwiftUI and MetalKit adapters around the superseded Swift renderer.
websitePath: /native/macos/views
keywords: macos, swiftui, metalkit, mtkview, renderer, lifecycle, frame loop, reduce motion
relatedSymbols:
  - frameLoop
  - Surface
  - Frame
---

# Earlier proposal — SwiftUI and MetalKit

> Warning: This page preserves the earlier Swift view-adapter proposal, which the direct Metal
> workflow replaced. Its `VGPUView` and renderer protocols are not current commitments. Start with
> [Render WGSL with Metal](/native/macos/metal/rendering) and drive presentation in application code.

View integration belongs above the rendering primitives. A renderer creates effects, draws, and targets from one `VGPU` context; a generic host decides whether an `MTKViewDelegate` or SwiftUI drives it.

Generated programs never conform to a view protocol. The same renderer can combine any number of programs and run behind either host.

## Write one renderer

`VGPUViewRenderer` is the small boundary between a view loop and your rendering code:

```swift
@MainActor
public protocol VGPUViewRenderer: AnyObject {
  func encode(frame: VGPUFrame) throws
  func resize(to size: VGPUSize) throws
  func dispose()
}
```

Only `encode(frame:)` is required. `resize` and `dispose` have no-op defaults.

`@MainActor` is a contract of the view adapter, not of the core runtime. It keeps `MTKView`, SwiftUI state, renderer callbacks, and the non-`Sendable` GPU object graph owned by that renderer in one UI isolation domain. An offscreen renderer can instead own the same core types in its own actor.

This renderer owns an offscreen target and two program instances:

```swift
// HeroScene.swift
import AppShaders
import VGPUCore
import VGPUMetalKit
import VGPURender
import VGPUResources

@MainActor
final class HeroScene: VGPUViewRenderer {
  private let gpu: VGPU
  private let surface: VGPUSurface
  private let scene: VGPUTarget
  private let gradient: VGPUEffect<Gradient>
  private let present: VGPUEffect<Present>
  private var accent: SIMD3<Float>

  init(
    gpu: VGPU,
    surface: VGPUSurface,
    accent: SIMD3<Float>
  ) throws {
    let scene = try gpu.target(
      size: surface.size,
      format: .rgba16Float
    )
    let sampler = try gpu.sampler(
      minFilter: .linear,
      magFilter: .linear
    )

    self.gpu = gpu
    self.surface = surface
    self.scene = scene
    self.accent = accent
    self.gradient = try gpu.effect(
      Gradient.self,
      bindings: .init(
        params: .init(
          time: 0,
          size: surface.size.float,
          accent: accent
        )
      )
    )
    self.present = try gpu.effect(
      Present.self,
      bindings: .init(
        source: scene,
        sourceSampler: sampler
      )
    )
  }

  func encode(frame: VGPUFrame) throws {
    try gradient.update(\.params) { params in
      params.time = gpu.clock.time
    }

    try frame.pass(
      target: scene,
      color: .clear([0, 0, 0, 1])
    ) { pass in
      try pass.draw(gradient)
    }

    try frame.pass(
      target: surface,
      color: .clear([0, 0, 0, 1])
    ) { pass in
      try pass.draw(present)
    }
  }

  func resize(to size: VGPUSize) throws {
    try scene.resize(size)
    try gradient.update(\.params) { params in
      params.size = size.float
    }
  }

  func setAccent(_ value: SIMD3<Float>) throws -> Bool {
    guard value != accent else { return false }
    try gradient.update(\.params) { params in
      params.accent = value
    }
    accent = value
    return true
  }
}
```

The host opens the frame and calls `encode(frame:)`. `HeroScene` only encodes into the supplied frame; it never schedules or submits a second one.

View hosts pass the normalized `surface.size` to `resize(to:)`. Each dimension is at least `1`, even when the underlying platform view is temporarily zero-sized; drawable unavailability remains a non-fatal surface result.

## Render from SwiftUI

`VGPUView` creates and retains an `MTKView`, one `VGPU` context, its surface, the renderer returned by `makeRenderer`, and the frame loop while SwiftUI owns the platform view lifecycle:

```swift
// HeroView.swift
import Foundation
import SwiftUI
import VGPUSwiftUI

struct HeroView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VGPUView(
      preferredFramesPerSecond: 30,
      isPaused: reduceMotion,
      makeRenderer: { gpu, surface in
        try HeroScene(
          gpu: gpu,
          surface: surface,
          accent: SIMD3<Float>(0.35, 0.55, 1.0)
        )
      },
      fallback: { error in
        Text(error.localizedDescription)
          .font(.caption)
          .padding()
      }
    )
    .frame(minWidth: 480, minHeight: 320)
  }
}
```

`makeRenderer` runs once for the lifetime of the underlying platform view. Use an application model or a renderer update method for values that change after construction; do not recreate GPU resources from SwiftUI's `body`.

The default preferred frame rate is 60. `preferredFramesPerSecond` follows MetalKit's supported values for the active display.

### Pause without losing the image

When `isPaused` becomes true, the view stops its continuous loop but renders again for resize or an explicit invalidation. The active-time clock remains frozen; the first active frame after a pause has `deltaTime == 0`.

The host always requests one initial frame after setup, even when `isPaused` starts as `true`. Pause affects subsequent continuous frames, so Reduce Motion never leaves a newly created view blank.

This behavior redraws static content when needed instead of assuming that a drawable retains its previous pixels after occlusion or resize.

The SwiftUI host pauses continuous rendering while its window is inactive by default. Set `pausesWhenInactive: false` when background animation is intentional.

### Update renderer inputs

Use `updateRenderer` for ordinary SwiftUI values that should not recreate the renderer:

```swift
VGPUView(
  makeRenderer: { gpu, surface in
    try HeroScene(gpu: gpu, surface: surface, accent: accent)
  },
  updateRenderer: { renderer, context in
    if try renderer.setAccent(accent) {
      context.invalidate()
    }
  },
  fallback: { error in
    ErrorView(error: error)
  }
)
```

The closure runs on the main actor from SwiftUI's update phase. It may update retained values or binding state, but it must not encode or submit GPU work. The supplied `VGPUViewUpdateContext` is valid only for that update and exposes `invalidate()` for requesting one new frame when the view is paused.

## Drive an existing MTKView

When an application owns the view but wants vgpu to own its scheduling delegate, use the generic driver:

```swift
// HeroController.swift
import Foundation
import Metal
import MetalKit
import VGPUMetalKit

@MainActor
final class HeroController {
  private var driver: VGPUViewDriver<HeroScene>?

  init(view: MTKView, device: any MTLDevice) throws {
    view.device = device
    view.colorPixelFormat = .bgra8Unorm
    view.sampleCount = 1

    let driver = try VGPUViewDriver(
      view: view,
      device: device,
      preferredFramesPerSecond: 30,
      makeRenderer: { gpu, surface in
        try HeroScene(
          gpu: gpu,
          surface: surface,
          accent: SIMD3<Float>(0.35, 0.55, 1.0)
        )
      },
      onError: { error in
        print(error.localizedDescription)
      }
    )

    self.driver = driver
    do {
      try driver.start()
    } catch {
      driver.dispose()
      self.driver = nil
      throw error
    }
  }

  func stop() {
    driver?.dispose()
    driver = nil
  }
}
```

The initializer preflights the delegate, validates device, color format, sample count, and renderer setup without changing view-owned state. `start()` revalidates and then claims the delegate and loop properties. If it fails, it restores anything it claimed, leaves the driver disposable, and does not disturb another owner.

Use the driver's `commandQueue:` initializer instead of `device:` when this renderer must be ordered with existing Metal work. The queue's device must equal `view.device`. The driver retains the queue without reconfiguring it; the application still serializes host and vgpu enqueue order.

| `MTKView` property | Owner | Driver behavior |
| --- | --- | --- |
| `device` | Caller | Must equal the supplied device; never changed. |
| `colorPixelFormat` | Caller | Becomes the surface color format; never changed. |
| `sampleCount` | Caller | The first alpha requires `1`; later supported values become part of the surface signature. Never changed by the driver. |
| `delegate` | Driver while started | `start()` fails if another delegate is present. |
| `preferredFramesPerSecond`, `isPaused`, `enableSetNeedsDisplay` | Driver while started | Saved, configured, and restored on disposal if still owned. |
| `clearColor` | Caller | Used as the surface's default clear color. |
| `framebufferOnly` and `drawableSize` | Caller and MetalKit | Read when needed; never overwritten by the driver. |

`dispose()` clears the delegate only if the driver is still the current delegate. It never removes a replacement installed by the application.

## Own the delegate yourself

Use the primitives directly when another framework already controls scheduling. Create `VGPU`, `VGPUSurface`, and `HeroScene` once, then open a frame from the existing callback:

```swift
func draw(in view: MTKView) {
  do {
    try gpu.frame { frame in
      try renderer.encode(frame: frame)
    }
  } catch {
    handleRenderError(error)
  }
}

func mtkView(
  _ view: MTKView,
  drawableSizeWillChange size: CGSize
) {
  do {
    try renderer.resize(to: surface.size)
  } catch {
    handleRenderError(error)
  }
}
```

`VGPUSurface` never calls these methods itself. The application owns delegate installation, frame rate, pause policy, and error presentation in this mode.

## Handle setup and runtime errors

`VGPUView` catches failures from `makeRenderer`, `updateRenderer`, `resize`, `encode`, lazy pipeline creation, and Metal command-buffer completion. It stops scheduling, disposes the failed renderer and context, and replaces the platform view with the required `fallback`. One failure enters fallback once; the host does not retry automatically. Change the SwiftUI view identity after fixing the input, device, or generated package to construct a fresh renderer.

`VGPUViewDriver` throws setup and `start()` failures synchronously. A pipeline or command-buffer failure discovered after `start()` stops the loop and calls `onError` on the main actor. The driver subscribes to the context's asynchronous error channel, so these failures are not lost after `encode(frame:)` returns.

In manual-delegate mode, use `gpu.onError` for failures that arrive after `draw(in:)` returns. The handler preserves its actor isolation and must be `@Sendable`. [Ownership and lifecycle](/native/macos/lifecycle) defines error codes, delivery order, `settled()`, fail-fast access, and core disposal.

`VGPUViewRenderer.dispose()` and `VGPUViewDriver.dispose()` intentionally remain non-throwing host APIs. Both run on `@MainActor`, stop scheduling first, and then release their owned graph in order. Call them explicitly: a normal deinitializer cannot safely clear the delegate or restore `MTKView` properties on every supported Swift toolchain.

`VGPUView` owns its platform view, context, surface, renderer, and loop. `VGPUViewDriver` owns its context, surface, renderer, and loop but borrows its view, device, or command queue. A manually created `VGPUSurface` borrows its view and never owns a delegate. The handle itself has no global actor annotation; the MetalKit factory and all view access remain `@MainActor`.

## Next steps

- [Review programs and generated bindings](/native/macos/programs)
- [Compose rendering primitives directly](/native/macos/rendering)
- [Create resources and import Metal buffers or textures](/native/macos/resources)
- [Understand ownership, errors, and cleanup](/native/macos/lifecycle)
- [Verify artifacts and pixel parity](/native/macos/build)
