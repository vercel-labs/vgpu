# @vgpu/native

Private build-time tooling for generated Metal integration. This package is not published and does
not implement a Swift renderer or a public `vgpu native` command.

`generateMetalPackage` accepts compiled library bytes and selected emitted function names. It
returns the files of a self-contained Swift package without writing to disk. Optional reflected
flat-float uniform layouts generate binding-specific CPU packers. Complete stage-slot mappings
also generate explicit range validation and render binding helpers. Caller-supplied metadata does
not prove that it matches arbitrary library bytes.

The internal `compileMetalPackage` adapter resolves an explicit WGSL module map or an owned
`ShaderGraphSnapshot` captured with `@vgpu/wgsl/runtime`, validates and
translates render pairs and compute entries with a pinned Tint worker, and compiles Metal offline
before generating the package. Render programs support fixed uniform structs with flat float and
float-vector fields. Compute programs support storage buffers, fixed workgroup dimensions, and
effective runtime-array size data derived from explicit ranges. Prepared bindings expose owned
internal bytes for caller-managed uploads. Storage packing remains application-owned.

Physical layouts and stage mappings come from checked compiler metadata; the resolver supplies
authored struct names, not physical offsets. Other resource kinds, command
installation, and complete output replacement remain separate integration work.

The internal `checkMetalPackage` adapter runs the same source, semantic, translation, and generated
interface validation as compilation, but returns only a program/stage summary. It does not invoke
Apple's offline compiler or generate package files. This is an internal seam, not an installed CLI.

Read-only tooling seams parse the project configuration, diagnose the selected native toolchain,
validate output boundaries, and verify an existing package's exact file tree and integrity record.
Low-level output verification does not establish input freshness or authorize publication.
`checkMetalProject` validates one captured configured project without inspecting output;
`verifyMetalProject` adds original-path checks and compares the intact package with that capture's
fingerprint. These modules do not yet connect the project configuration to installed commands or
write generated directories.

`prepareMetalProject` compiles one captured project into the four coherent generated files without
publishing them. The private publisher currently stages and verifies those files under a physical
parent lock, then publishes exclusively to a missing destination or atomically replaces an ordinary
empty directory. Interrupted invocations retain explicit outcomes and recovery evidence. For a
missing-destination transaction, bounded read-only reconciliation can establish whether the original
intact generation reached the destination. Reconciliation never retries commit or deletes retained
recovery state. Complete replacement modes and the installed command workflow remain unfinished.

`loadMetalProject` captures configuration and all shader inputs into an immutable compiler input.
Its logical fingerprint includes the generation profile, selected programs, source hashes, and
import edges, not physical checkout paths or output ownership. Generation compatibility settings
are shared with the compiler, Swift package emitter, and integrity-record format.

The generated consumer API is documented in
[Load Metal functions](../../docs/topics/native/macos/metal/native-macos-metal-functions.docs.md),
[Render WGSL with Metal](../../docs/topics/native/macos/metal/native-macos-metal-rendering.docs.md),
[Pack uniforms for Metal](../../docs/topics/native/macos/metal/native-macos-metal-uniforms.docs.md),
[Bind Metal buffers](../../docs/topics/native/macos/metal/native-macos-metal-bindings.docs.md),
[Use multiple render targets](../../docs/topics/native/macos/metal/render/native-macos-metal-render-targets.docs.md),
[Dispatch WGSL compute](../../docs/topics/native/macos/metal/compute/native-macos-metal-compute-dispatch.docs.md),
[Use prepared compute bindings](../../docs/topics/native/macos/metal/compute/native-macos-metal-compute-prepared-bindings.docs.md),
and [Render computed data](../../docs/topics/native/macos/metal/compute/native-macos-metal-compute-rendering.docs.md).
Keep the guides, generated Swift, and external consumer fixtures aligned when changing the API.

## Checks

From the repository root:

```sh
pnpm --dir packages/native build
pnpm --dir packages/native test
pnpm --dir packages/native test:native
```

Both the workspace build and the native package build must include the publication helper's C
source beside its compiled JavaScript. The build-time session compiles that installed source with
the selected Xcode C compiler; the generated Swift package does not include the helper.

The portable suite checks generation and input validation. The separate native suite targets
Apple silicon and requires a Metal device, Swift tooling, and Xcode's Metal compiler component.
Missing tool or device prerequisites fail the native suite; passing the portable suite does not
imply native coverage. The suite does not enforce an architecture gate or establish Intel support.

Loader fixtures use handwritten Metal to isolate packaging and loading. Compiler fixtures instead
resolve real imported WGSL, run the pinned worker and offline compiler, and execute the guide's
Swift draw code with GPU pixel readback, including uniforms, explicit ranges, and shared-stage
bindings, dense and sparse render targets, and compute output readback through ordinary, prepared,
and manual binding paths. A bounded CPU-encoded indirect compute fixture also tests command replay
and reset/re-encoding with changed prepared ranges; it is not a TypeScript render-bundle runtime.
A private tracked buffer also passes from compute storage to a render uniform in one command
buffer, including application-owned blits before and after the generated passes.
Separate packing fixtures execute generated Swift against byte oracles; binder fixtures
isolate validation and encoder atomicity. None establishes a release support matrix.
Temporary consumers and resources are created outside the repository and cleaned up by the harness.
