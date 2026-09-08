---
title: "macOS"
description: "Track the move from a Swift runtime proposal to WGSL compilation and generated integration with application-owned Metal code."
---

> Warning: This guide documents the earlier full Swift-runtime proposal. The current direction is
> WGSL compilation and generated Metal integration, with pipelines, resources, command buffers,
> and presentation owned by the application. The `gpu.*` and view APIs below are not commitments
> for that release. See [Native](/native) for the scope notice; the replacement quickstart will
> follow validation of the generated API.

The new [Metal function-loading guide](/native/macos/metal/functions) defines the first generated
API for application-owned Metal code. The remainder of this page is the earlier runtime draft.

`vgpu native build` turns WGSL programs into a `.metallib` and generated Swift types. Your application creates effects, draws, targets, and frames with small Swift products implemented directly on Metal.

Node.js, the WGSL translator, generated MSL, and vgpu's TypeScript runtime stay on the build machine. The application ships the compiled library, typed program descriptors, and only the Swift runtime products it selects. One generated configuration is also one shader-payload boundary: every program in its `.metallib` ships together even when the application omits an executor module.

> Warning: Native macOS support is a docs-first API proposal. The commands, `@vgpu/native` package, Swift runtime products, and generated Swift types below are not implemented yet.

## Start with the same primitives

The generated `Gradient` and `Present` types in this guide are shader programs. They do not own a view, renderer, or frame loop. One `VGPU` context instantiates them and composes their work:

```swift
let gpu = try VGPU.metal(device: device)
let surface = try gpu.surface(view)
let scene = try gpu.target(size: surface.size, format: .rgba16Float)

let gradient = try gpu.effect(Gradient.self, bindings: gradientBindings)
let present = try gpu.effect(Present.self, bindings: presentBindings)

try gpu.frame { frame in
  try frame.pass(target: scene) { pass in
    try pass.draw(gradient)
  }
  try frame.pass(target: surface) { pass in
    try pass.draw(present)
  }
}
```

That separation is what lets one context share a device, queue, pipeline cache, and command buffer across any number of generated programs.

## Prerequisites

- Apple silicon and macOS 14 or later as the supported application target.
- An Apple silicon build machine with Xcode and the downloadable Metal toolchain.
- Node.js 22 on machines that build or verify native artifacts.

The built application does not require Node.js or Xcode.

The first alpha's tested compatibility matrix does not include Intel-based Macs or Intel and AMD GPUs. This is a release-support boundary, not an architecture mode in WGSL or the runtime: device validation still uses the capabilities of the actual Metal device, and the runtime does not reject a device only because of its CPU architecture or GPU vendor. Support outside this matrix requires validation on the corresponding physical hardware.

## Install the native toolchain

Install vgpu and the native compiler as development dependencies:

```sh
npm install --save-dev vgpu @vgpu/native
npx vgpu native doctor --target macos
```

The `vgpu` package provides the command dispatcher. `@vgpu/native` provides the native compiler, configuration schema, and Swift package generator.

`doctor` compiles and links a minimal Metal shader. Checking for Xcode or locating `xcrun` is not enough: Xcode can be installed while its Metal toolchain component is still missing. A failed check exits non-zero and includes the command needed to repair the local toolchain when one is available.

## Create a native shader module

Run:

```sh
npx vgpu native init --target macos
```

`init` creates a configuration file and a `Shaders` directory:

```text
Shaders/
  Gradient.wgsl
  Present.wgsl
vgpu.native.json
```

Configure both programs in one generated Swift module:

```json
{
  "$schema": "./node_modules/@vgpu/native/native.schema.json",
  "moduleName": "AppShaders",
  "platform": "macos",
  "minimumOSVersion": "14.0",
  "programs": [
    {
      "name": "Gradient",
      "kind": "effect",
      "source": "./Shaders/Gradient.wgsl"
    },
    {
      "name": "Present",
      "kind": "effect",
      "source": "./Shaders/Present.wgsl"
    }
  ],
  "output": "./Generated/app-shaders"
}
```

Render the source image with `Gradient.wgsl`:

```wgsl
struct Params {
  time: f32,
  size: vec2f,
  accent: vec3f,
}

@group(0) @binding(0) var<uniform> params: Params;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = params.size.x / max(params.size.y, 1.0);
  let point = (uv * 2.0 - 1.0) * vec2f(aspect, 1.0);
  let radius = 0.35 + sin(params.time) * 0.03;
  let ring = 1.0 - smoothstep(0.0, 0.08, abs(length(point) - radius));
  let color = mix(vec3f(0.02), params.accent, ring);
  return vec4f(color, 1.0);
}
```

Sample it in `Present.wgsl`:

```wgsl
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(source, sourceSampler, uv, 0.0);
  let vignette = 1.0 - 0.35 * length(uv - vec2f(0.5));
  return vec4f(color.rgb * vignette, color.a);
}
```

As with `effect(gpu, source)`, an effect program gets a generated full-screen vertex stage when its resolved source has no vertex entry point. Its injected `uv` is top-origin: `(0, 0)` is the top-left corner, so sampling another vgpu target does not need a vertical flip.

## Build the Swift package

Validate the configuration, module graph, entry points, and native capability set before compiling:

```sh
npx vgpu native check
npx vgpu native build
```

`check` does not write generated files. `build` runs the platform compiler and writes a local Swift package to `Generated/app-shaders`.

In Xcode, first add the vGPU Swift package URL and starting version printed by `native build`. During `0.x`, choose **Up to Next Minor**; generated manifests express the same requirement as `.upToNextMinor(from: "<version>")`, allowing compatible patch releases without admitting a new minor version. For this example, select the single `VGPUMetalKit` product for the application target. It contains the Core, Resources, Render, Metal, and MetalKit modules plus only the Metal capability implementations that those modules require. Select `VGPUMetalRender` for offscreen rendering without MetalKit, `VGPUMetalCompute` for compute, or both when the same target uses both capabilities. `VGPUMetalInterop`, `VGPUSwiftUI`, `VGPUScene`, and `VGPUQueries` remain opt-in. Next choose **File > Add Package Dependencies**, select **Add Local**, open `Generated/app-shaders`, and add `AppShaders`.

The generated package declares the `VGPUABI` product from that same vGPU Swift package with the same remote version requirement, so SwiftPM resolves one shared contract. Runtime ABI integers independently decide whether an artifact can load; they do not replace SwiftPM version selection. Backend-complete products are selection units, not umbrella modules: Swift source still imports every module it names, and the setup does not rely on `@_exported import` or copy the runtime into every generated package.

Use separate configurations for independently distributed shader features. [Generated artifacts](/native/macos/artifacts) explains the semantic contract, Metal projection, compatibility fingerprints, and `.metallib` payload boundary.

## Render from an MTKView

Create long-lived resources once, then update data and encode work from the view's draw callback:

The renderer is `@MainActor` because it owns an `MTKView` and handles view lifecycle. `VGPU` and its backend-neutral live objects do not have global actor isolation; an offscreen renderer can own the same synchronous API in a different application actor. `VGPUMetalKit` creates and drives the surface on `@MainActor`, while the backend-neutral `VGPUSurface` handle itself remains in the renderer's owner isolation domain.

```swift
// HeroRenderer.swift
import AppShaders
import Foundation
import Metal
import MetalKit
import VGPUCore
import VGPUMetal
import VGPUMetalKit
import VGPURender
import VGPUResources

@MainActor
final class HeroRenderer: NSObject, MTKViewDelegate {
  private weak var view: MTKView?
  private let onError: @MainActor @Sendable (Error) -> Void

  private let gpu: VGPU
  private let surface: VGPUSurface
  private let scene: VGPUTarget
  private let gradient: VGPUEffect<Gradient>
  private let present: VGPUEffect<Present>
  private var unsubscribeFromErrors: (@Sendable () -> Void)?
  private var disposed = false

  init(
    view: MTKView,
    onError: @escaping @MainActor @Sendable (Error) -> Void
  ) throws {
    guard view.delegate == nil else {
      throw VGPUError.viewDelegateInUse
    }

    guard let device = view.device ?? MTLCreateSystemDefaultDevice() else {
      throw VGPUError.metalUnavailable
    }

    view.device = device
    view.colorPixelFormat = .bgra8Unorm
    view.sampleCount = 1

    let gpu = try VGPU.metal(device: device)
    let surface = try gpu.surface(view)
    let scene = try gpu.target(
      size: surface.size,
      format: .rgba16Float
    )
    let sampler = try gpu.sampler(
      minFilter: .linear,
      magFilter: .linear
    )

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
    let present = try gpu.effect(
      Present.self,
      bindings: .init(
        source: scene,
        sourceSampler: sampler
      )
    )

    self.view = view
    self.onError = onError
    self.gpu = gpu
    self.surface = surface
    self.scene = scene
    self.gradient = gradient
    self.present = present

    super.init()

    self.unsubscribeFromErrors = gpu.onError { @MainActor [weak self] error in
      self?.view?.isPaused = true
      self?.onError(error)
    }
    view.delegate = self
  }

  func draw(in view: MTKView) {
    do {
      try gpu.frame { frame in
        try gradient.update(\.params) { params in
          params.time = gpu.clock.time
          params.size = surface.size.float
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
    } catch {
      view.isPaused = true
      onError(error)
    }
  }

  func mtkView(
    _ view: MTKView,
    drawableSizeWillChange size: CGSize
  ) {
    do {
      try scene.resize(surface.size)
    } catch {
      view.isPaused = true
      onError(error)
    }
  }

  func dispose() throws {
    guard !disposed else { return }
    try gpu.dispose()
    if view?.delegate === self {
      view?.delegate = nil
    }
    unsubscribeFromErrors?()
    unsubscribeFromErrors = nil
    disposed = true
  }
}
```

One `gpu.frame` represents one ordered logical submission; Metal v1 implements it with one command buffer, and each `frame.pass` creates one render command encoder. Returning normally submits once. If the closure throws before submission, the frame cancels the command buffer, presents nothing, releases its retained resources, and rethrows the original error. Work submitted explicitly before an error cannot be rolled back.

The `catch` handles synchronous setup and encoding failures. `gpu.onError` handles lazy pipeline and Metal command-buffer failures discovered after `gpu.frame` returns. The handler closure is isolated to `@MainActor`, so Metal only enqueues its error and the runtime delivers it back on that actor. `await gpu.settled()` waits for the current snapshot of asynchronous work and every error-handler invocation that work produces in tests and teardown.

The application owns the `MTKView` and its delegate. `VGPUSurface` borrows the view for drawable acquisition and presentation; it does not install a delegate or overwrite view configuration.

The object that creates `HeroRenderer` retains it while the view is active and calls `try dispose()` during teardown. Throwing vgpu initializers release resources created before the error. UI cleanup remains explicit: a normal deinitializer may release thread-safe internals, but it must not be responsible for clearing the view delegate or other main-actor state.

## What this example establishes

- `Gradient` and `Present` are generated program descriptors, not generated renderers.
- `VGPUEffect<Gradient>` and `VGPUEffect<Present>` are independent runtime instances.
- One `VGPU` context owns the queue, clock, caches, and resources for both programs.
- `VGPUTarget` owns offscreen attachments and can bind its first color attachment directly, tracking texture replacement across resize.
- Pipeline state is created for each complete pipeline signature. It is not baked into the program artifact.
- The renderer updates one uniform binding without rebuilding either program.
- Swift owns dynamic control flow; Node.js is not present at runtime.

## Continue with the API

- [Configure programs](/native/macos/programs)
- [Initialize and update generated bindings](/native/macos/bindings)
- [Compose effects, draws, compute, targets, and frames](/native/macos/rendering)
- [Create resources and import Metal buffers or textures](/native/macos/resources)
- [Use the same renderer from SwiftUI or an existing MTKView](/native/macos/views)
- [Understand ownership, errors, and cleanup](/native/macos/lifecycle)
- [Build and verify native artifacts](/native/macos/build)
- [Inspect generated artifacts](/native/macos/artifacts)
- [Compare WebGPU and Metal output](/native/macos/compare)
