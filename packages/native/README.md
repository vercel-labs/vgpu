# @vgpu/native

Private build-time tooling for generated Metal integration. This package is not published and does
not implement a Swift renderer. Its local companion candidate supports `vgpu native doctor`,
`vgpu native check`, `vgpu native build`, and `vgpu native verify`.

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
authored struct names, not physical offsets. Other resource kinds remain outside the supported
profile.

The internal `checkMetalPackage` adapter runs the same source, semantic, translation, and generated
interface validation as compilation, but returns only a program/stage summary. It does not invoke
Apple's offline compiler or generate package files. The installed check uses this internal seam.

Read-only tooling seams parse the project configuration, diagnose the selected native toolchain,
validate output boundaries, and verify an existing package's exact file tree and integrity record.
Low-level output verification does not establish input freshness or authorize publication.
`checkMetalProject` validates one captured configured project without inspecting output;
`verifyMetalProject` adds original-path checks and compares the intact package with that capture's
fingerprint. Installed check and verify connect configuration to validation and current output
inspection respectively. These read-only modules do not write generated directories.

`prepareMetalProject` compiles one captured project into the four coherent generated files without
publishing them. The installed build connects this preparation to the private publisher and reports
success only from its checked publication receipt. Local-tarball coverage exercises initially
absent and ordinary empty destinations, followed by unchanged-input and changed-module/content rebuilds
of the owned package at the same output path. It independently verifies each generation's file set,
hashes and input fingerprint; replacement checks distinct retained directory identities, the new
module's exact file set, removal of old files without changing their bytes, and current verification.
An installed build also rejects an in-place modification of `Package.swift`, preserving the modified
package, original record and identities without creating transaction state or repairing the edit.
The private publisher currently stages and verifies those files under a physical
parent lock, then publishes exclusively to a missing destination, atomically replaces an ordinary
empty directory, or exchanges an intact package belonging to the same current configuration.
Native byte-identical and changed-module rebuild tests observe the actual exchange of distinct
complete directories and cleanup using the old package's own paths and metadata. Old generated
subtrees on another filesystem device are rejected before staging; a real mounted-image regression
checks this boundary and preservation of the existing package.
Interrupted invocations retain explicit outcomes and recovery evidence. Bounded
read-only reconciliation can confirm that the original intact generation reached the destination
in the missing and empty modes. Owned exchange can also be confirmed as published when its original
intact new generation is at the destination; a real SWAP followed by helper death before acknowledgment
exercises this read-only proof. If the helper dies before exchange, both complete original
generations at their original destination and staging names can instead prove non-publication.
Both trees are checked against their own modules and manifests; a missing destination remains
`unknown`, even with an intact new stage. These checks preserve the original failure and recovery
state, never retry commit or delete either generation. The bounded installed qualification is
described below; it does not establish every possible fault combination.

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

## Compiler boundary

Source semantics, pinned Tint validation, and the generated Metal interface are separate
boundaries. The translation worker compares the selected entry's core-IR interface with the
request, runs Tint's official Metal writer with its preflight, and checks the raised interface.
Request metadata alone is not evidence that translation honored the request. Physical buffer
offsets and stage slots come from validated compiler responses, not authored source names.

The generated package exposes the Metal data its caller needs, not Tint's private raised structs
or the superseded Swift runtime artifact envelope. Sparse vertex attributes and fragment color
locations retain their indices. Resource-class/index/count validation does not independently
recover original WGSL binding identities from the raised wrapper: their source-to-slot association
depends on the pinned compiler's binding remapper.

Internal compiler canaries may cover features outside this package's supported profile. They do
not expand the public API or establish support for another GPU architecture. Worker build locks,
authenticated source/oracle inputs, and licenses remain required build evidence; retired runtime
experiments are recoverable from Git history, not dependencies of the generated Swift package.

## Local companion candidate

The candidate packaging contract keeps the pinned Tint worker private to this package. Build the
package normally before running `pnpm pack`, which runs a maintainer-only `prepack` step. It reads the
accepted universal worker from `tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/`,
checks its locked length and SHA-256, and copies the unchanged bytes into
`dist/compiler/assets/darwin/vgpu-tint-worker`. It also authenticates and includes the existing
Dawn/Tint, Abseil, and JsonCpp notices under that directory's `licenses/` subdirectory.

Missing or mismatched accepted inputs fail packaging; existing distribution files are not a
fallback. Packaging does not rebuild or download Dawn, expand the runtime trust list, or sign a
different compiler. The runtime resolves only its package-relative worker asset, authenticates
its bytes, and executes an owned temporary snapshot. The worker is not a public executable or
a configurable path. Build metadata such as `.tsbuildinfo` is not part of the candidate.

The regular TypeScript/C-source build remains independent of the local worker cache. Assembly is
not an install, postinstall, or prepare hook. Generated distribution assets and candidate tarballs
remain untracked. A local offline install with dependency install scripts disabled tests this
candidate boundary; it does not qualify empty-cache installation, normal dependency install
scripts, signing/quarantine, or a release compatibility matrix. Local installed doctor, check and
initially-absent build publication and current-package verification are exercised through this
packaging boundary. An external Swift consumer uses exactly the three published payloads, checks
their original hashes and sizes, builds with no external Swift package or target dependencies,
relocates the complete build tree, and executes the documented compute and render programs on
this host. The original package, ownership record and recovery files remain unchanged. Its guards
detect generation-tool lookup through PATH only; they do not block absolute executable paths or
SDK discovery, or establish a clean-machine or release-matrix result. The package remains private
and unpublished.

Installed verification succeeds without compiler or temporary-directory prerequisites and leaves
parent recovery files untouched. It reports current ownership, integrity and input freshness,
not a publication outcome or permission to remove recovery evidence.

An installed build encountering an unrecognized recovery record reports its current non-publication
outcome, original error and retained paths without changing the existing package or recovery files.
Those paths are for inspection, not cleanup authority. A separate fault-instrumented invocation of
the installed candidate observes a real successful rename followed by helper death before its
acknowledgment. The command reports `Confirmation: reconciled` from its checked receipt, retains the
original failure and preserves the published package and journal. Its test-only preload modifies
only the selected helper's spawn environment; it does not qualify ordinary loader behavior, signing
or quarantine. A subsequent ordinary build recognizes that same retained transaction and reports
its original transaction ID, output and remaining journal without changing the package or evidence.
Its `not-published` outcome concerns only that new invocation; it has no publication receipt.
A separate installed invocation receives a real SIGINT at a test-only pre-commit write-completion
gate. It exits 130 with a not-published cancellation report, no confirmation, a complete prepared
stage and journal, and no output. The instrumented process sends no commit request and preserves
the existing projects and recovery evidence. A second invocation receives real SIGTERM at the
successful finalization-write completion, after its acknowledgment was checked. It exits 143 with
published/acknowledged cancellation, completes cleanup without retained paths and leaves output
that ordinary installed verification reports as current. An owned replacement also loses its actual
helper after the commit request but before exchange. One uninjected read-only reconciliation proves
non-publication without a receipt, preserving the original error, complete old output, complete new
stage and raw recovery record. Ordinary installed verification of the old output remains current.
A second owned invocation completes the actual exchange before losing its helper acknowledgment.
Its one uninjected reconciliation reports published/reconciled with the original error and retained
old stage, new output and unchanged journal; current verify leaves both complete generations intact.
In another pre-exchange interruption test, the instrumentation changes one old payload byte
in place before read-only reconciliation. The command reports unknown without confirmation and preserves
the original helper error alongside the reconciliation failure, exact changed output, complete new
stage and unchanged journal. Finally, an unexpected test-created entry in the old stage makes
acknowledged finalization refuse cleanup before removing the old files. The failed command reports
published/acknowledged and cleanup-failed, with the old four files plus entry, original journal and
complete current new output retained. It neither rolls back nor reconciles that known publication.
This is integrity-based cleanup-refusal coverage, not every possible filesystem cleanup failure.

See the seven-family
[local installed qualification](../../docs/topics/native/macos/metal/tooling/native-macos-metal-tooling-publication.docs.md#local-installed-qualification)
for the exact scope and remaining installation/platform/release exclusions.

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
Installed qualification requires one complete run of the ordinary CLI, relocated Swift consumer,
and selected interruption/recovery scenarios. A passing earlier phase or a green portable CI run
does not substitute for that result. The harness reserves time before starting bounded child
operations; a failed reservation is incomplete qualification, not an observed publication failure.
Investigate cumulative stage timings before changing the harness, and preserve all byte/identity
checks, child-process closure and recovery scenarios when removing redundant test work.
The owned-output fault cases compile their unchanged observer once, then load fresh authenticated
copies from separate case directories. Admission reserves 30 seconds for that shared compilation
plus the first 90-second command phase; subsequent cases reserve only their 90-second command
phase. The overall 240-second workflow budget and all fault/preservation checks remain unchanged.
The owned-package filesystem-boundary regression also uses macOS `hdiutil` to create and mount a
disposable read-only image inside its temporary fixture. It detaches that image before removing
the fixture; if detach cannot be confirmed, it preserves the fixture and reports the failure.

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
