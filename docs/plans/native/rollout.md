# Native rollout and verification

Every gate has a fixture and a falsifiable exit condition. A spike may be discarded; its fixture
and result remain as evidence for the next API revision. See [architecture](./architecture.md) for
the boundaries these gates protect and [decisions](./decisions.md) for unresolved choices.

## Shipping gates

| Gate                           | Fixture                                                                                                                                                                                                                                                                      | Exit condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C0: module and link boundaries | ABI-only, context-only, effect-only, low-level draw, scene-recipe, compute-only, view-integration, and full-runtime release applications                                                                                                                                     | Declared dependency graphs and negative imports pass; public symbol graphs, final link maps, linked frameworks, stripped Mach-O payloads, and packaged resources contain no forbidden feature. If a protocol witness graph retains an unused backend capability, split that Metal implementation before freezing the package graph.                                                                                                                                                                                                                                                                                                                       |
| C1: translation                | Imports, explicit language features, multiple entry points, I/O built-ins and interpolation, typed overrides baked before translation, resolved override-backed workgroup sizes, external and internal binding slots, pipeline-local vertex streams, and deliberate failures | The vgpu-owned Tint wrapper validates only the declared language features, reflects intrinsic semantic layouts, applies the versioned vgpu slot map, and returns deterministic MSL plus emitted names, workgroup metadata, and the exact slots used. Vertex streams follow the highest occupied vertex-stage shader interval, fit below the projected external ceiling, and are rebound when a pipeline changes that physical mapping. Unsupported WGSL resource binding arrays (`binding_array`) fail before projection. Resolved MSL compiles offline; diagnostics identify the authored span or clearly identify generated MSL when no mapping exists. |
| C2: binding ABI                | Scalars, vectors including `vec3`, matrices, fixed and runtime arrays, compact uniform layouts, explicit `@align`/`@size`, strict negative inputs, and f16 edge values                                                                                                       | Tint reflection, Swift, and TypeScript agree on `wgsl-host-shareable-v1` layouts and valid packed bytes; invalid shapes, counts, integer ranges, and extents fail before mutation; f16 matches round-to-nearest-ties-even; Metal readback observes every value at the intrinsic offset.                                                                                                                                                                                                                                                                                                                                                                   |
| C3: artifact and SwiftPM       | Generated package in a clean sample project                                                                                                                                                                                                                                  | `swift build` and `swift test` need no Node.js after generation; `Bundle.module` loads the single `.metallib`; schema references resolve; unknown layout, binding, or vertex-buffer policy models and incompatible semantic, Metal-projection, generated-Swift, binding-layout, or `VGPUABI` integers fail before pipeline creation; runner incompatibility blocks compare only.                                                                                                                                                                                                                                                                               |
| R1: effect parity              | Existing UV-orientation fixture plus a uniform-driven effect                                                                                                                                                                                                                 | Top-origin UV, clear, alpha, blend, resize, and readback meet the fixture's declared tolerance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R2: multipass                  | Two draws into an offscreen target followed by a sampling pass                                                                                                                                                                                                               | One frame creates one command buffer, preserves pass order, commits once, and creates no pipeline after warm-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D1: draw and geometry          | Procedural triangle, indexed box, depth, culling, instancing, pipeline switches with different physical stream maps, and Swift ports of the `plane` and `sphere` CPU generators                                                                                              | Draw counts, topology, vertex layouts, ranges, winding, depth, and output match the WebGPU oracle; changing a pipeline mapping rebinds every active logical stream; each `VGPUScene` recipe also matches golden CPU vertex/index data, attributes, UVs, bounds, and winding. A plane-only link map retains no unrelated primitive implementation.                                                                                                                                                                                                                                                                                                         |
| C4: compute and storage        | Storage-buffer simulation with two compute entry points                                                                                                                                                                                                                      | Buffer bytes, dispatch dimensions, aliasing errors, and ping-pong swaps match the WebGPU oracle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| DC1: compute to draw           | Compute-generated indirect arguments consumed by a draw                                                                                                                                                                                                                      | The handoff stays on the GPU and introduces no readback or CPU synchronization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| L1: lifecycle                  | Repeated create, resize, pause, resume, fail, subscribe, unsubscribe, empty and populated submissions, per-submission settle, context settle, import, handoff, and teardown cycles; a two-thread overlap barrier; host/vgpu/host work on one borrowed queue                  | Overlap fails immediately without blocking or mutating the rejected call; valid synchronous nesting remains reentrant; submission tokens are stable, scoped, non-throwing, and exclude unrelated bookkeeping while respecting queue order; context settle tracks every vgpu submission; disposal is idempotent after success and retains in-flight work; error delivery preserves actor, order, and unsubscribe semantics; close → settled → re-import succeeds only after usage drains; UI cleanup never depends on a nonisolated deinitializer.                                                                                                         |
| P1: distribution               | Clean signed sample running natively as `arm64` on Apple silicon for every supported macOS version                                                                                                                                                                           | No runtime Node.js, WebKit, translator, or source WGSL; memory stabilizes; steady state creates no pipelines; uploads and readbacks do not depend on unified-memory coherence; the package is relocatable.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Only normalized pixel output receives its fixture's declared tolerance. Manifests, shared semantic
error codes, packed bytes, logical command order, and fingerprints compare exactly.
Backend-internal resource transitions are not a cross-platform contract.

For the first alpha, "supported" means Apple silicon running the application and Swift runtime
natively as `arm64` on macOS 14 or later. Intel-based Macs and execution on Intel or AMD GPUs remain
unverified and unsupported until C3, R1, R2, D1, L1, and P1 run repeatedly on physical machines in
that matrix. Simple shaders reduce translation surface area but do not substitute for driver,
format, memory-model, synchronization, lifecycle, and distribution evidence.

CI may also cross-build the runtime, generated package, and clean sample for `x86_64`. Record that
result separately as an architecture-portability signal. It is not a P1 execution result and does
not expand the supported matrix. The recorded `metalCompilerTargetTriple` is Apple's Metal
AIR/platform/deployment target, not the Swift executable architecture and not proof that any
particular GPU can load or execute the library.

## Spike order

### 0. Module and linker proof

Run C0 against the proposed product graph before treating source targets as code-size boundaries.
The fixture must demonstrate both positive inclusion and negative exclusion. In particular, an
effect-only application must not retain compute, Scene, Queries, Testing, MetalKit, or SwiftUI, and
a context-only application must not retain Resources or Render through the Metal backend's witness
tables.

C0 established that capability-separated source files in one Metal target retain unused witness
graphs, including under full LTO. Keep Core, Resources, Render, and Compute in physical Metal
implementation targets. Backend-complete, per-capability SwiftPM products select those targets;
they require neither runtime registration nor `@_exported import`. Re-run the fixture for compiler,
linker, or package-graph changes.

### 1. Compiler and ABI

Run C1 and C2 before freezing the translator or generated Swift. Compare candidates against the
existing shader corpus instead of choosing from isolated examples.

The translator spike runs every repository WGSL source plus explicit language-feature,
entry-point I/O, `vec3`, matrix, array, override, override-backed workgroup, and binding-slot
canaries. Production v1 constructs a deterministic direct-slot map, including reserved internal
bindings, before translation. The wrapper passes that map into Tint and returns the exact map used
with the MSL; Tint's convenience allocator is never an ABI. Hard gates are semantic coverage,
offline Apple compilation, correct binding and entry-point metadata, deterministic output,
actionable negative diagnostics, and pixel/buffer parity.

Tint is the provisional semantic leader. Tint/Dawn accepted all 223 expected-valid shaders and
created real Metal pipelines for every applicable entry point. Naga 30.0.1 accepted 220: it does
not implement the FFT library's `unrestricted_pointer_parameters`, and it rejects the
`uniform_buffer_standard_layout` canary. Retain Naga as a differential oracle.

The standalone follow-up proved a single vgpu-owned Tint executable can parse and reflect WGSL,
choose stable emitted names, and return deterministic MSL with structured layouts, entry points,
workgroup metadata, and slots without a WebGPU device. The binding-slot follow-up then supplied a
vgpu-owned map directly to Tint, checked exact intervals after lowering, and made external and
internal collisions deterministic failures. Its candidate allocator is per semantic program,
selected stage, and Metal resource class; active WGSL bindings use canonical `(group, binding)`
order, while required internal roles use explicit high-end reservations.

The vertex-buffer follow-up keeps those shader and internal slots fixed, then derives logical
vertex streams per pipeline immediately after the highest occupied vertex-stage shader-buffer
interval. A versioned projection policy supplies the exclusive external ceiling. Metal accepted a
deliberately colliding pipeline, so the fixture used order-sensitive readback to prove the alias and
made disjointness a vgpu validation invariant. A single-encoder pipeline-switch canary also proved
that changing the physical map requires rebinding every active stream. The fixture's numeric
partition, complete 31-entry table, and conservative constant-argument mix are test inputs rather
than public ABI or hardware-support claims.

Do not freeze the source pin or numeric slot profile until the wrapper is built from direct Tint
targets for macOS 14 with arm64 and x86_64 slices, size-table packing for multiple runtime storage buffers is verified, and offline `metal` +
`metallib`, authored-diagnostic provenance, artifact determinism, and pixel/buffer parity pass.
Semantic v1 cannot represent WGSL resource binding-array (`binding_array`) cardinality, so alpha
rejects all resource binding arrays.
The reproducible fixtures live in `experiments/native-metal-spikes/c1-translators`,
`experiments/native-metal-spikes/c1-tint-standalone`, and
`experiments/native-metal-spikes/c1-binding-slots`, and
`experiments/native-metal-spikes/c1-vertex-buffer-slots`.

The first canary must cover alignment traps rather than just a gradient:

```wgsl
struct PaddedWeight {
  @size(16) value: vec2f,
}

struct Params {
  scalar: f32,
  direction: vec3f,
  transform: mat4x4f,
  weights: array<PaddedWeight, 3>,
}
```

This padded canary is valid with the baseline language-feature set. A separate compact canary uses
`array<f32, 3>` and a small nested struct. It must fail when
`uniform_buffer_standard_layout` is absent and preserve intrinsic four-byte alignment and stride
when the feature is explicitly present. The feature changes address-space validation, not WGSL
`AlignOf` or `SizeOf`, and participates in every logical, program, and semantic fingerprint.

C2 established `wgsl-host-shareable-v1` as the packing contract. An independent Swift
implementation agrees with Tint's intrinsic layouts for scalars, vectors, matrices, nested structs,
fixed arrays, runtime arrays, and explicit member alignment and size. Metal compute readback also
passes the four decisive small-uniform canaries. The existing TypeScript `naga-standard` calculator
diverges for those four canaries, including a valid four-byte root struct; replacing it directly
with the semantic layout model is a prerequisite to closing C2. No compatibility alias is part of
the native contract.

Both packers must validate the complete value before writing: fixed shapes and counts are exact,
integers are integral and in range, and a runtime array's element count and byte extent are checked
without mutating its immutable layout. Writes are little-endian with column-major matrices and
zeroed padding. The f16 edge table uses IEEE 754 binary16 round-to-nearest, ties-to-even; NaN class,
not payload bits, is the portable assertion.

`native doctor` must compile and link a minimal shader. Finding `xcrun` or the `metal` executable is
not sufficient because recent Xcode installations can omit the downloadable Metal toolchain.

Overrides in these fixtures are substituted before translation. Neither candidate may defer them
to Metal function constants in v1. Source maps are optional evidence: a translator that cannot
produce a standard WGSL-to-MSL map must identify generated MSL clearly rather than fabricate one.

### 2. First distributable vertical slice

Run C3 with `VGPU`, `Target`, `Effect`, generated bindings, one-shot offscreen rendering, and
readback. Then run R1 with `Surface`, `Frame`, and `FramePass` to prove drawable acquisition and
presentation without relaxing the rule that a surface is valid only inside a frame. This proves the
package boundary, not the final API surface.

The candidate package contract is Swift tools 6.0, Swift language mode 6, and macOS 14 deployment.
C3 runs the generated package natively as `arm64` on Apple silicon with the oldest candidate Xcode
that can build and execute on the macOS 14 CI host, a later Xcode 16 release, and the current
supported toolchain. It must also consume an artifact generated by the newest matrix member from
the oldest runtime member. Publish an exact Xcode patch floor only after this matrix passes; keep
deployment target, build-host minimum, compiler floor, and tested hardware matrix as separate
values.

C3a passed the current structural fixture. It compiled all five schemas with strict Ajv, resolved
their cross-schema references, reproduced the generated tree byte for byte, checked every artifact
and fingerprint relation, tested the generated package, and built and ran a clean consumer without
invoking Node.js, Tint, or Apple Metal compiler tools after generation. It also checked the SwiftPM
tools, language, deployment, dependency, target, and resource declarations; exercised compatibility
mutations; and rejected an injected file outside the positive generated-output allowlist. The
fixture's sibling packages use relative paths only for isolation; the production winner for remote
dependencies during `0.x` is `.upToNextMinor(from:)`.

C3b was skipped because the separately installed offline Metal toolchain was unavailable. When it
runs, its handwritten Metal no-op probe checks the exact packaged `.metallib`, function lookup,
pipeline creation, slot use, dispatch, and readback. That probe is not the compare runner, does not
appear in `projection.testing`, and cannot prove that recorded WGSL produced the MSL. C3 therefore
remains open pending a C1-connected artifact, production `VGPUABI` and runtime, the supported
Xcode/macOS and physical-hardware matrix, and newest-generator to oldest-runtime consumption. It is
also still undecided whether production always emits the real compare runner or emits it only when
compare testing is enabled.

The matrix type-checks positive `@MainActor` and instance-actor `onError` handlers, rejects a
non-`Sendable` capture, and exercises every async live-object method with the default `#isolation`
parameter. It also sends a `VGPUSubmission` across actors and verifies that `settled()` resumes on
the caller's actor. It does not rely on Swift 6.2 `isolated deinit`: MetalKit delegate restoration
and other UI cleanup must happen through explicit main-actor disposal on every supported compiler.

### 3. Minimum primitives alpha

Run R2, D1, and L1 before calling the feature a native vgpu runtime. The first alpha includes:

- `VGPU`, `Surface`, `Target`, `Frame`, and `FramePass`;
- `VGPUSubmission` from frames and one-shot render or compute work;
- `Effect` and `Draw`;
- uniforms, textures, and samplers;
- procedural, static, and `vgpu/scene` geometry recipes;
- offscreen targets, multiple render passes, depth, blending, and instancing;
- a generic `VGPUView` convenience layer implemented on top of those primitives.

The first format probe starts with `rgba8Unorm`, `rgba8UnormSRGB`, `bgra8Unorm`,
`bgra8UnormSRGB`, `rgba16Float`, and `depth32Float`, with sample count 1. For every supported device
family it records direct limits, format-family evidence, real texture creation for each claimed
usage, and representative pipeline creation. It also covers maximum buffer length, threads per
threadgroup, threadgroup memory, effective resource slots after vgpu reservations, float32
filtering, and read/write texture support. Formats, MSAA, compressed textures, storage textures,
and combined depth/stencil expand only after their operation-specific probes pass.

`gpu.capabilities` exposes the effective intersection of runtime, compiler projection, and the
actual device. Preflight is useful but not a substitute for resource and pipeline creation because
Metal has no universal format-and-usage query. The artifact records only static shader
requirements; dynamic target and sampled-texture formats stay out of it.

`VGPUScene` ports pure mesh generation to Swift, one primitive per source file. The first D1 spike
ports `plane` and `sphere`, compares index buffers and vertex attributes against JavaScript-produced
goldens, and inspects a plane-only release link map. Where platform trigonometry prevents honest
byte identity, the fixture declares a narrow ULP tolerance or adopts deterministic math; production
does not ship pre-generated mesh blobs merely to make the test byte-exact.

L1 verifies submission completion independently from the context drain. Auto-submit returns one
token even for an empty normal frame; repeated `frame.submit()` calls and the outer normal return
refer to the same stable logical submission; every one-shot effect, draw, and dispatch returns its
own token. A token settles only after that submission's GPU completion and deferred error deliveries,
never throws, and does not wait for unrelated logical submissions, compilation, readbacks, or later
work. The borrowed-queue fixture proves that earlier host commands still precede token completion
without enrolling host readbacks or error delivery. A separate context fixture proves that
`gpu.settled()` includes plain one-shot render and compute submissions without another tracked fence.
Throwing before submit cancels the frame and exposes no token. Explicit submit followed by a callback
throw preserves the original error and leaves the token observable only when the callback captured
the `submit()` result. Performance fixtures must keep multiple animation frames in flight rather
than awaiting each token inside the frame loop.

### 4. Compute milestone

Run C4 and DC1. Initially preserve the JavaScript ordering boundary: a one-shot compute dispatch
commits its own command buffer, and a following render frame is ordered by the queue. Do not add a
Swift-only `frame.compute` until the same shared semantic is designed for JavaScript.

### 5. Advanced parity

Add storage textures, ping-pong helpers, indirect commands, MRT, MSAA, bundles, timers, and
visibility only with dedicated parity and lifecycle fixtures. Metal implementation details do not
need a one-to-one WebGPU type when the observable vgpu contract can remain the same.

A future render bundle or Metal indirect-command-buffer path must replay logical vertex bindings
through the selected pipeline mapping or key its cached commands by the complete physical mapping
identity. It must never reuse bindings only by logical stream number across incompatible mappings.

## Documentation gate

The docs are the API specification. Before implementation begins:

- the quickstart must create a `VGPU` context and a generated program instance;
- the primary example must include an offscreen target and multiple passes;
- effects, draws, and compute must be shown as program instances rather than generated views;
- generated bindings must demonstrate initialization and partial updates;
- an existing `MTKView` and the generic SwiftUI `VGPUView` must share the same underlying renderer;
- ownership, actor isolation, errors, target signatures, and cleanup must be explicit;
- every Swift code block intended to compile must become a fixture as its feature slice lands;
- unsupported features must fail through `native check` rather than silently downgrade.

## Optional TypeScript graph compiler

A build-time recording frontend can be explored after the program artifact and Swift runtime are
stable. It requires its own versioned render-graph IR; the current mock instrumentation is not that
IR. Static resources and commands can be serialized, while runtime branches, callbacks, readbacks,
and project-owned side effects must become explicit inputs or stay in Swift.

This frontend must not make the native runtime depend on JavaScript, Node.js, or Dawn.
