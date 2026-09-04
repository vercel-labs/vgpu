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

> Warning: Native macOS support is a docs-first API proposal. The commands and output formats on this page are not implemented yet.

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
- the separate logical-source and toolchain-sensitive build fingerprint inputs, including the semantic layout model, binding-slot ABI, storage-buffer-size model, and compiler identities;
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
- typed overrides and workgroup sizes;
- intrinsic `wgsl-host-shareable-v1` layouts and generated Swift identifiers;
- address-space constraints under the explicitly selected WGSL language features;
- stage interfaces and active resources;
- the versioned vgpu Metal slot map, effective internal slots, and any compiler-emitted storage-buffer-size regions;
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

The build first derives backend-neutral semantics from the resolved source. That stage owns entry-point interfaces, intrinsic layouts, resource declarations, and typed override defaults. It evaluates defaults and materializes the exact active override set before translation; raw WGSL initializer text is provenance, not a value parser input.

The build then invokes `vgpu-tint-compiler`, a vgpu-owned build-time executable linked from a pinned Dawn/Tint source revision. For each selected entry point it receives resolved WGSL, the materialized typed overrides, the explicit language-feature set, a stable emitted function name, vgpu's versioned external Metal slot map, and its reserved internal profile. It returns either a structured compiler error or MSL with the selected entry point, the unchanged validated external slot map, effective internal slots, storage-buffer-size regions, and resolved compute workgroup dimensions. It does not return semantic layouts, override declarations, defaults, or broad interface reflection. Tint's automatic slot allocator is not used as the artifact contract.

The internal production worker protocol carries one UTF-8 JSON request on stdin, terminated by EOF, and exactly one UTF-8 JSON response on stdout, also terminated by EOF. A response with `ok: false` is a handled compiler result. Nonzero process exits are reserved for framing or decode failures, crashes, and other transport failures; they are not the compiler-error channel.

The map is deterministic per semantic program, selected stage, and Metal buffer, texture, or sampler namespace. Required backend-internal resources use explicit reservations and cannot shift a user slot silently. The generated result decides which reserved internal bindings and size regions are emitted, and the projection retains that effective result. Storage sizes share the stage's `immediate-data` slot instead of occupying a second buffer. The projection also records a versioned `vertexBufferPolicy` with an exclusive external-buffer ceiling; changing the slot ABI, that policy, the storage-buffer-size model, a recorded region, or its immediate-data slot invalidates the build and runtime-projection fingerprints. Concrete ranges and packed size words are runtime data and do not.

Apple's compiler then compiles that source with `metal -std=macos-metal2.4` to AIR, and `metallib` links the packaged library. The Apple compiler invocation is the MSL 2.4 gate; the Tint writer does not switch its output dialect from that flag. Node.js, `vgpu-tint-compiler`, Tint, source WGSL, generated MSL, and Apple build tools remain on the build machine and are not application runtime dependencies.

The watcher tracks imported modules as well as entry files. Changing a shared module rebuilds every affected program but preserves unaffected generated files when their build fingerprints did not change. A native compiler, wrapper binary, pinned Dawn/Tint revision, SDK, target, language-feature set, layout model, slot ABI, or generated ABI change invalidates every affected fingerprint.

Generated MSL and compiler intermediates belong to an inspectable build cache, not the application package. Use `--keep-intermediates` for a failed build when a platform diagnostic needs the generated source.

## Understand the current validation status

The C1 compiler-protocol fixture now combines the virtual resolver, direct Tint API, and vgpu-owned slot map without calling Tint's automatic allocator. Its per-entry translation response is deliberately narrow: MSL, the selected entry point, the unchanged validated external map, effective internal bindings and size regions, and resolved compute workgroup dimensions. Seven positive and fourteen negative native canaries cover stage-local resources, sparse WGSL groups, typed overrides, deterministic virtual-source diagnostics, multiple Metal resource namespaces, runtime storage sizes, and fail-closed reflection mismatches. The compiler validates requested remaps independently against Inspector and the lowered entry interface instead of treating the request as its own evidence.

The same fixture preserves Tint ranges only in the resolved virtual WGSL and adds an authored module identity when the complete range lies within one proven module segment. It does not fabricate authored line or column positions. Extracting evaluated, typed WGSL override defaults remains a separate semantic-materialization gate; the translation request currently begins after that work has been completed. The sampled-texture resource binding-array canary is translator evidence only; resource binding arrays stay outside alpha because semantic v1 cannot carry their cardinality.

The fixture validates the JSON envelopes in Node.js and adapts them to typed prototype arguments. The final stdin/EOF JSON codec and its transport-failure tests remain an implementation gate.

The vertex-buffer follow-up establishes a pipeline-local mapping instead of a fixed shader-versus-geometry partition. It preserves artifact-fixed shader and internal slots, starts logical vertex streams after the highest occupied external shader-buffer interval, and rejects a range that crosses the recorded external ceiling. A deliberately colliding Metal pipeline still compiled, while order-sensitive readback exposed the alias; vgpu must therefore validate disjointness itself. Another canary switched between two mappings in one encoder and proved that every active vertex stream must be rebound when the pipeline mapping changes. The exact-capacity fixture used its complete 31-entry test table in a real draw. Its numeric partition and conservative constant-argument mix are fixture inputs, not public ABI or hardware-support claims. This runtime evidence comes from the current Apple-silicon machine; it does not establish Intel or discrete-GPU support, and offline `metal` plus `metallib` validation remains pending.

The runtime-size follow-up validates multiple runtime storage buffers, sparse physical slots, stage-local packing, rebinding larger effective ranges, and equivalent immediate-data and legacy UBO results on the current Apple-silicon Metal runtime. For `buffer(i)`, word `i` is the effective bound range in bytes, and the region extends through the highest projected runtime-sized storage slot. C1 remains open for evaluated override-default extraction, the direct-target macOS 14 arm64 and x86_64 compiler build, offline `metal` and `metallib`, the full shader corpus through that exact wrapper, authored spans beyond the current module-only attribution, artifact determinism, and pixel/buffer parity. The reproducible fixtures live in `experiments/native-metal-spikes/c1-runtime-buffer-sizes` and `experiments/native-metal-spikes/c1-vertex-buffer-slots`.

C3a passed the current structural artifact fixture. It assembles the generated package around intentionally invalid UTF-8 text whose filename ends in `.metallib`, then verifies deterministic output, schemas and hashes, compatibility checks, SwiftPM dependency and resource boundaries, clean consumer builds without invoking Node.js, Tint, or Apple Metal compiler tools after generation, and the positive generated-output allowlist. Its `Noop` program has no size region; its synthetic `RuntimeArray` program records a compute region and shared immediate-data slot. The fixture distinguishes the zero-element layout minimum from the one-element binding minimum, validates region order and slot relationships, keeps dynamic ranges out of the artifact, and requires model support only for a selected stage with a region. It resolves and hashes the sentinel through `Bundle.module`, but never passes it to Metal. C3a therefore validates the package and compatibility boundary, not a Metal library or shader execution.

C3b was skipped because the separately installed Apple Metal toolchain was unavailable. When that gate can run, it links handwritten no-op and runtime-array Metal functions into the packaged library, but the fixture-local `AppShadersC3MetalProbe` executes only the no-op path. That probe does not implement the compare request and response protocol, does not appear in `projection.testing`, and cannot prove that the recorded WGSL produced the MSL or that the runtime uploaded storage-size words.

C3 remains open until a real artifact connected to the WGSL-to-MSL compiler, the production `VGPUABI` and runtime, the supported Xcode, macOS, and physical-hardware matrix, and newest-generator to oldest-runtime consumption all pass. Packaging also remains undecided between always emitting the real compare runner and emitting it only when compare testing is enabled.

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
- the selected program stage has a storage-buffer-size region whose model the runtime does not understand;
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
- the storage-buffer-size model, stage-local region offsets, and shared immediate-data slots without dynamic size words;
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

Resolver errors can point to an authored WGSL span. Tint parse and validation diagnostics point to the resolved virtual WGSL; the current origin map can add the authored module identity but cannot honestly recover its line or column. Inspect, lower, and generate failures do not invent a source location. Apple's compiler points to generated MSL unless a real WGSL-to-MSL source map is available.

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
