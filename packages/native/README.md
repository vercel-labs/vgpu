# @vgpu/native

Private build-time tooling for generated Metal integration. This package is not published and does
not implement a Swift renderer or a public `vgpu native` command.

`generateMetalPackage` accepts compiled library bytes and selected emitted function names. It
returns the files of a self-contained Swift package without writing to disk. Optional reflected
flat-float uniform layouts generate binding-specific CPU packers. Complete stage-slot mappings
also generate explicit range validation and render binding helpers. Caller-supplied metadata does
not prove that it matches arbitrary library bytes.

The internal `compileMetalPackage` adapter resolves an explicit WGSL module map, validates and
translates vertex/fragment pairs with a pinned Tint worker, and compiles Metal offline before
generating the package. Its current resource profile covers fixed uniform structs with flat float
and float-vector fields. Physical layouts and stage mappings come from checked compiler metadata;
the resolver supplies authored struct names, not physical offsets. Compute, other resource kinds,
command installation, and atomic output publication remain separate integration work.

The generated consumer API is documented in
[Load Metal functions](../../docs/topics/native/macos/metal/native-macos-metal-functions.docs.md),
[Render WGSL with Metal](../../docs/topics/native/macos/metal/native-macos-metal-rendering.docs.md),
[Pack uniforms for Metal](../../docs/topics/native/macos/metal/native-macos-metal-uniforms.docs.md),
and [Bind Metal buffers](../../docs/topics/native/macos/metal/native-macos-metal-bindings.docs.md).
Keep the guides, generated Swift, and external consumer fixtures aligned when changing the API.

## Checks

From the repository root:

```sh
pnpm --dir packages/native build
pnpm --dir packages/native test
pnpm --dir packages/native test:native
```

The portable suite checks generation and input validation. The separate native suite targets
Apple silicon and requires a Metal device, Swift tooling, and Xcode's Metal compiler component.
Missing tool or device prerequisites fail the native suite; passing the portable suite does not
imply native coverage. The suite does not enforce an architecture gate or establish Intel support.

Loader fixtures use handwritten Metal to isolate packaging and loading. Compiler fixtures instead
resolve real imported WGSL, run the pinned worker and offline compiler, and execute the guide's
Swift draw code with GPU pixel readback, including uniforms, explicit ranges, and shared-stage
bindings. Separate packing fixtures execute generated Swift against byte oracles; binder fixtures
isolate validation and encoder atomicity. None establishes a release support matrix.
Temporary consumers and resources are created outside the repository and cleaned up by the harness.
