---
title: Build and verify
summary: Validate the Metal toolchain, inspect deterministic build plans, and verify generated Swift packages.
websitePath: /native/macos/build
keywords: macos, metal, build, verify, doctor, ci, native artifact, json diagnostics
relatedSymbols:
  - resolveShader
  - effect
  - draw
  - compute
---

# Build and verify

Native tooling separates source validation, artifact generation, integrity checks, and pixel comparison. This page covers build and verification; [Compare WebGPU and Metal](/native/macos/compare) covers parity fixtures.

> Warning: This page preserves the superseded Swift runtime proposal, not the current command
> contract. For WGSL and direct Metal integration, use
> [Build and verify a Metal package](/native/macos/metal/tooling/build). The additional commands,
> flags, runtime packages, and automatic recovery described below are not release commitments.
> No native command is published yet.

## Check the build machine

Run `doctor` once when preparing a machine or diagnosing a toolchain failure:

```sh
npx vgpu native doctor --target macos
```

`doctor` checks Node.js, Xcode, the selected macOS SDK, and the Metal tools. Its final probe compiles and links a minimal shader; finding an executable on disk does not prove that Xcode's downloadable Metal toolchain is installed and usable.

The first alpha's supported build-host matrix is Apple silicon with macOS 14 or later. `doctor` verifies installed tools; it does not turn that release-support boundary into a shader capability or a runtime architecture block.

The command does not require `vgpu.native.json` and does not modify the project.

## Choose a project command

| Command               | Writes the configured output | Compiles Metal shaders | Purpose                                                                                                                    |
| --------------------- | ---------------------------: | ---------------------: | -------------------------------------------------------------------------------------------------------------------------- |
| `native plan`         |                           No |                     No | Resolve configuration and list every logical input and expected output.                                                    |
| `native check`        |                           No |                     No | Validate configuration, WGSL modules, entry points, layouts, names, and support in the installed compiler/runtime version. |
| `native build`        |                          Yes |                    Yes | Translate programs, compile the Metal library, and atomically exchange the generated package.                              |
| `native dev`          |                          Yes |                    Yes | Watch the complete source graph and rebuild changed programs.                                                              |
| `native verify`       |                           No |                     No | Check file hashes, compiler/runtime compatibility, and the current logical input fingerprint.                              |
| `native inspect`      |                           No |                     No | Print normalized program, binding, entry-point, layout, and artifact metadata.                                             |
| `native capabilities` |                           No |                     No | Report the compiler/runtime set or its effective intersection with a local Metal device.                                   |
| `native compare`      |          Test artifacts only | Uses an existing build | Render a fixture through WebGPU and Metal and compare normalized results.                                                  |

Project commands read `./vgpu.native.json` from the current directory. They do not search parent directories. Name another file explicitly in a monorepo:

```sh
npx vgpu native build \
  --config ./apps/example/vgpu.native.json
```

`native build` writes a complete sibling staging directory and touches the configured output only after every program succeeds. The first build renames staging into the empty destination. Later builds use macOS `renameatx_np` with `RENAME_SWAP | RENAME_NOFOLLOW_ANY`, so Xcode and SwiftPM see either the previous complete package or the new complete package without a missing-directory window. The old package is removed from the staging name after the swap; a later mutating command cleans an orphan left by a crash.

The staging directory must be on the same volume, and replacement fails without modifying output when that volume does not advertise atomic directory-swap support. Read-only commands never recover or clean output; they report an interrupted-state error with the next safe `build` or `dev` command.

The configured output is a destructive boundary, so the tool owns it only after writing a `.vgpu-native-output.json` marker tied to this configuration. `check` and `build` reject filesystem roots, the home or configuration directory, any ancestor of an input, symlinked output paths, and existing non-empty directories without a matching marker. There is no force flag that bypasses those checks; choose an empty directory or move unrelated files yourself.

## Inspect before writing

Use `plan` when reviewing a new configuration or when an agent must understand the build without changing the worktree:

```sh
npx vgpu native plan --json
```

The plan includes:

- normalized configuration and Metal compiler target triple;
- every entry WGSL file and resolved module dependency;
- selected program kinds, entry points, overrides, and WGSL language features;
- expected Swift, manifest, library, and source-provenance outputs;
- the separate logical-source and toolchain-sensitive build fingerprint inputs, including the semantic layout model, binding-slot ABI, immediate-data layout model, storage-buffer-size model, and compiler identities;
- capabilities that the build requires.

It contains no timestamp or absolute path. Two equivalent checkouts using the same native compiler, `vgpu-tint-compiler` binary and pinned Dawn/Tint revision, SDK, flags, Metal compiler target triple, and generated ABI produce the same application build plan after paths are normalized relative to the configuration directory. A toolchain change keeps the logical-source fingerprint but changes the build fingerprint and forces regeneration.

When a compare runner is present, its separate runner-build fingerprint and cache key additionally include the artifact manifest SHA-256, Metal-runner ABI, Swift runner target triple, and Swift toolchain. Runner incompatibility invalidates or blocks compare without changing whether the application artifact itself is compatible.

## Validate without compiling Metal

`native check` resolves the same source graph as `build` and rejects invalid programs before invoking platform tools:

```sh
npx vgpu native check
```

`check` exercises the same resolver, semantic-materialization, and `vgpu-tint-compiler` boundaries as `build`, but stops before Apple's `metal` and `metallib` tools and does not write an artifact.

It verifies:

- JSON Schema and safe output boundaries;
- WGSL parsing, imports, pure modules, and reflection;
- explicit selection when a source has multiple compatible entry points;
- typed overrides and resolved positive integer workgroup sizes;
- intrinsic `wgsl-host-shareable-v1` layouts and generated Swift identifiers;
- address-space constraints under the explicitly selected WGSL language features;
- stage interfaces and active resources;
- the versioned vgpu Metal slot map, immediate-data layout model and stage offsets, effective internal slots, and any compiler-emitted storage-buffer-size regions;
- support in the capability set reported by the installed native compiler and matching runtime version.

Tint supplies the reflected type layout. It does not decide whether vgpu changes that layout for a uniform: intrinsic offsets and strides remain address-space neutral, and validation either accepts or rejects the use. `uniform_buffer_standard_layout` and every other environment feature must be present in the configuration before validation starts. `check` does not retry failed source with additional features.

An unsupported static feature fails with `VGPU-NATIVE-FEATURE-UNSUPPORTED`. `check` cannot certify the Metal device on an end user's machine. The semantic contract records build-time language features separately from backend-neutral execution requirements, while the Metal projection records only device requirements fixed by shader semantics, such as a storage-texture format. Sampled texture formats, render targets, sample counts, and render state remain runtime inputs.

WGSL resource binding arrays (`binding_array`) are unsupported in semantic contract v1 and fail with `VGPU-NATIVE-FEATURE-UNSUPPORTED` during `native check`, before semantic emission or Metal projection. Arrays inside uniform or storage-buffer values are a different feature and remain supported; their type layout belongs to semantic reflection rather than resource-binding cardinality.

At runtime, effective capabilities are the intersection of what the runtime implements, what the selected compiler projection can express, and what the actual `MTLDevice` supports. Known family, format, sample-count, and limit checks provide early failures, but Metal has no universal query for every format-and-usage combination. Final resource and pipeline creation remain authoritative. Neither `check` nor the runtime removes a binding, changes a format, substitutes a shader stage, or silently chooses a different entry point.

## Build and develop

Generate the local package:

```sh
npx vgpu native build
```

Keep it current while editing WGSL:

```sh
npx vgpu native dev
```

The build first derives backend-neutral semantics from the resolved source. That stage owns entry-point interfaces, intrinsic layouts, resource declarations, typed override defaults, and resolved compute workgroup dimensions. It validates configured keys at module scope and required values against each selected entry point's static interface, then substitutes configuration before evaluating omitted initializers. It materializes the canonical union of the entries' exact static typed sets before translation; raw WGSL initializer text is provenance, not a value parser input. Workgroup axes are stored only as resolved `x`, `y`, and `z` values, without duplicating their authored expressions or override dependency lists.

The build then invokes `vgpu-tint-compiler`, a vgpu-owned build-time executable linked from a pinned Dawn/Tint source revision. The accepted production contract requires each selected entry-point request to carry resolved WGSL, the materialized typed overrides, the exact semantic interface, the explicit language-feature set, a stable emitted function name, vgpu's versioned external Metal slot map, its reserved internal profile, `vgpu-metal-immediate-data-layout-v1`, and the independent `vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1` model with the layout-fixed storage-size offset: byte `4` for vertex and compute, or byte `12` for fragment. The worker compares that interface with Tint core IR before calling Metal `Generate()`. This preserves Tint's `CanGenerate` preflight and performs Metal lowering and MSL generation on the same IR; after generation, the worker privately validates the complete lowered interface on that now-raised IR. It returns either a structured compiler error or generated MSL with the selected entry point, the unchanged validated external slot map, effective internal slots, storage-buffer-size regions, the minimal stage-discriminated Metal interface map, and resolved compute workgroup dimensions. It does not return semantic layouts, override declarations, defaults, or broad interface reflection. Tint's automatic slot allocator is not used as the artifact contract.

The internal production worker protocol carries one UTF-8 JSON request on stdin, terminated by EOF, and exactly one UTF-8 JSON response on stdout, also terminated by EOF. A response with `ok: false` is a handled compiler result. Nonzero process exits are reserved for framing or decode failures, crashes, and other transport failures; they are not the compiler-error channel.

The map is deterministic per semantic program, selected stage, and Metal buffer, texture, or sampler namespace. Required backend-internal resources use explicit reservations and cannot shift a user slot silently. After generation, the worker checks that the expected resource-class, index, and count set exists in the raised wrapper. It cannot independently recover each original WGSL binding identity there: that source-to-slot association relies on Tint's `BindingRemapper`, and the response reserializes the independently validated requested external map. The generated result decides which reserved internal bindings and size regions are emitted, and the projection retains that effective result. Storage sizes share the stage's `immediate-data` slot instead of occupying a second buffer. The projection also records a versioned `vertexBufferPolicy` with an exclusive external-buffer ceiling and a `shaderInterfaceModel` whose sparse vertex-attribute and fragment-color maps remain exact. Changing either of those models, an interface index, the slot ABI, the immediate-data layout model, the storage-buffer-size model, a recorded region, or its immediate-data slot invalidates the build and runtime-projection fingerprints. Concrete ranges and packed size words are runtime data and do not.

Apple's compiler then compiles that source with `metal -std=macos-metal2.4` to AIR, and `metallib` links the packaged library. The Apple compiler invocation is the MSL 2.4 gate; the Tint writer does not switch its output dialect from that flag. Node.js, `vgpu-tint-compiler`, Tint, source WGSL, generated MSL, and Apple build tools remain on the build machine and are not application runtime dependencies.

The watcher tracks imported modules as well as entry files. Changing a shared module rebuilds every affected program but preserves unaffected generated files when their build fingerprints did not change. A native compiler, wrapper binary, pinned Dawn/Tint revision, SDK, target, language-feature set, semantic layout model, immediate-data layout model, storage-buffer-size model, slot ABI, or generated ABI change invalidates every affected fingerprint.

Generated MSL and compiler intermediates belong to an inspectable build cache, not the application package. Use `--keep-intermediates` for a failed build when a platform diagnostic needs the generated source.

## Understand the current validation status

The C1 compiler-protocol fixture now combines the virtual resolver, direct Tint API, exact semantic-interface handshake, and vgpu-owned slot map without calling Tint's automatic allocator. Its per-entry translation response is deliberately narrow: MSL, the selected entry point, the unchanged validated external map, effective internal bindings and size regions, a minimal stage-discriminated Metal interface, and resolved compute workgroup dimensions. Fifteen positive and twenty-two negative native canaries cover stage-local resources, sparse WGSL groups, typed overrides, deterministic virtual-source diagnostics, multiple Metal resource namespaces, runtime storage sizes, bypassed initializers, inactive entries, exact sparse shader interfaces, dual-source lowering inside the internal protocol, and fail-closed mismatches. The worker compares the requested portable interface with core IR, calls `Generate()`, then validates the same IR after Metal lowering instead of treating the request as its own evidence. The alpha still rejects `dual_source_blending` before constructing this internal request.

The resolver now retains each authored entry declaration's exact token span with 1-based locations, UTF-16-code-unit columns, and an end-exclusive boundary. Tint diagnostics use a different coordinate system: their ranges point into resolved virtual WGSL and count columns in UTF-8 bytes. The origin map can add authored module identity when a complete diagnostic range lies within one proven segment, but it does not fabricate authored line or column positions. The override materializer validates missing required values over the static entry interface and substitutes configuration before evaluating omitted initializers. It preserves that exact static typed view separately from pruned effective evidence and binds every result to the resolved-source hash. A connected native gate projects the static view into the worker without parsing WGSL in JavaScript, rejects stale source and set mismatches before translation, and verifies the resulting workgroup dimensions. The fixture's strict typed, finite scalar boundary does not claim complete WebGPU input-conversion parity. The sampled-texture resource binding-array canary passes the isolated Tint writer and offline Apple compiler, but remains translator evidence only; resource binding arrays stay outside alpha because semantic v1 cannot carry their cardinality.

The connected fixed-resource gate now carries one render program with singular, fixed-size resources from authenticated semantic assembly through vgpu-owned slot allocation, both one-entry compiler requests, and one exact program projection. Allocation is nominally tied to the exact semantic assembly and independently verified before projection. Each compiler result is authenticated against its exact request; the combiner requires the complete selected stage set, preserves effective internal data only from the responses, and validates the resulting `$defs/program` independently. Buffer, texture, and sampler namespaces remain stage-local; sparse WGSL binding numbers are compacted by canonical order rather than copied into Metal indices. Both entries translate deterministically, and the two MSL sources compile to AIR and link into one metallib only after the nominal projection exposes them. The same nominal projection then derives the runtime layout used by one `MetalRenderProgram`; two independent Swift processes each validate the complete logical resource set before encoding and reproduce the same exact readback across two renders on Apple M4 Pro. This proves fixed direct-resource runtime binding for that fixture, not broader resources or the production Swift runtime.

The C++ worker owns the one-request stdin/EOF JSON codec and independently decodes the complete typed request before Tint runs. It dispatches translation or authenticated entry inventory from the exact `contractId`. The inventory returns canonical entry-point names and stages, including an empty result for a valid module with no entries. Its request identity is `SHA-256(UTF-8("vgpu-native-tint-entry-inventory-request-bytes/v1") || 0x00 || exact encoded request bytes)`; deterministic encoding sorts object keys without normalizing WGSL text. Four fixtures cover an empty module, a library-only module, invalid WGSL, and a multi-stage module. The separate codec gate covers framing and complexity faults, decoded protocol failures, fragmented UTF-8, EOF blocking, pipe backpressure, cancellation, timeout, and the documented size and depth boundaries. The internal-error and I/O-error exits remain unfault-injected.

The vertex-buffer follow-up establishes a pipeline-local mapping instead of a fixed shader-versus-geometry partition. It preserves artifact-fixed shader and internal slots, starts logical vertex streams after the highest occupied external shader-buffer interval, and rejects a range that crosses the recorded external ceiling. A deliberately colliding Metal pipeline still compiled, while order-sensitive readback exposed the alias; vgpu must therefore validate disjointness itself. Another canary switched between two mappings in one encoder and proved that every active vertex stream must be rebound when the pipeline mapping changes. The exact-capacity fixture used its complete 31-entry test table in a real draw. Its numeric partition and conservative constant-argument mix are fixture inputs, not public ABI or hardware-support claims. This runtime evidence comes from the current Apple-silicon machine; it does not establish Intel or discrete-GPU support. All three handwritten MSL fixtures also compile and link offline for the macOS 14 target.

The runtime-size follow-up validates multiple runtime storage buffers, sparse physical slots, stage-local packing, rebinding larger effective ranges, and equivalent immediate-data and legacy UBO results on the current Apple-silicon Metal runtime. For `buffer(i)`, word `i` is the effective bound range in bytes, and the region extends through the highest projected runtime-sized storage slot. Its generated MSL also compiles and links offline for the macOS 14 target.

The current locked direct-build revision compiles the C++ worker against Dawn/Tint commit `8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca`, declaring only `tint_api` as its link root. Its ordinary publication gate authenticates twenty-three oracle inputs and a twenty-three-canary request closure: ten translation requests, four entry-inventory requests, and nine semantic-extraction requests. The inventory branch proves empty-module and library-only success, structured invalid-WGSL failure, canonical names and stages for a multi-stage module, and request identity over the exact encoded bytes. The semantic branch covers successful render, compute, fixed-resource, and runtime-sized storage extraction plus five successful exact-static override profiles. The runtime canary preserves a fixed struct prefix, a trailing array of authored-size structs, the compiler-owned stride, an explicit element-layout edge, the zero-element layout minimum, and the one-element binding minimum. The override profiles preserve every supported scalar kind, selected and default values, authored numeric IDs, per-entry subsets, the canonical program union, configured initializer semantics, and resolved workgroup dimensions. Two clean Release builds for each of arm64 and x86_64 are byte-identical and combine into the same universal executable. The arm64 direct workers run natively and the x86_64 direct workers run under Rosetta; responses from all eight direct variants are byte-identical to the same arm64-native monolithic oracle. Their linked archive closure contains 44 Tint archives, nine Abseil archives, and `dawn_shared_utils`; the worker and JsonCpp translation units are linked directly. Those executables target macOS 14 and link no WebGPU implementation, runtime backend, or framework. Rosetta validates the x86_64 compiler process, not Intel or AMD GPU behavior, and the dual-source canary remains internal translator evidence rather than alpha support.

The isolated shader-interface follow-up validates twelve vertex, fragment, and compute entries and established equivalent writer output. The integrated worker uses `Generate()` to retain Tint's complete writer preflight, then inspects the same IR after Tint raises it. The fixtures preserve sparse vertex attributes, inter-stage locations, fragment colors, and multiple render targets. Live runtime gates passed on the available Apple M4 Pro. A negative pipeline shows that Metal accepts the tested same-type interpolation mismatch, and readback shows that a fragment output with no attachment is silently discarded. The semantic contract must therefore validate stage links instead of reconstructing them from tested Metal reflection. Attachment coverage belongs to target/pipeline validation, and its public failure policy remains open. This result does not establish Intel or AMD GPU support.

C1 now assembles ten semantic programs and ten nominal Metal allocations into fourteen exact compiler requests. Thirteen static response fixtures produce nine program projections; the runtime-sized request is deliberately left for the real worker because only Tint can establish whether its internal transport is effective. Fourteen independent verifier canaries protect the combined projection boundary. That compute program passes two byte-identical Tint translations, authenticated program projection, and offline AIR compilation and metallib linking.

The runtime-sized projection uses external `buffer(0)`, effective `immediate-data` `buffer(30)`, and a size region beginning at compute byte `4`. In each of two live M4 Pro processes, two dispatches reuse one backing allocation and binding offset with effective ranges `28` and `52`. They upload sparse immediate words `[0, 28]` and `[0, 52]`, then read back `[2, 202]` and `[4, 404]`. Reflection reports `buffer/0/16/4`, `buffer/1/8/4`, and `buffer/30/8/4` (`index/dataSize/alignment`). Eleven malformed manifests and four invalid preparations fail before dispatch.

An isolated C2 runtime-tail resource fixture now compiles the generated layout conformance from a separate SwiftPM package against only the public `VGPUABI` product. Its portable gate keeps immutable allocation capacity separate from immutable binding length, accepts a 52-byte logical resource at offset 16 inside an 88-byte backing allocation, preserves padding and surrounding bytes, and rejects count holes, arithmetic overflow, and `UInt32` overflow before mutation. The connected C1 gate then gives its authenticated scratch metallib and manifest to one additional typed Metal process, whose two immutable views reproduce ranges `28` and `52` and readbacks `[2, 202]` and `[4, 404]`. This validates the typed resource-to-Metal seam in isolation.

A second C2 fixture carries one external generated `VGPUComputeProgram` through the proposed split Swift runtime. The generated target depends only on `VGPUABI`; its witness supplies typed values at semantic ordinals and contains no Metal slots, transport model, or artifact URL. `gpu.compute` validates the complete binding set and creates the pipeline synchronously. `set` copy-validates before committing. Each `dispatch` snapshots its own bindings, acquires generation leases, registers work before entering backend submission, encodes and commits synchronously, and returns a `VGPUSubmission` whose asynchronous completion includes deferred `onError` delivery. A blocked-submit canary proves that a racing `gpu.settled()` sees the registered work before `submitCompute` returns. Synchronous submit failure removes that registration without publishing an asynchronous error; unobserved deferred failure produces one diagnostic without a backlog.

The connected C1 hook launches that generated-compute probe twice with the same authenticated scratch metallib and manifest and requires byte-identical reports. On the available Apple M4 Pro, both processes reuse one capacity-four allocation across two immutable views, upload effective byte ranges `28` and `52`, and read back `[2, 202]` and `[4, 404]`. The probe also checks the exact Metal reflection, physical size-word uploads, and release of the disposed allocation only after both accepted submissions settle. This closes one generated compute vertical slice, not the production package resolver or runtime, general readback ordering, or Intel and AMD GPU execution. A separate isolated C4 gate now carries two compute entry points through the same packaged boundary and matches ping-pong results plus writable-alias rejection against the public WebGPU oracle; production integration remains open.

Five exact-static override programs still project six entry-specific override sets into deterministic native translations and compile and link all six retained MSL sources without Metal function constants. One render program additionally passes an exact four-pixel readback across two independent Metal processes, with two renders each, while its hash-locked probe rejects runtime function-constant APIs.

C1 remains open for broader resource integration, the full shader corpus through that exact direct worker and Apple's offline compiler, the production Swift runtime, and broader pixel/buffer parity. Exact authored entry-declaration spans are available; general authored positions for Tint diagnostics remain limited to proven module identity. The reproducible fixtures live in `experiments/native-metal-spikes/c1-semantic-bridge`, `experiments/native-metal-spikes/c1-override-defaults`, `experiments/native-metal-spikes/c1-override-worker-integration`, `experiments/native-metal-spikes/c1-runtime-buffer-sizes`, `experiments/native-metal-spikes/c1-vertex-buffer-slots`, `experiments/native-metal-spikes/c1-compiler-protocol`, `experiments/native-metal-spikes/c1-tint-direct-build`, and `experiments/native-metal-spikes/c1-shader-io-projection`.

C3a passed the current structural artifact fixture. It assembles the generated package around intentionally invalid UTF-8 text whose filename ends in `.metallib`, then verifies deterministic output, schemas and hashes, compatibility checks, SwiftPM dependency and resource boundaries, clean consumer builds without invoking Node.js, Tint, or Apple Metal compiler tools after generation, and the positive generated-output allowlist. Its `Noop` program has neither an effective immediate-data slot nor a size region; its synthetic `RuntimeArray` program records a compute region and shared immediate-data slot. A synthetic `SparseDraw` program proves vertex locations `3/7` and fragment colors `1/4` survive semantic/projection cross-validation, runtime fingerprinting, generated Swift, and arm64/x86_64 package builds without compaction, and its fragment stage keeps an effective immediate-data slot without a size region. The fixture distinguishes the zero-element layout minimum from the one-element binding minimum, validates model-fixed region offsets and slot relationships, and keeps dynamic ranges out of the artifact. An unknown immediate-data layout model rejects the `SparseDraw` fragment because it has an effective slot; an unknown storage-buffer-size model still accepts it and rejects `RuntimeArray`, whose compute stage has a region. It resolves and hashes the sentinel through `Bundle.module`, but never passes it to Metal. C3a therefore validates the package and compatibility boundary, not a Metal library or shader execution.

C3b now passes with Apple Metal toolchain build 17C7003j. It compiles handwritten no-op and runtime-array Metal functions for `air64-apple-macos14.0`, links and packages one library, verifies the exact `Bundle.module` resource and hash, then executes the no-op pipeline with an exact `[0, 1, 2, 3]` readback on the Apple M4 Pro. The fixture-local probe still does not implement the compare request and response protocol, does not appear in `projection.testing`, and cannot prove that the recorded WGSL produced the MSL or that the runtime uploaded storage-size words.

The C3c connected fixture now closes that missing join for one runtime-sized compute program. It starts with C1's authenticated WGSL semantic and Metal projection, uses Tint-produced MSL and Apple's linked `.metallib`, and emits a deterministic, relocatable SwiftPM package containing an artifact descriptor and generated Swift. `AppShaders` depends only on `VGPUABI`; a clean consumer selects the backend-complete `VGPUMetalCompute` product. `Bundle.module` stays private behind an underscored generated witness that returns owned descriptor and library bytes, with no public URL, path, `Bundle`, or loader-closure API.

Before pipeline creation, the fixture validates descriptor and library SHA-256 digests, the exact descriptor shape, ABI and runtime-model identities, semantic and projection relationships, and exact Metal reflection. Two independent native processes reproduce readbacks `[2, 202]` and `[4, 404]`. Six fail-closed canaries reject altered library bytes, crossed descriptor bytes, a rehashed unsupported ABI, a rehashed unsupported runtime model, a rehashed unknown root field, and a rehashed non-empty sampling-pair set. A relocated package still builds after Node.js, Tint, and Apple Metal tools are poisoned. Its `x86_64` gate is compile-only and makes no claim about Intel execution.

C3c is fixture-specific evidence, not the production generator or runtime, and C3 remains open. The complete distributable slice, production `VGPUABI` and runtime packages, supported Xcode, macOS, and physical-hardware matrix, newest-generator to oldest-runtime consumption, and compare runner still need their gates. Packaging also remains undecided between always emitting the real compare runner and emitting it only when compare testing is enabled.

## Verify committed output

Commit the generated package when another machine must build the application without Node.js or the Metal compiler. Check it without regenerating:

```sh
npx vgpu native verify
```

`verify` does not write the configured output and does not invoke Apple's compiler. It fails when:

- a generated file is missing or its recorded hash differs;
- source or configuration inputs no longer match the logical fingerprint;
- the generated Swift API and `VGPUABI` contract are incompatible;
- the artifact schema is newer than the installed verifier;
- the selected program stage has an effective `immediate-data` slot whose layout model the runtime does not understand;
- the selected program stage has a storage-buffer-size region whose size model the runtime does not understand;
- the recorded platform or deployment target does not match the package.

The `.metallib` hash proves package integrity. It is not used as a reproducible-build oracle because the Metal library is an opaque Apple toolchain output.

## Compare WebGPU and Metal output

Pixel parity requires a separate Metal compare runner that implements the canonical fixture protocol. It is distinct from the fixture-local C3b probe. Its artifact metadata is optional, and the generator has not yet chosen between always emitting the runner and emitting it only when compare testing is enabled. See [Compare WebGPU and Metal](/native/macos/compare) for fixture structure, normalization, tolerances, and runner isolation.

## Inspect a generated program

Ask for the normalized contract instead of reading generated Swift:

```sh
npx vgpu native inspect Gradient --json
```

The result separates backend-neutral semantics from the selected Metal projection and includes:

- program kind and selected entry points;
- authored and generated function names;
- entry-point inputs, outputs, and active bindings;
- the `wgsl-host-shareable-v1` layout model and Tint-reflected intrinsic WGSL layouts;
- binding address spaces and access modes separately from their referenced layouts;
- enabled WGSL language features and their validation result;
- vgpu-mapped Metal buffer, texture, and sampler slots per stage, including explicit internal slots;
- the immediate-data layout model, storage-buffer-size model, stage-local region offsets, and shared immediate-data slots without dynamic size words;
- the vertex-buffer policy identity, exclusive external ceiling, and shader-derived stream capacity, without inventing a concrete stream map before a vertex layout exists;
- runtime-sized array zero-element prefixes, one-element minimum binding sizes, and element strides, without an allocation-specific runtime extent;
- baked override values and resolved workgroup sizes;
- semantic capabilities and static Metal-device requirements;
- artifact, semantic, projection, generated-Swift, and `VGPUABI` identities.

## Use structured output

Discovery and validation commands support `--json`:

```sh
npx vgpu native doctor --target macos --json
npx vgpu native plan --json
npx vgpu native capabilities --target macos --json
npx vgpu native capabilities --target macos --device system-default --json
npx vgpu native check --json
npx vgpu native inspect Gradient --json
npx vgpu native verify --json
```

A one-shot command writes one versioned JSON envelope to stdout and no ANSI control codes. Progress belongs on stderr.

```json
{
  "schemaVersion": 1,
  "ok": false,
  "command": "check",
  "error": {
    "code": "VGPU-NATIVE-FEATURE-UNSUPPORTED",
    "message": "Program ParticleDraw requires storage buffers.",
    "fix": "Upgrade @vgpu/native and the vGPU Swift products to compatible versions with storage-buffer support, or remove this program."
  }
}
```

These are public CLI envelopes and exit codes: `0` means success, `1` means the operation completed with a negative result, and `2` means the invocation itself was invalid. They are separate from the internal worker transport, where a decoded `ok: false` response is handled normally and nonzero exits indicate transport failure or a crash.

Resolver errors can point to an authored WGSL span. Authored entry declarations also retain their exact resolver-token spans with 1-based locations, UTF-16-code-unit columns, and end-exclusive boundaries. Tint parse and validation diagnostics instead point to resolved virtual WGSL and count columns in UTF-8 bytes; the current origin map can add authored module identity but cannot honestly recover its line or column. Inspect, lower, and generate failures do not invent a source location. Apple's compiler points to generated MSL unless a real WGSL-to-MSL source map is available.

## Add CI gates

When generated artifacts are committed, a macOS job can validate them without rewriting the worktree:

```sh
npx vgpu native check
npx vgpu native verify
swift test --package-path ./Generated/app-shaders
npx vgpu native compare \
  --fixture ./Fixtures/gradient-present.json \
  --out ./artifacts/gradient-present
```

Release validation also builds a clean sample application for the supported Apple silicon and macOS 14-or-later matrix. The application must start without Node.js, WebKit, the WGSL translator, Xcode, generated MSL, or source WGSL in its bundle.

Intel-based Macs and Intel or AMD GPUs are not alpha release targets. Add them only after the same distribution, capability, render, readback, and lifecycle gates pass on physical hardware; a successful compile or simple shader is not sufficient evidence.

Steady-state tests verify that no pipeline is created after warm-up, memory does not grow across repeated resize and create/dispose cycles, and borrowed `MTKView` state is restored only while the driver still owns it.

## Troubleshooting

| Error                                 | Cause                                                                                                       | Fix                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `VGPU-NATIVE-CONFIG-INVALID`          | Configuration fails its schema or contains a Swift name collision.                                          | Follow the reported JSON path and inspect the normalized plan.                                            |
| `VGPU-NATIVE-OUTPUT-UNSAFE`           | The configured output is too broad, symlinked, contains inputs, or is not owned by this configuration.      | Choose an empty dedicated directory; never force replacement of unrelated files.                          |
| `VGPU-NATIVE-OUTPUT-SWAP-UNSUPPORTED` | The output volume cannot atomically exchange two directories.                                               | Move generated output to an APFS volume that reports `RENAME_SWAP` support.                               |
| `VGPU-NATIVE-OUTPUT-INTERRUPTED`      | A read-only command found an orphaned staging directory from an interrupted swap cleanup.                   | Run the reported `native build` or `native dev` command; it validates markers before removing the orphan. |
| `VGPU-NATIVE-TOOLCHAIN-MISSING`       | The selected SDK or downloadable Metal toolchain cannot compile and link.                                   | Run `native doctor --target macos` and apply its reported fix.                                            |
| `VGPU-NATIVE-FEATURE-UNSUPPORTED`     | A program requires a resource, stage, format, or option unavailable in the installed compiler/runtime pair. | Inspect `native capabilities --json`; upgrade both packages together or remove the feature.               |
| `VGPU-NATIVE-MSL-COMPILE`             | Generated MSL failed Apple's compiler.                                                                      | Open the retained MSL location and use a WGSL span only when a real WGSL-to-MSL map provides one.         |
| `VGPU-NATIVE-ARTIFACT-STALE`          | Source or configuration no longer matches committed output.                                                 | Rebuild on a supported macOS build machine and commit the complete package.                               |
| `VGPU-NATIVE-ARTIFACT-INCOMPATIBLE`   | Manifest, generated Swift, Metal library, or `VGPUABI` contract do not agree.                               | Regenerate with a compatible native compiler/runtime release.                                             |
| `VGPU-NATIVE-METAL-UNAVAILABLE`       | No compatible Metal device is available.                                                                    | Render the view fallback or avoid constructing the renderer.                                              |
| `VGPU-NATIVE-DEVICE-UNSUPPORTED`      | The active Metal device lacks a required feature, format, sample count, or limit.                           | Read `gpu.capabilities`, choose supported runtime state, or use the fallback.                             |
| `VGPU-NATIVE-VIEW-INCOMPATIBLE`       | A borrowed view has a different device, invalid format/sample count, or occupied delegate.                  | Apply the named view requirement before creating or starting the driver.                                  |
| `VGPU-NATIVE-PIPELINE-CREATE`         | Metal rejected a pipeline for the requested program and target signature.                                   | Inspect the complete signature and verify the artifact before rendering.                                  |

## Next steps

- [Configure native programs](/native/macos/programs)
- [Use generated bindings](/native/macos/bindings)
- [Inspect generated artifacts](/native/macos/artifacts)
- [Compare WebGPU and Metal output](/native/macos/compare)
- [Compose effects, draws, compute, frames, and targets](/native/macos/rendering)
- [Integrate with SwiftUI and MetalKit](/native/macos/views)
