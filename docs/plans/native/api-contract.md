# Native API contract

This document maps the existing vgpu model into Swift and records the generated-program contract.
See [architecture](./architecture.md) for product ownership and [decisions](./decisions.md) for the
accepted status of individual choices.

## API parity target

| JavaScript                      | Swift                                                                | Runtime responsibility                                                                                            |
| ------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `init()` / `initFromDevice()`   | `VGPU.metal()` / `VGPU.metal(device:)` / `VGPU.metal(commandQueue:)` | Select Metal explicitly; create a queue or retain one supplied for ordered host interop                           |
| `surface(gpu, canvas)`          | `gpu.surface(view)`                                                  | Borrow an `MTKView`; acquire and present drawables                                                                |
| `target(gpu, options)`          | `gpu.target(...)`                                                    | Own offscreen color and optional depth textures                                                                   |
| `effect(gpu, shader)`           | `gpu.effect(Program.self, ...)`                                      | Inject the fullscreen stage and own bindings                                                                      |
| `draw(gpu, options)`            | `gpu.draw(Program.self, ...)`                                        | Vertex/fragment program, geometry, and render state                                                               |
| `compute(gpu, source, options)` | `gpu.compute(Program.self, ...)`                                     | Compute pipeline, bindings, and dispatch                                                                          |
| `geometry(gpu, recipe)`         | `gpu.geometry(recipe)`                                               | Upload vertex and index data                                                                                      |
| `sampler(gpu, options)`         | `gpu.sampler(...)`                                                   | Own and cache sampler state                                                                                       |
| `frame(gpu, callback)`          | `gpu.frame { ... } -> VGPUSubmission`                                | One ordered logical submission; Metal v1 uses one command buffer and one queue commit                             |
| `frame.pass(target, body)`      | `frame.pass(target) { ... }`                                         | One render command encoder                                                                                        |
| `Frame.done`                    | `await submission.settled()` with a default `#isolation` parameter   | Wait without throwing for one logical submission and its deferred error delivery                                  |
| `drawable.set(values)`          | Generated `set` / `update` methods                                   | Preserve WGSL names and pack at reflected offsets                                                                 |
| `frameLoop(gpu, callback)`      | `VGPUView` / `VGPUViewDriver` from opt-in host modules               | Scheduling, clock advancement, resize, pause stay outside the context namespace                                   |
| `gpu.onError(callback)`         | `gpu.onError { ... }` with an `@isolated(any) @Sendable` handler     | Preserve the subscriber's actor, reject unsafe captures, and return an idempotent `@Sendable` unsubscribe closure |
| `gpu.settled()`                 | `await gpu.settled()` with a default `#isolation` parameter          | Snapshot known work, its completions, and corresponding error delivery without throwing                           |

Parity includes defaults, ordering, ownership, target signatures, and coded failures. Swift APIs
may use methods, key paths, throwing initializers, and scoped closures where those express the same
contract more safely.

## Platform support and capabilities

The first alpha's supported execution contract is macOS 14 or later on Apple silicon, running the
Swift application natively as `arm64`. Intel-based Macs and their Intel or AMD GPUs are not yet a
supported target. Cross-compiling the runtime and a generated sample for `x86_64` is useful
portability evidence, but it is not a runtime compatibility claim.

No public initializer selects an architecture or vendor tier. `VGPU.metal(...)` validates the
chosen `MTLDevice`, and `gpu.capabilities` reports the effective intersection of runtime,
projection, and device support. Packing, resource storage, synchronization, upload, and readback
behavior cannot depend on pointer width or unified-memory coherence. The same contract must remain
implementable by a future tested Intel, AMD, or non-Metal backend without changing generated
program semantics.

## Deliberate Swift differences

These differences are part of the contract rather than accidental drift:

| JavaScript behavior                                                                                                  | Swift behavior                                                                                                        | Reason                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A missing entry-point name selects the first stage match                                                             | A source with multiple compatible matches requires `entryPoints` at build time                                        | Generated types must have stable functions and bindings                                          |
| Bindings may stay unset until materialization fails                                                                  | Every binding is supplied when an instance is constructed                                                             | An unrenderable typed instance cannot exist                                                      |
| The first `set` chooses value- or resource-owned uniform storage                                                     | `Bindings` accepts either a value or `VGPUUniform<T>` at construction and preserves that ownership                    | Keep shared uniforms without an untyped union                                                    |
| Frames can be created manually or callback-scoped                                                                    | The first Swift API exposes the scoped closure; captured frame/pass values become invalid after callback return       | Make command lifetime explicit; a later manual form can be added without changing the scoped one |
| `Frame.done` stays on the frame returned from `frame(...)`                                                           | A successful frame returns a discardable, `Sendable` `VGPUSubmission`                                                 | Preserve per-submission completion after the callback-scoped frame becomes invalid               |
| One-shot effect, draw, and dispatch calls return `void`                                                              | Successful Swift one-shots return a discardable `VGPUSubmission`                                                      | Extend the same scoped completion primitive to work that has no frame value                      |
| Today's `gpu.settled()` can omit a plain one-shot or compute queue completion unless another tracked fence covers it | Swift registers every vgpu submission in the context snapshot                                                         | Make the context-wide wait complete and consistent across submission forms                       |
| A one-shot draw or dispatch can submit independently while a JavaScript frame callback is active                     | Swift rejects one-shot submission while `gpu.frame` is active                                                         | Prevent an accidental nested command buffer whose work is not part of the visible scope          |
| Errors are dynamic objects with string codes                                                                         | Extensible `VGPUErrorCode` static values preserve shared `VGPU-*` raw codes; native-only failures use `VGPU-NATIVE-*` | Swift ergonomics while opt-in modules can add codes without making Core depend on them           |
| A target can be bound directly and follows resized textures                                                          | Swift also binds `VGPUTarget` directly; `target.color` is a concrete generation snapshot                              | Preserve resize behavior and make the safe path obvious                                          |

Effect behavior is not a difference: both runtimes inject the full-screen vertex stage only when
the resolved shader has no authored vertex entry point. Native build requires an explicit authored
vertex selection when more than one exists.

## Runtime ownership contract

- `VGPU` and live objects created from it are non-`Sendable` and stay in one application-selected
  isolation domain. Public encoding remains synchronous inside that owner.
- A context-wide, non-blocking access gate permits reentrant calls in one synchronous stack and
  throws `VGPU-NATIVE-CONCURRENT-ACCESS` when another thread overlaps encoding, resource work, or
  lifecycle mutation. Immutable snapshots, `gpu.onError`, its unsubscribe closure,
  `gpu.settled()`, and `VGPUSubmission.settled()` use a separately synchronized, non-throwing
  control lane. That lane may overlap gated work; it does not make the graph safe to share.
- Async methods on live objects accept
  `isolation: isolated (any Actor)? = #isolation`. They validate and register immutable work before
  suspending, then return a `Sendable` result to the caller's actor.
- Frames and passes are callback-scoped. Escaped values fail with stable closed-state codes, nested
  frames, passes, and one-shot submissions fail synchronously, and throwing from an open frame
  cancels that logical submission.
- A normally returning `gpu.frame` auto-submits and returns a discardable `VGPUSubmission`.
  `frame.submit()` returns the same stable token idempotently, and the one-shot effect, draw, and
  dispatch entry points return their own token. Even an empty normal frame commits one ordered
  submission and returns a token. A throw before submission produces no token. If a callback
  explicitly submits and then throws, the outer call still throws and the token is observable only
  when the callback saved the `frame.submit()` result.
- `VGPUSubmission` is `Sendable`. Its non-throwing
  `settled(isolation: isolated (any Actor)? = #isolation)` waits only for that logical submission and
  its deferred error deliveries. A serial or shared queue still makes it observe earlier queue
  commands before its own command buffer completes, without adopting their readbacks or error
  deliveries. Context-wide `gpu.settled()` tracks every vgpu submission and snapshots all known work.
  Work registration and the context snapshot are linearizable, so racing work is fully included or
  fully excluded.
- Error publication takes one atomic snapshot of active subscriptions. There is no backlog. A
  subscription added after close can observe only later publications from work accepted before
  close. Unsubscribe is idempotent and guarantees that a handler body which has not started when it
  returns will not start later; a running handler may finish and may unsubscribe itself.
- Core `dispose()` methods throw, close synchronously, and never wait for the GPU. They are
  idempotent after success, retain already submitted resources until completion, reject overlap
  with another gated operation, and leave error subscription and settlement available to drain
  known work. Main-actor host adapters can expose non-throwing disposal because they stop and
  serialize their own scheduler first.
- `VGPUMetalInterop` converts `MTLBuffer` and `MTLTexture` objects into context-owned neutral
  wrappers. Shared Resources, Render, Compute, and generated programs never expose Metal types.
- `VGPUFramePassResult` distinguishes `.encoded` from normal drawable `.unavailable` without using
  errors for a hidden or resizing window.

## Artifact contract to freeze first

`NativeArtifact` is a build manifest, not an extension of `ShaderSource`. One configuration
produces one generic envelope with one semantic contract and one selected projection:

```text
artifact
├── compiler, fingerprints, inputs, and generic file hashes
├── semantic: vgpu-native-semantic/v1
└── projection: vgpu-native-metal-projection/v1
    └── testing.runner: vgpu-native-metal-runner/v1
```

The root `files` array contains only `path`, `size`, and `sha256`. Platform-specific file
roles and references stay in the projection. The singular `projection` field is intentional: v1 emits one
backend and one `.metallib` for each configuration. A future backend uses the same semantic object
with its own separately versioned projection rather than adding Metal fields to the envelope.

The semantic contract records:

- module and generated Swift names;
- `effect`, `draw`, and `compute` program records;
- authored and resolved WGSL entry points, stage inputs and outputs, built-ins, interpolation,
  invariance, and each entry's exact static override-name subset;
- WGSL binding names, groups, bindings, address spaces, access, active stages, resource shapes,
  sample and storage types, and sampler kinds;
- the `wgsl-host-shareable-v1` layout model and Tint-reflected intrinsic WGSL minimum sizes,
  alignments, field offsets, array strides, and matrix strides, independently of address space;
  every fixed or runtime array layout explicitly references the physical layout of its element,
  rather than resolving one by its logical type ID;
  `layout.minimumSize` covers the fixed prefix of a runtime-sized value, while a buffer binding's
  `minimumBindingSize` additionally covers one complete trailing element and any enclosing
  structure padding;
- typed override declarations, defaults, and selected values;
- positive integer compute workgroup dimensions resolved after override selection;
- explicitly enabled WGSL environment language features, separately from backend-neutral execution
  requirements;
- integer binding-layout, generated-Swift, and required `VGPUABI` contract versions.

Tint semantic reflection is the layout oracle. Uniform and storage are validated against the
intrinsic layout after reflection; they do not cause the compiler to pad or rewrite that layout.
In particular, `uniform_buffer_standard_layout` is an explicit build-time WGSL language feature,
not a Metal-device requirement. The compiler starts from the declared language-feature set and
never retries failed source with an additional feature enabled.

Semantic extraction is a separate build stage from Metal translation. It owns the backend-neutral
entry interfaces, bindings, intrinsic layouts, override declarations, and evaluated defaults used
to assemble this contract. The accepted compiler contract requires each per-entry translation
request to carry the exact semantic interface that the worker must match against Tint core IR before
Metal lowering. The response does not serialize that broad semantic reflection again. This exact
request/response handshake is integrated and has passed its C1 protocol gate.

Generated Swift and TypeScript packers consume the same semantic offsets. They require exact
vector, matrix, and fixed-array shapes; reject non-integral or out-of-range integers and invalid
runtime-array extents before mutating state; write matrices column-major and scalar values
little-endian; and initialize padding to zero. Conversion to WGSL `f16` uses IEEE 754 binary16
round-to-nearest, ties-to-even. A NaN must remain a quiet NaN, but its payload is not a cross-runtime
value contract.

A root runtime array remains `VGPUStorage<Element>`. A generated storage structure with a fixed
prefix and runtime-sized final array instead becomes a `VGPURuntimeArrayLayout` namespace with a
typed `Prefix`, `Element`, `VGPURuntimeStorage`, and `VGPURuntimeStorageBinding`. Allocation
`capacity` is immutable on the resource; each immutable binding view supplies an explicit
`elementCount`. Generated binding sets accept only the complete view, not the prefix or elements as
separate resources. This preserves simultaneous ranges over one allocation and keeps
`arrayLength()` tied to the command's count-preserving effective range. Minimum-size and four-byte
alignment padding is accepted only when the resulting WGSL length still equals the requested count;
otherwise that count is rejected. See
[Runtime-sized storage resources](./runtime/runtime-sized-storage.md).

Configured override values are substituted before omitted initializers are evaluated and before
WGSL-to-MSL translation. The semantic contract preserves every override declaration statically
used by a selected entry point, its available evaluated default, and its selected value. A compute
entry's `workgroupSize` contains only the resolved positive integer `x`, `y`, and `z`; whether an
axis was authored as a literal, constant expression, or override expression remains in the
referenced WGSL inputs and is not duplicated as dependency metadata. The contract does not describe
Metal function constants. Runtime specialization requires a future explicit API and artifact
revision.

The resolved WGSL name is the override's program-local identity. An authored numeric `@id`, when
present, is retained only as `wgslId` provenance; semantic v1 does not invent a parallel opaque ID.
Resolved names use the compiler request's ASCII identifier vocabulary. Programs store overrides in
strict ascending resolved-name order and require both resolved names and authored numeric IDs to be
unique within that program. Every entry point stores an `overrides` array, including `[]`, containing
its strictly ordered unique subset of those resolved names. The program array is the exact typed
union of all entry subsets.

The build configuration uses WGSL's single pipeline-overridable constant identifier string: the
canonical base-10 `@id` when one is authored, and otherwise the declaration name. The semantic
extraction request preserves that selector until Tint validates it; only the materialized result is
normalized to the resolved WGSL name. A name is not an alias for an authored ID.

Semantic extraction first resolves and type-checks every configured key against the WGSL module,
accepting a valid module-level value even when no selected entry point uses it. For each selected
entry point, every statically used override without an initializer must be configured before any
lowering or pruning. It then substitutes configured values and evaluates omitted initializers with
Tint: configuring an override bypasses that declaration's initializer, while a configured
dependency can change an omitted dependent value. The semantic program retains the canonical union
of the selected entry points' static typed sets; a module override unused by all selected entries is
omitted. Each translation request receives the corresponding exact static per-entry subset. Tint
may later prune initializer-only dependencies, but that optimization does not redefine either the
required interface or semantic v1. Evaluated-default extraction, partial-configuration ordering,
and the exact-static materializer-to-worker boundary have passed their C1 gates. The program-scoped
extraction wire now also passes against the source-built worker. Its nine locked requests cover
successful render, compute, fixed-resource, and runtime-sized storage interfaces plus five
exact-static override profiles.
The override profiles prove every supported scalar kind, selected and default values, authored
numeric IDs, canonical program unions and per-entry subsets, configured initializer semantics, and
resolved workgroup dimensions. The connected bridge carries fixed-size singular resources, one
runtime-sized storage program, and five exact-static override programs through semantic v1,
nominal program-level slot allocation, and exact per-entry compiler requests. Those resource and
override entries also pass deterministic native translation, authenticated program projection, and
offline Metal compilation and linking. It preserves binding and override subsets, sampling pairs, visibility, authored
presentation names, and reachable types/layouts; its allocation and final program fragment are
independently verified against that authenticated graph. Six override entry translations compile
and link without Metal function constants. One render program also passes an exact four-pixel
readback across two independent Metal processes, with two renders each, while the probe rejects
runtime function-constant APIs. The connected runtime-sized program also passes live compute
binding and readback in two M4 Pro processes: within each process, two dispatches reuse one backing
allocation and binding offset; effective ranges `28` and `52` upload `[0, 28]` and `[0, 52]`,
producing `[2, 202]` and `[4, 404]`.
A separate C2 vertical slice compiles generated `Bindings` in a module that depends only on
`VGPUABI`, then exercises `gpu.compute`, atomic key-path `set`, independent dispatch snapshots,
split Core/Resources/Compute backend capabilities, generation leases, disposal overlap, synchronous
submission rollback, and error delivery before settlement. Its connected Metal gate consumes the
authenticated C1 scratch artifact and reproduces those ranges and readbacks. This is isolated
evidence for the generated-compute and lifecycle contract, not a production artifact resolver or
runtime package.

A C3c connected-artifact fixture now begins with that real C1 WGSL-to-Tint result and carries its
authenticated semantic contract, Metal projection, runtime manifest, and `.metallib` into a
deterministic, relocatable SwiftPM package. The generated `AppShaders` module depends only on
`VGPUABI`; a clean consumer selects `AppShaders` and the backend-complete `VGPUMetalCompute`
product. The descriptor and library are private package resources loaded as owned bytes through an
underscored generated witness, so no public `Bundle`, URL, path, or caller-supplied loader closure
is introduced. The runtime checks both embedded SHA-256 digests, exact descriptor shape, ABI and
model identities, semantic/projection/runtime-manifest relationships, and exact Metal reflection
before dispatch. Two independent native processes reproduce `[2, 202]` and `[4, 404]`; six
fail-closed negatives cover tampered library bytes, crossed descriptor bytes, rehashed unsupported
ABI and model values, a rehashed unknown root field, and a rehashed non-empty sampling-pair set. The
post-generation package remains relocatable and builds with Node.js, Tint, and Apple Metal tools
poisoned. Its `x86_64` build is compile-only evidence.

This closes the C1-to-package-to-runtime join for one fixture, not C3 or a production
resolver/runtime contract. A separate C4 spike now carries two generated compute programs in one
artifact, matches its ping-pong storage results and writable-alias rejection against the public
WebGPU oracle, and keeps generated code on the `VGPUABI` boundary. The full distributable slice,
compare runner, supported toolchain and physical-hardware matrices, newest-generator to
oldest-runtime consumption, and production resource integration remain open.

The Metal projection records:

- macOS target, deployment version, the exact `metalCompilerTargetTriple` passed to Apple's Metal
  compiler, and Metal language version; this AIR/platform/deployment triple is not the Swift host
  CPU triple or a GPU-family support claim;
- the vgpu-owned `vgpu-tint-compiler` wrapper identity, immutable Dawn/Tint revision, executable
  hash, flags, and producing Apple toolchain;
- the single `.metallib` reference;
- emitted function names;
- the exact direct Metal buffer, texture, and sampler slots allocated by the versioned vgpu
  binding policy, including backend-internal bindings required by Metal lowering or the vgpu ABI;
- the versioned Metal immediate-data layout model, the independent storage-buffer-size model, and
  any per-program, per-stage regions placed inside an `immediate-data` internal binding;
- the versioned pipeline-local vertex-buffer policy and its exclusive external-buffer ceiling;
- the versioned shader-interface model and exact vertex-location to Metal-attribute and
  fragment-location to Metal-color mappings;
- resolved positive integer workgroup sizes, checked against the semantic contract;
- static Metal-device requirements;
- optional source maps;
- optional compare-runner metadata under `projection.testing`.

The semantic contract is the shader-interface oracle. It retains complete backend-neutral inputs
and outputs, including built-ins, semantic types, normalized interpolation and sampling,
invariance, and fragment-output roles. It validates vertex-to-fragment links before projection.

Metal projection v1 serializes a smaller stage-discriminated runtime interface. Vertex entries map
only user input locations to Metal attribute indices. Fragment entries map only user output
locations and optional blend-source indices to Metal color and source indices. Compute entries need
no physical I/O map. Built-ins, inter-stage varyings, interpolation, and invariance remain in the
semantic contract. Sparse locations remain exact and are never compacted. The v1 schemas reserve
the paired blend-source shape, and the internal compiler protocol allowlists and tests it. The first
alpha still rejects `dual_source_blending`; internal translator evidence is not product support. The
complete contract and canonical validation rules are in
[Native shader-interface contract](./compiler/shader-interfaces.md).

The production native compiler constructs the user binding map and configures candidate internal
capacity before translation, then passes that configuration to Tint. Compiler protocol v1 always
carries the required `vgpu-metal-immediate-data-layout-v1` identity, a stage-local
`immediate-data` candidate, and the model's storage-size offset: byte `4` for vertex and compute,
and byte `12` for fragment. These fields are fail-closed writer capacity, not proof that either an
internal binding or a size region is part of the emitted interface. The current profile reserves
`buffer(30)` as candidate capacity, but callers consume only the effective slot recorded in the
projection. Tint's final raised interface and writer result are authoritative. The
compiler records an `immediate-data` internal binding only when the generated entry uses it, and
records a `storageBufferSizeRegions` entry only when Tint reports that the selected stage needs the
size transport. It does not serialize a redundant `needsStorageBufferSizes` boolean.

The accepted production contract requires each translation request to contain one resolved virtual WGSL source, its module-precision origin map,
one selected WGSL and vgpu-owned emitted entry name, the exact statically used typed override set
after module-level configuration and required-value validation, declared language features, direct
external slots, the candidate internal profile, the immediate-data layout identity, the
storage-buffer-size identity and its stage-specific offset, and the exact semantic interface. The worker
compares the portable interface before calling `Generate()`. The official writer path preserves
Tint's `CanGenerate` preflight and performs Metal lowering and MSL generation on that same IR; the
worker then validates the complete lowered interface privately on the now-raised IR. A success
response is limited to the generated MSL, that entry identity, the validated external slots,
effective internal slots and size regions, the minimal runtime shader-interface projection, and a
resolved workgroup size for compute. Expected compiler failures use the structured error response
rather than a process failure.

The production worker framing is one UTF-8 JSON request on standard input terminated by EOF and one
UTF-8 JSON response on standard output terminated by EOF. Any decoded response, including
`ok: false`, is a handled request. Nonzero process exits are reserved for a framing or transport
failure, an undecodable request, or a crash; top-level CLI exit codes are a separate contract.

The binding-slot follow-up exercises that boundary without Tint's convenience allocator. Within
each semantic program and selected stage, active bindings are sorted by WGSL `(group, binding)` and
assigned contiguous intervals in independent Metal buffer, texture, and sampler namespaces.
Effective internal roles are emitted from reservations at the high end of their namespace. An
independent verifier reconstructs the same allocation and rejects non-canonical, colliding, or
overflowing maps.

After generation, the worker verifies that the expected Metal resource-class, index, and count set
exists in the raised wrapper. It does not independently recover each source `(group, binding)`
identity from that wrapper. The association relies on Tint's `BindingRemapper`, and a successful
response reserializes the requested source-to-slot map after its independent pre-generation
validation. This is an explicit trust boundary, not reflected identity evidence.

Vertex-stage shader buffers and runtime vertex streams share one Metal buffer namespace. The
selected policy keeps shader and internal slots exact in the artifact, records an exclusive
external-buffer ceiling, and derives only the vertex-stream map with the active pipeline. Logical
stream zero starts at the maximum end of the vertex-stage shader-buffer intervals, later streams
are contiguous, and the complete range must not cross the ceiling. This uses interval ends rather
than binding count, so sparse shader slots remain deterministic without reserving a fixed vertex
partition.

`runtimeSized` remains a semantic layout fact and does not imply a size region. When a selected
program stage does contain such a region, the runtime derives its word count as one past the
highest Metal buffer index of every runtime-sized storage binding projected into that stage. Word
`i` contains the concrete byte range bound at Metal `buffer(i)`; holes and non-runtime bindings are
zero, and higher fixed-size buffer slots do not extend the region. The region shares the stage's
single `immediate-data` slot at the artifact-recorded byte offset. Binding ranges, packed words,
derived word count, upload alignment, and upload strategy are dynamic runtime state and are not
serialized or fingerprinted. The multi-buffer allocator and Metal readback canaries have verified
this sparse slot-indexed rule, rebinding to new ranges, and equivalence with Tint's legacy UBO path.

The semantic v1 contract carries no WGSL resource binding-array (`binding_array`) cardinality, so
the first alpha rejects every resource binding array during `native check`.
A sampled-texture array accepted by the pinned Tint writer remains future translator evidence, not
a supported v1 binding.

Render target formats, sampled texture formats, sample count, blend and depth state, and geometry
remain instance or target state. Artifact format requirements include only formats fixed by shader
semantics, such as a storage-texture format. Runtime effective capabilities are the intersection of
the runtime implementation, compiler projection, and actual device. Family and format tables allow
preflight, but final Metal resource and pipeline creation remains authoritative.

Logical inputs, semantic data, manifests, and generated Swift must be reproducible. The `.metallib`
is an opaque Apple toolchain result, so its hash proves payload integrity without promising
byte-for-byte reproducibility across toolchains. The root manifest hashes every generated payload
except itself and the output-ownership marker.

The `vgpu-native-program/v1` SHA-256 includes its domain in the canonical preimage rather than
using the domain only as an adjacent label. Its exact logical value is:

```text
{
  domain: "vgpu-native-program/v1",
  layoutModel,
  sources: [{ id, sha256 }],
  languageFeatures,
  program,
  types,
  layouts
}
```

`sources` contains each referenced WGSL input ID and content hash, sorted by ID. `program` contains
the executable semantic program and its capabilities, but omits `fingerprint`, the redundant source
ID list, every `swiftName`, source spans, and optional interface-value diagnostic names. Other
semantic `name` fields remain in the preimage. `types` and `layouts` contain only the complete
transitive closure reachable from that program's bindings and entry-point interfaces. Arrays that
represent `features`, `languageFeatures`, `visibility`, or an entry point's binding-ID or
override-name set are sorted before canonicalization; ordered arrays keep their authored semantic
order. The value is serialized
with the artifact's `JCS-RFC8785+VGPU-PATHS-v1` canonicalization and then hashed. Consequently,
changing referenced WGSL bytes, `layoutModel`, an enabled language feature such as
`uniform_buffer_standard_layout`, executable program semantics, or a reachable type or intrinsic
layout changes the fingerprint. Adding an unreachable type or layout does not. The semantic
fingerprint still covers the complete semantic object, including presentation, provenance, and
unreachable declarations.

Generated output is checked against a positive path plan, not accepted merely because every file
appears in `files`. The plan permits the package manifest, exact generated Swift sources, the one
projected `.metallib`, and conditional generated runner or test sources. `artifact.json` and the
output-ownership marker are the only unhashed exceptions. Unknown files or directories, path and
case-folding collisions, links, special files, intermediates, source shaders, translators, package
resolution state, and build state are rejected.

Generated Swift embeds the semantic contract and a separately fingerprinted runtime subset of the
Metal projection. That runtime fingerprint includes the semantic fingerprint, Metal ABI and
binding and shader-interface models, the immediate-data layout model, deployment target,
`.metallib` hash, emitted names, exact
vertex-attribute and fragment-color maps, vertex-buffer policy and ceiling, external and internal
slots, the storage-buffer-size model and stage regions, resolved workgroup sizes, and static device
requirements. Its projection-specific input does not directly add provenance, root inputs, source
maps, generated sources, tests, `projection.testing`, or any dynamic packed size value. The complete
semantic object still affects it transitively through the semantic fingerprint. An incompatible
runner blocks `native compare` only; it does not block application use.

Compatibility is determined by understood schemas, the named semantic-layout, binding,
shader-interface, immediate-data-layout, and vertex-buffer policy models, and integer ABI contracts.
Shader-interface-model support is required for every entry point. Support for an
immediate-data-layout model is checked only when the selected program and stage has an effective
`immediate-data` internal binding, whether or not it has a size region. Support for a
storage-buffer-size model is checked independently and only when that selected stage has a size
region. Both model identities remain serialized and fingerprinted even when a particular stage does
not require runtime support for them. The artifact requires the
small shared `VGPUABI` product and one ABI integer; the runtime advertises the integer range it
supports rather than comparing package release versions for exact equality. During `0.x`, generated remote package dependencies use
`.upToNextMinor(from:)` so compatible patch releases remain selectable without admitting
minor-version source drift.

The contract family is:

- [Artifact envelope](./contracts/artifact-v1.schema.json)
- [Semantic contract](./contracts/semantic-v1.schema.json)
- [Metal projection](./contracts/metal-projection-v1.schema.json)
- [Metal runner request](./contracts/metal-runner-request-v1.schema.json)
- [Metal runner response](./contracts/metal-runner-response-v1.schema.json)
