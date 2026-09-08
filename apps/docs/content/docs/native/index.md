---
title: "Native"
description: "Compile WGSL modules into a native shader library and generated integration for application-owned Metal code."
---

Use vgpu's WGSL module system with native GPU code. A build step resolves imports, validates the
selected programs, compiles a shader library, and generates the host-language integration. Your
application keeps control of the platform GPU API.

> Warning: Native tooling is in development and is not published yet. The direct Metal guides
> identify the generated APIs exercised by native tests. Those tests do not establish a complete
> installation workflow or a release support matrix.

## Compile once, use native code

For macOS, the build produces a self-contained Swift package containing generated Swift and a
compiled Metal library. Node.js, Tint, WGSL, and generated Metal source stay on the build machine;
the application does not run a JavaScript renderer or translate WGSL at launch.

The generated types load selected functions on your Metal device and provide the supported
packing and binding helpers. They do not create a device, command queue, pipeline, frame loop,
or view. You can use several programs with different resources and native render state.

## Keep Metal in control

| vgpu provides | The application provides |
| --- | --- |
| WGSL import resolution and selected-program validation | Shader selection and application logic |
| A compiled library and typed function loading | Metal devices, pipelines, and render state |
| Supported uniform packers and checked buffer bindings | Buffer and texture allocation, data updates, and lifetimes |
| Binding metadata and prepared internal bytes | Command encoding, synchronization, submission, and presentation |

This boundary does not require a Swift equivalent of every TypeScript vgpu primitive. Use ordinary
Metal commands before, between, and after generated shader work. Native composition remains
available without going through another renderer abstraction.

One configuration packages all of its selected shader programs together. Use separate configurations
when shader payloads must be distributed independently; choosing fewer Swift symbols does not remove
functions from an already compiled library.

## Start with macOS

Read [macOS](/native/macos) for the current workflow, then
[Render WGSL with Metal](/native/macos/metal/rendering) for a complete draw.

Continue with [uniform packing](/native/macos/metal/uniforms),
[buffer bindings](/native/macos/metal/bindings), or
[compute dispatch](/native/macos/metal/compute/dispatch). Each guide states its supported profile.

macOS and Metal are the initial target. Windows and Vulkan are future work, not available backends.

## Earlier proposals

Pages labeled **Earlier proposal** retain the previous Swift-runtime exploration. Its context,
frame, view, and runtime-package APIs are not the API being shipped here. Start with the direct
Metal guides above when designing a new consumer.
