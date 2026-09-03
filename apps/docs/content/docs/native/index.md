---
title: "Native"
description: "Explore a proposal for bringing the vgpu rendering model to native platforms with ahead-of-time compiled WGSL and a small platform runtime."
---

Native targets bring vgpu's rendering model to platform GPU APIs. You still create one backend-explicit GPU context, create resources once, update bindings, and encode explicit frames and passes. The public primitives stay backend-neutral; an opt-in backend module performs the platform work instead of vgpu's JavaScript runtime.

WGSL stays the source of truth. A build step resolves its module graph, reflects its interfaces, translates it for the platform, and generates typed program descriptors for the host language.

> Warning: Native is a docs-first API proposal. The commands, packages, and generated types on these pages are not available in a published vgpu release.

## Keep the same rendering model

Native is not a one-shader player. Effects, draws, compute programs, surfaces, targets, and frames remain separate primitives that you can combine at runtime.

| vgpu concept | Native responsibility |
| --- | --- |
| `Gpu` | Own one device, queue, clock, caches, errors, and resource lifetime. |
| `Surface` | Present frames through a platform view or layer. |
| `Target` | Hold offscreen color and optional depth attachments. |
| `Effect` | Run a generated full-screen fragment program with instance-owned bindings. |
| `Draw` | Combine a generated vertex/fragment program, geometry, and render state. |
| `Compute` | Dispatch a generated compute program against buffers and textures. |
| `Frame` and `FramePass` | Form one ordered logical submission; the backend chooses its native command representation. |

Generated types describe shader programs; they do not generate a renderer or view for every shader. The native context creates program instances, so the same generated program can be used more than once with different bindings or render state.

```swift
let first = try gpu.effect(Gradient.self, bindings: firstBindings)
let second = try gpu.effect(Gradient.self, bindings: secondBindings)

try gpu.frame { frame in
  try frame.pass(target: surface) { pass in
    try pass.draw(first)
    try pass.draw(second)
  }
}
```

## Compile shaders ahead of time

The build and runtime boundary is explicit:

```text
WGSL modules
  -> vgpu resolution and reflection
  -> backend-neutral semantic artifact + typed program descriptors
  -> selected backend projection and compilation
  -> native shader payload + opt-in vgpu runtime modules
  -> platform GPU API
```

| Build-only tooling | Runtime package contents |
| --- | --- |
| Node.js and the vgpu native compiler | Generated host-language program types |
| WGSL-to-platform translator | Compiled platform shader library |
| Platform shader compiler | Only the native vgpu modules selected by the application |
| Source maps and validation tools | Artifact compatibility metadata |

The application does not compile WGSL or execute JavaScript. It creates pipelines from the compiled functions for the formats, sample count, and render state of each target it actually uses.

Runtime products and shader payloads have separate boundaries. Importing only render products does not link the compute executor, but one generated configuration still packages every program in its single native shader library. Put independently distributed features in separate configurations when their shader bytes must also stay optional.

## Share contracts, not implementations

Native targets preserve the observable vgpu contracts:

- WGSL modules and pure-module rules work the same way.
- Bindings retain their authored WGSL names.
- Host-shareable offsets come from vgpu reflection, not host-language memory layout.
- An effect's injected `uv` remains top-origin: `(0, 0)` is the top-left corner.
- Pipelines are cached by program and complete pipeline signature, not generated once per shader.
- Resources belong to one GPU context and cannot be mixed across contexts.
- Backend-native resources enter through an explicit interop product and become backend-neutral wrappers before Render or Compute sees them.
- Unsupported capabilities fail explicitly instead of changing the rendering model.

The selected backend owns the implementation details: command buffers, render encoders, drawable presentation, native resource lifetime, and interop with platform GPU objects. Those types never become part of the generated-program ABI.

## Choose a platform

- [macOS](/native/macos) — target Apple silicon on macOS 14 or later, compile WGSL into a Metal library, and use vgpu primitives from Swift, MetalKit, or SwiftUI.

## Next steps

- [Use vgpu with Metal on macOS](/native/macos)
- [Understand the vgpu context](/concepts/context)
- [Compose effects through targets](/concepts/effects)
- [Encode passes and frames](/concepts/frames)
