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
- WGSL overrides are selected and substituted before WGSL-to-MSL translation. V1 records their
  declarations, defaults, selected values, and resolved workgroup dimensions but exposes no Metal
  function-constant or runtime-specialization contract.
- Compare-runner metadata lives under `projection.testing`, uses the explicitly Metal-specific
  `vgpu-native-metal-runner/v1` protocol, and is excluded from runtime compatibility.
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

## Open decisions and spike results

1. Tint is the provisional semantic leader for WGSL-to-MSL translation, not a frozen dependency.
   C1 accepted all 223 expected-valid repository shaders through Tint/Dawn and real Metal pipeline
   creation. Naga 30.0.1 accepted 220: it cannot translate the FFT library's
   `unrestricted_pointer_parameters`, and it rejects the `uniform_buffer_standard_layout` canary
   that matches vgpu's current natural uniform-array stride. Keep Naga as a differential oracle,
   not the primary candidate. Before freezing Tint, build it standalone at a pinned Dawn commit,
   return MSL plus structured entry-point and slot metadata, and pass offline Apple compilation,
   authored-diagnostic provenance, determinism, and pixel/buffer parity. This remains an empirical
   integration gate rather than an API choice.
2. The exact Swift and Xcode patch-version matrix for macOS 14. Swift tools and language mode 6 are
   the candidate contract; C3 must compile and run generated packages with the minimum and current
   supported Xcode versions before the patch floor is published.
3. The first-alpha Metal format and limit matrix. A device probe must combine Metal-family tables,
   direct device limits, actual resource creation, and representative pipeline compilation. This is
   an empirical compatibility result; there is no user-facing API tie.
