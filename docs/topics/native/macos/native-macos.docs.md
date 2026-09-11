---
title: macOS
summary: Generate a Swift shader package from WGSL and use its functions, packers, and bindings with your own Metal code.
websitePath: /native/macos
keywords: macos, metal, wgsl, metallib, swift, swiftpm, native integration
---

# macOS

Generate a Swift package from WGSL modules, then use its functions and bindings with Metal.
Your application owns the device, pipelines, resources, encoders, synchronization, and presentation.

> Beta: Install the optional `@vgpu/native` companion alongside the same exact RC version of `vgpu`. Native tests
> exercise the direct integration on Apple silicon; they do not establish a release support matrix.

## Start with a draw

[Load Metal functions](/native/macos/metal/functions) explains how to add the generated package to
a Swift consumer and load its selected functions on an existing device.

[Render WGSL with Metal](/native/macos/metal/rendering) connects imported WGSL to an
application-owned pipeline and render encoder. The generated program is neither a view nor a
renderer, and the application decides when to draw.

When a program needs data, follow [Pack uniforms for Metal](/native/macos/metal/uniforms) and
[Bind Metal buffers](/native/macos/metal/bindings). Uniform bytes follow the reflected shader layout,
not the in-memory layout of an arbitrary Swift struct. Bindings accept ordinary Metal buffers with
explicit offsets and lengths.

## Compose programs with native work

The generated API does not restrict the application to a single effect. Use native Metal to
combine programs, select attachments, and schedule work:

- [Use multiple render targets](/native/macos/metal/render/targets) with application-owned textures.
- [Dispatch WGSL compute](/native/macos/metal/compute/dispatch) against explicit storage-buffer ranges.
- [Use prepared compute bindings](/native/macos/metal/compute/prepared-bindings) when managing internal uploads yourself.
- [Encode native indirect dispatch](/native/macos/metal/compute/indirect-dispatch) and replay commands.
- [Render computed data](/native/macos/metal/compute/rendering) without an intermediate CPU readback.

The indirect example is a bounded Metal integration, not a TypeScript render-bundle runtime.
Resource allocation, command lifetime, hazards, and synchronization remain application responsibilities.

## Generate the shader package

[Configure a Metal package](/native/macos/metal/tooling/configuration) selects the WGSL sources,
render or compute entry points, Swift module name, and generated output directory.

The tooling workflow separates [toolchain diagnostics](/native/macos/metal/tooling/doctor),
shader validation, generation, and read-only integrity checks.
[Build and verify a Metal package](/native/macos/metal/tooling/build) defines those commands and
marks what remains under development.
[Resolve shader inputs](/native/macos/metal/tooling/sources) explains imports and captured build inputs.

Add the generated directory as a local Swift package dependency of the consuming application.
The generated package has no external Swift dependencies. Build it through the consuming project,
whose build products stay outside the immutable generated directory.

You can commit or distribute that package with your project so another Swift consumer does not
need Node.js or a WGSL compiler. Regeneration still needs the native build toolchain. See
[Publish generated packages](/native/macos/metal/tooling/publication) for output ownership and recovery.

## Check the current profile

The initial application target is Apple silicon. Generated artifacts declare macOS 14, Swift tools
6.0, and Metal 2.4. These settings are not proof of testing on every matching operating system or
toolchain. Physical Intel and AMD GPU execution is not covered by the current native tests.

Build tooling uses Node.js 22 and a selected Xcode installation with its Metal compiler component.
The application does not require Node.js, Tint, or Xcode at launch.

The current render binding profile covers fixed uniforms with flat float and float-vector fields.
Compute supports the storage layouts and runtime-array ranges listed in its guide. Texture and
sampler bindings, active overrides, and other unsupported shader features fail explicitly; the
compiler does not silently substitute a different program.

This limits the generated integration, not the Metal features available to the rest of the
application. Combine supported generated shaders with your own native resources, pipelines, and
other shader code where needed.
