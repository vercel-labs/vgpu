# Native decisions

This log separates contracts already fixed by documentation from work that still needs evidence.
Architectural rationale lives in [architecture](./architecture.md), API mappings in
[API contract](./api-contract.md), and fixtures in [rollout](./rollout.md).

## Accepted API and behavior

- The initial deployment target is macOS 14. The first alpha is supported and tested only when the
  application and Swift runtime execute natively as `arm64` on Apple silicon. Intel-based Macs,
  including execution on Intel integrated or AMD discrete GPUs, remain unverified and unsupported
  until recurring physical-hardware gates exist. Exact Swift and Xcode patch versions remain a C3
  compatibility-matrix result.
- One configuration emits one Swift module and one `.metallib`.
- Generated bindings support complete initialization, binding key-path `set`, and copy-then-commit
  `update` for value-owned uniform blocks.
- `VGPU` and its backend-neutral context-owned objects have no global actor isolation and
  intentionally do not conform to `Sendable`. The application keeps the complete graph in one
  owner isolation domain: normally `@MainActor` for view integration or an application-defined
  actor for offscreen work. Encoding stays synchronous within either owner.
- Internal synchronization covers native completions, in-flight retention, error publication,
  lazy compilation, and lifecycle coordination. A separate context-wide access gate is
  non-blocking and reentrant only within one synchronous call stack; overlapping access fails with
  `VGPU-NATIVE-CONCURRENT-ACCESS`. Neither mechanism makes live objects safe to share, and user
  callbacks never run while an internal lock is held.
- `gpu.onError` accepts an `@isolated(any) @Sendable` handler and returns an idempotent `@Sendable`
  unsubscribe closure. `@Sendable` rejects unsafe mutable captures, while `@isolated(any)` records
  the subscriber's actor for delivery. Each subscription observes publication order without
  overlapping handler invocations; delivery is enqueued to active handlers in subscription order
  and never invokes user code from a native completion callback. The first public API keeps the
  stream that transports errors internal.
- For macOS 14 back-deployment, the runtime stores each `@isolated(any) @Sendable` callback inside a concrete
  subscription record rather than using that function type directly as a generic collection
  argument, which would require newer Swift runtime metadata.
- `gpu.settled(isolation: isolated (any Actor)? = #isolation)` inherits the caller's actor, snapshots
  work already known to the context, and waits for its lazy compilation, native completions, every
  error that work later publishes, and corresponding handler delivery without throwing. Work
  registered later is not included.
- Every successful frame, one-shot effect, one-shot draw, and compute dispatch returns a
  discardable `VGPUSubmission`. The token is `Sendable`; its non-throwing
  `settled(isolation: isolated (any Actor)? = #isolation)` waits only for that logical submission and
  its deferred error deliveries. The frame result is behavioral parity with JavaScript `Frame.done`;
  returning the token from TypeScript's `void` one-shot effect, draw, and dispatch counterparts is an
  intentional Swift extension.
- A normally returning frame callback auto-submits and returns its token. `frame.submit()` is
  idempotent and returns the same stable token, including when the outer call later returns normally.
  An empty normal frame still commits one ordered submission. A callback throw before submission
  cancels the frame and yields no token. If it explicitly submits and then throws, the outer call
  preserves the original error; callers can observe the submitted work only if the callback saved
  the `frame.submit()` result before throwing.
- A submission token excludes unrelated logical work. Its command buffer still completes after
  earlier commands on the serial Metal queue, including a borrowed queue's host commands, without
  waiting for their readbacks or error delivery. Swift `gpu.settled()` registers every vgpu
  submission; this intentionally closes the current TypeScript gap for plain one-shot and compute
  work that has no other tracked fence.
- Every async operation on a live context object uses the same default isolation parameter. It
  validates, snapshots a resource generation, and registers immutable work before suspension;
  readback and compilation results return to the owner actor without sending the live object into
  a child task.
- `VGPUErrorCode` is an extensible `RawRepresentable`, `Hashable`, `Sendable` value with static
  members supplied by Core and opt-in modules. A closed enum would force Core to know every Metal,
  MetalKit, and future backend failure.
- Core contexts and resources expose synchronous throwing `dispose()`. A successful close is
  idempotent, stops new work without waiting for the GPU, and retains submitted resources until
  completion. Concurrent disposal fails before mutation; disposal from an active encoding scope
  fails with its own coded state error. `settled()` remains valid after close.
- Main-actor host adapters keep non-throwing disposal because they own and stop their scheduler
  before teardown. Required UI cleanup is explicit; a normal deinitializer may release only
  thread-safe internals and never relies on Swift 6.2 `isolated deinit`.
- `VGPUFramePassResult` is `Sendable` with `.encoded` and `.unavailable`. Drawable unavailability
  is a normal per-frame result, not an asynchronous error.
- Capability support comes from the installed compiler/runtime version plus runtime validation of
  the actual Metal device; there is no selectable capability tier. Effective capabilities are the
  intersection of runtime implementation, compiler projection, and `MTLDevice` support. Tables and
  direct queries provide preflight, while final resource and pipeline creation remains authoritative.
- `native compare` uses a declared offscreen output and normalizes only row/channel order to
  top-origin RGBA8 before applying `maxChannelDelta` and `maxDifferentPixels`.
- One generated package depends on the shared, compatible `VGPUABI` product; it never embeds a
  private runtime copy or depends on a rendering, compute, UI, or backend executor.
- The native manifest is a generic `vgpu-native-artifact/v1` envelope containing one
  `vgpu-native-semantic/v1` object and one selected `vgpu-native-metal-projection/v1` object. The
  root `files` entries contain only path, size, and hash. Metal toolchains, emitted names, slots,
  `.metallib`, and device requirements stay in the projection.
- The semantic contract is the complete portable shader-interface oracle. It stores flattened
  stage inputs and outputs with exact locations or built-ins, semantic types, normalized effective
  interpolation, and invariance. It validates each fragment input against the corresponding vertex
  output before a backend projection is created. Scalar returns do not receive fabricated names.
- Metal projection ABI v1 uses `vgpu-metal-shader-interface-v1` and serializes only runtime-facing
  maps: vertex user locations to Metal attributes, fragment user locations and optional blend
  sources to Metal colors and indices, and an empty compute interface. Built-ins, inter-stage
  varyings, interpolation, invariance, and Tint-generated names remain outside the Metal runtime
  projection. Sparse indices are preserved exactly and never compacted.
- The accepted compiler-worker contract requires the request to carry the exact semantic interface.
  The worker compares it against Tint core IR before calling Metal `Generate()`, preserving the
  official writer preflight. It then validates the complete lowered interface privately on that
  same, now-raised IR. Its response returns only the generated MSL and minimal Metal runtime map.
  This handshake has passed its C1 protocol gate.
  [Native shader-interface contract](./compiler/shader-interfaces.md) owns the detailed boundary.
- The worker validates the emitted Metal resource-class, index, and count set, but does not recover
  each original WGSL binding identity from the raised wrapper. The source-to-slot association trusts
  Tint's `BindingRemapper`; the response reserializes the independently validated requested map.
- The first alpha rejects `dual_source_blending`. The semantic and Metal schemas retain paired
  blend-source fields for future profiles and fixtures. The internal worker protocol allowlists and
  tests the paired lowering, but translator and current-device acceptance do not enable the product
  feature.
- The Metal projection names its storage-buffer-size model once and records a canonical
  `storageBufferSizeRegions` array for every program. A region contains only its stage and byte
  offset inside that stage's `immediate-data` internal binding. Programs without a required size
  transport keep the array empty. There is no dedicated size-table binding, serialized word count,
  or `needsStorageBufferSizes` boolean, and the model string versions the algorithm without another
  integer ABI.
- `wgsl-host-shareable-v1` is the canonical semantic layout model. Tint semantic types are the
  oracle for intrinsic WGSL alignment, size, member offsets, array stride, and matrix stride. A
  layout carries no address space; each buffer binding carries `uniform` or `storage`, and the
  compiler validates that use separately without inserting address-space-dependent padding.
- For a runtime-sized layout, `layout.minimumSize` is the fixed prefix with zero trailing elements;
  the buffer binding's `minimumBindingSize` adds one complete element stride and any enclosing
  structure padding. The runtime validates the effective binding range against the latter, the
  backing allocation and `UInt32`, and Metal's four-byte storage-buffer alignment. The range need
  not be a multiple of the runtime element stride.
- WGSL environment language features are explicit semantic capabilities and are validated before
  reflection. `uniform_buffer_standard_layout` participates in logical, program, and semantic
  fingerprints, but never in Metal device requirements. The compiler does not infer it by retrying
  a failed parse or validation.
- The `vgpu-native-program/v1` fingerprint hashes a canonical value containing the domain itself,
  referenced WGSL input IDs and content hashes, `layoutModel`, the resolved language-feature set,
  executable program semantics and capabilities, and only the transitively reachable types and
  intrinsic layouts. It excludes its own fingerprint, redundant source IDs, Swift presentation
  names, and source spans. Feature, language-feature, visibility, and entry binding-ID sets are
  sorted before `JCS-RFC8785+VGPU-PATHS-v1` canonicalization; ordered arrays retain their order.
  Referenced WGSL bytes and reachable semantics change the fingerprint; unreachable declarations
  do not.
- Generated Swift and TypeScript packers consume the reflected semantic layout rather than Swift
  `MemoryLayout` or TypeScript's current layout calculator. They reject invalid shapes, fixed-array
  counts, integer values, ranges, and runtime extents before mutation; write little-endian scalars
  and column-major matrices; and zero padding. WGSL `f16` conversion uses IEEE 754 binary16
  round-to-nearest, ties-to-even. Quiet-NaN class is portable; NaN payload bits are not a value
  contract.
- C2 demonstrated the intrinsic layout through an independent Swift packer and Metal compute
  readback. The current TypeScript `naga-standard` calculation diverges for four small uniform
  canaries, including a valid four-byte root struct that does not require
  `uniform_buffer_standard_layout`. Replacing that public layout identity and implementation with
  `wgsl-host-shareable-v1` is an implementation prerequisite, not an alternative native contract;
  no compatibility alias is planned.
- WGSL overrides are selected and substituted before WGSL-to-MSL translation. V1 records their
  declarations, evaluated defaults, selected values, and compute workgroup dimensions only as
  resolved positive integer `x`, `y`, and `z`. Literal-versus-expression provenance and override
  dependency lists remain in the referenced WGSL inputs instead of becoming runtime contract data.
  V1 exposes no Metal function-constant or runtime-specialization contract. Configuration keys are
  validated against the module and remain valid when unused by a selected entry point. Before any
  lowering or pruning, every statically used declaration without an initializer must be supplied.
  Configured values are then substituted before omitted initializers are evaluated. The semantic
  program records the union of the selected entries' static typed sets, and each translation request
  contains the exact static subset for that entry. Later compiler pruning does not redefine this
  interface.
- Compare-runner metadata lives under `projection.testing`, uses the explicitly Metal-specific
  `vgpu-native-metal-runner/v1` protocol, and is excluded from runtime compatibility.
- The runtime-projection fingerprint covers the shader-interface model and exact vertex-attribute
  and fragment-color maps, as well as the storage-buffer-size model, every per-program stage region,
  and the shared `immediate-data` physical slot. Concrete range bytes, packed table words, derived
  word count, upload padding, and upload strategy are runtime state and stay outside the artifact and
  fingerprints. Shader-interface-model support is unconditional; storage-size-model support is
  required only when the selected program stage has a size region.
- Generated packages use `.upToNextMinor(from:)` for remote package dependencies during `0.x`.
  Runtime ABI integers remain authoritative for artifact compatibility; package version selection
  separately limits Swift source and binary drift.
- Artifact format requirements contain only formats fixed by shader semantics. Sampled texture and
  render-target formats, sample counts, and render state are runtime inputs.

## Accepted architecture

- Runtime features are independent products with explicit imports. There is no umbrella module and
  no `@_exported import` shortcut.
- `VGPURender` contains Effect and Draw for the first implementation. `VGPUCompute` is a sibling
  product rather than a Render dependency.
- `_VGPUBackendSPI` is package-only and separates core, resource, render, and compute capability
  protocols. C0 proved that their Metal conformances must live in physical capability targets;
  separate files in one target retain every witness graph even under full LTO.
- Applications select additive, backend-complete SwiftPM products: `VGPUMetal` for Core,
  `VGPUMetalResources`, `VGPUMetalRender`, and `VGPUMetalCompute`. These products contain multiple
  targets but introduce no umbrella module. Selecting Render and Compute together forms their
  union and deduplicates Core and Resources. `VGPUMetalInterop` incorporates the Resource stack;
  `VGPUMetalKit` and `VGPUSwiftUI` incorporate the Render stack.
- The negative-import matrix in [architecture](./architecture.md#negative-import-matrix) is a CI
  contract, independent of measured byte size.
- `VGPUMetalInterop` is the opt-in leaf for `MTLBuffer` and `MTLTexture` import and inspection. It
  returns backend-neutral resource wrappers rather than exposing native types through shared
  Render or Compute modules.
- The synchronized imported-resource identity registry belongs to `VGPUMetal`; the main-actor
  borrowed-`MTKView` registry belongs to `VGPUMetalKit`. One exact Metal resource may have one live
  wrapper. Closing prevents new work immediately, but its claim remains until every encoded use
  completes; handoff is close, `settled()`, then re-import. Native aliases outside vgpu remain the
  caller's responsibility, and untracked-hazard resources are rejected in v1.
- `VGPU.metal(commandQueue:)` complements the default and device constructors. It retains an
  application-owned queue and derives its device, allowing host and vgpu command buffers to share
  explicit enqueue order. It does not expose one command buffer to both systems, observe host work
  through `settled()`, or synchronize other queues.
- `VGPUSurface` is the non-`Sendable`, backend-neutral semantic handle in `VGPURender`.
  `VGPUMetalKit` owns its `@MainActor` factory and adapter; the shared surface type has no global
  actor annotation or platform object in its public API.
- One generated package and `.metallib` is the shader-payload boundary. Selecting fewer runtime
  products does not strip unused functions already packaged in that `.metallib`; independently
  distributed features use separate configurations.
- The C0 release fixture is now a regression contract. A unified Metal target retained Core,
  Resources, Render, and Compute even in a Core-only consumer; physical implementation targets
  retained exactly Core for Context, Core + Resources + Render for Effect, and Core + Resources +
  Compute for Compute. Runtime registration and `@_exported import` are unnecessary.
- `VGPUScene` ports the pure CPU mesh generators to Swift, one primitive per source file. Generated
  mesh blobs are conformance goldens, not production payloads; this preserves runtime-parametric
  recipes and feature-level linking.
- Hardware support is a release-evidence matrix, not a public capability tier. Shared APIs and
  artifacts contain no CPU-architecture, GPU-vendor, or Apple-silicon mode; actual `MTLDevice`
  capabilities and resource or pipeline creation remain authoritative. The implementation does not
  assume unified-memory coherence. An `x86_64` cross-build is useful portability evidence but
  cannot establish Intel or AMD runtime support.
- Native builds use one vgpu-owned, statically linked `vgpu-tint-compiler` executable built from an
  immutable Dawn/Tint revision. Backend-neutral semantic extraction happens before each Metal
  translation request and is not duplicated in its response. The wrapper accepts one fully resolved
  entry point plus the versioned direct Metal slot map allocated by vgpu, validates the relevant
  resources and override types through Tint, and returns either a structured compiler failure or MSL
  with the selected entry, validated external slots, effective internal slots and size regions, and
  resolved compute workgroup dimensions. Stock `tint`/`tint_info`, `dump_shaders`, and Tint's
  convenience binding allocator are not production interfaces.
- The compiler worker uses one UTF-8 JSON request on stdin terminated by EOF and one UTF-8 JSON
  response on stdout terminated by EOF. A decoded `ok: false` response is a handled compiler result;
  nonzero process exits are reserved for framing, transport, decode failure, or a crash. The
  prototype's typed-argument `0`/`1`/`2` convention is not this production transport contract.
- Current resolved-source provenance is deliberately module-precision. A Tint WGSL diagnostic may
  name the resolved virtual source range and, only when proven, its authored input module; it cannot
  claim an authored line or column. Inspect, lower, and generate failures carry no invented location.
  Apple compiler diagnostics remain located in generated MSL unless a real WGSL-to-MSL map exists.
- The compiler distinguishes writer configuration from the effective projection. It supplies user
  slots and candidate internal reservations before Tint generation, including the shared immediate
  binding and size offset whenever reflection contains a runtime-sized storage type. Only Tint's
  final raised interface and writer result cause the effective
  `immediate-data` slot and size region to be serialized. This permits ordinary immediate data
  without a size region, runtime-sized storage without either emitted field, and both uses in one
  physical immediate block.
- When a selected stage has a size region, its sparse table places each runtime-sized storage
  binding's effective byte range at the word matching that binding's Metal buffer index. Fixed
  buffers leave zero holes and do not extend the table. Its derived word count is one past the
  highest runtime-sized projected slot. C1 verified multiple runtime buffers, sparse and
  deliberately dense counterexamples, range rebinding, shared backing buffers with different
  offsets, stage-local maps, and identical Metal readback through immediate and legacy UBO
  transports; immediate data is the accepted transport.
- Metal vertex streams use a versioned pipeline-local hybrid mapping. Shader and internal slots
  stay exact projection data; logical stream zero follows the highest occupied vertex-stage
  shader-buffer interval, and the full stream range must fit below the projection's exclusive
  external-buffer ceiling. The runtime-projection fingerprint covers the policy and ceiling. A
  pipeline-mapping change invalidates and rebinds every active physical vertex stream.

## Open decisions and spike results

1. Tint is the provisional semantic leader for WGSL-to-MSL translation, not a frozen source pin.
   C1 accepted all 223 expected-valid repository shaders; Naga 30.0.1 accepted 220 and fails the FFT
   pointer parameters plus `uniform_buffer_standard_layout`. The standalone follow-up proved that
   a vgpu-owned wrapper can return deterministic MSL, emitted names, reflected layouts, workgroup
   metadata, and exact slots without a WebGPU device. The binding-slot follow-up replaced Tint's
   automatic allocator with a deterministic vgpu map, verified complete intervals after lowering,
   and kept buffer, texture, and sampler namespaces independent per program and stage. The shared
   immediate-binding follow-up then proved ordinary immediates and the storage-size region can
   coexist in one physical binding, while post-generation output distinguishes the cases that emit
   only ordinary immediate data or no internal binding at all.

   The compiler-protocol follow-up then fixed the one-entry request/response boundary, relocatable
   virtual-source identity, module-only diagnostic attribution, exact typed override and resource
   checks, vgpu-owned emitted-name domain, and structured expected failures. It deliberately omits
   broad semantic reflection and ambiguous interface locations from the response. The override
   materialization follow-up then proved evaluated typed defaults and partial selections through
   Tint's lowered IR. It validates missing required values over the entry point's static override
   interface and substitutes module-level configuration before evaluating omitted initializers.
   It now preserves the exact static interface separately from its pruned effective evidence, binds
   every success to the resolved-source SHA-256, and feeds only that exact typed set to the compiler
   worker. The connected gate proves dependent reevaluation, bypassed invalid initializers, inactive
   required declarations, all five scalar kinds, and fail-closed stale-source and set mismatches.
   The worker materializes those values in Tint IR before entry pruning, then substitutes the
   surviving overrides with an empty map. Valid module configuration unused by one entry remains
   accepted. The spike's strict typed, finite scalar boundary is a local native contract, not a
   claim of complete WebGPU input-conversion parity. Its rich initializer/default metadata and
   pruned set remain local evidence rather than compiler-response surface.

   The C++ worker also owns the final one-request stdin/EOF JSON codec. Its transport gate covers
   framing and complexity limits, fragmented UTF-8, EOF, pipe backpressure, cancellation, timeout,
   and decoded protocol failures. A handled compiler failure remains an `ok: false` response;
   nonzero exit is reserved for an untrustworthy transport or process result.

   The runtime-size follow-up proved sparse slot-indexed packing for multiple runtime storage
   buffers, concrete binding ranges rather than backing-buffer lengths, derived extents, stage-local
   indices, range rebinding, immediate/UBO equivalence, and exact Metal readback on the available
   Apple-silicon machine. The buffer indices `29` and `30`, region offset `4`, and resource ceilings
   used by these fixtures are test inputs only. They are not public ABI constants or Metal
   device-limit claims.

   The vertex-buffer follow-up rejected a fixed partition in favor of the pipeline-local hybrid.
   It proved that Metal accepts a colliding vertex stream and shader argument, used readback to
   expose last-binding-wins aliasing, exercised the fixture's complete 31-entry table in a draw,
   and showed that a pipeline switch does not clear or remap existing vertex-buffer state. The
   fixture's numeric indices and conservative constant-argument budget are not public ABI or
   device-limit claims.

   The last locked direct-source revision built the worker from Tint's `tint_api` root for the macOS
   14 baseline. Its clean arm64 and x86_64 builds were byte-reproducible, combined into a
   deterministic universal executable, ran natively and through Rosetta, and matched the
   authenticated monolithic oracle byte for byte without linking WebGPU, runtime backends, or
   frameworks. That proof predates the semantic-interface handshake and is intentionally stale
   until its source lock and hashes are rebaselined against the current worker.

   The shader-interface follow-up captures the portable view before Metal lowering. Its isolated
   experiment established equivalent writer output, while the integrated production-path prototype
   now calls `Generate()` and inspects the same IR after Tint raises it. Its live Apple-silicon gate
   preserves sparse vertex attributes, inter-stage locations, sparse color outputs, and multiple
   render targets. It also proves that Metal accepted the tested same-type interpolation mismatch and
   that tested pipeline reflection did not reveal silently discarded fragment outputs. The internal
   protocol additionally proves paired dual-source lowering; the alpha still rejects that feature.

   Before freezing the dependency or numeric slot profile, pass offline `metal` plus `metallib`
   compilation, rebaseline the direct-source proof, add authored spans beyond the current
   module-only diagnostic attribution, run the full shader corpus through the exact direct worker,
   and pass deterministic connected artifact output and pixel/buffer parity. Semantic v1 has no
   WGSL resource binding-array (`binding_array`) cardinality, so the alpha rejects all resource
   binding arrays; the sampled-texture writer canary is future evidence only. Keep Naga only as a
   differential oracle.

2. C3a passed its hardened structural fixture: strict Ajv compilation and cross-schema resolution,
   deterministic assembly, every artifact and fingerprint relation, Swift tools and language mode
   6, macOS 14, clean native and `x86_64` SwiftPM builds without invoking Node.js, Tint, or Apple
   Metal compiler tools after generation, exact dependency and resource checks, and rejection of
   files outside the positive generated-output allowlist. Its runtime-array program additionally
   distinguishes layout and binding minima, records one shared immediate slot and stage region,
   keeps dynamic size data out of the artifact, fingerprints the complete static projection, and
   rejects malformed region-to-slot relationships and incompatible models before pipeline
   creation. A no-region program proves that storage-size model support is conditional on the
   selected program and stage.

   C3b was skipped because the optional offline Metal toolchain was not installed. When available,
   it links handwritten no-op and runtime-array Metal functions, but its fixture-local probe executes
   only the no-op path. It is not the compare runner, WGSL-to-MSL evidence, or evidence for runtime
   size-table upload. C3a now also carries a synthetic `SparseDraw` program and proves locations
   `3/7` and color indices `1/4` survive semantic/projection cross-validation, runtime
   fingerprinting, generated Swift, and arm64/x86_64 SwiftPM builds without compaction. C3 remains
   open until a real C1-connected artifact, production runtime and ABI package, supported toolchain
   and hardware matrix, and newest-generator to oldest-runtime consumption pass. One product
   decision also remains open: always emit the real compare runner, or emit it only when compare
   testing is enabled.

3. The exact Swift and Xcode patch-version matrix for macOS 14. Swift tools and language mode 6 are
   the candidate contract; C3 must compile and run generated packages with the minimum and current
   supported Xcode versions before the patch floor is published.
4. The first-alpha Metal format and limit matrix. A device probe must combine Metal-family tables,
   direct device limits, actual resource creation, and representative pipeline compilation. This is
   an empirical compatibility result; there is no user-facing API tie.
5. The Swift representation for sparse color attachments. Indexed records make the semantic slot
   explicit and remain extensible; a nullable positional array resembles WebGPU more closely. Both
   preserve holes correctly, so this is a public API choice rather than a compiler question.
6. The behavior when a shader writes a color location with no attachment. Metal silently discards
   the result. The safer proposal fails by default and requires explicit discard intent, while the
   permissive proposal follows Metal's omission behavior.
