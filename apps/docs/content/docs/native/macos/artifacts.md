---
title: "Generated artifacts"
description: "Understand the generated Swift package, backend-neutral semantics, Metal projection, and compatibility fingerprints."
---

One native configuration produces one Swift module, one semantic program contract, and one selected Metal projection. The manifest is a build-time envelope; generated Swift embeds only the compatibility data needed to load and execute the packaged `.metallib`.

> Warning: Native macOS support is a docs-first API proposal. The package and artifact formats on this page are not implemented yet.

## Inspect the generated package

One configuration produces one Swift module and one Metal library payload:

```text
Generated/app-shaders/
├── .vgpu-native-output.json
├── Package.swift
├── artifact.json
├── Sources/
│   ├── AppShaders/
│   │   ├── AppShaders.generated.swift
│   │   ├── Gradient.generated.swift
│   │   ├── LitCube.generated.swift
│   │   ├── Particles.generated.swift
│   │   └── Resources/
│   │       └── AppShaders.metallib
│   └── AppShadersMetalRunner/       (when emitted)
│       └── main.swift
└── Tests/
    └── AppShadersTests/
        └── ArtifactCompatibilityTests.swift
```

`Package.swift` makes only `VGPUABI` a dependency of `AppShaders` and processes `Resources`, so generated code loads `AppShaders.metallib` through `Bundle.module`. During `0.x`, a remote vGPU dependency uses `.upToNextMinor(from: "<version>")`; runtime ABI integers still decide artifact compatibility independently from SwiftPM version selection. Resource binding handles and their backend-neutral protocols live in that small contract product; factories and executors do not. Applications select only the runtime products they use and import their public modules explicitly.

The generated package is also the shader-payload boundary. Omitting `VGPUCompute` avoids linking the compute executor, but it does not remove compute functions already packaged in `AppShaders.metallib`. Put programs for independently distributed features in separate configurations and generated packages.

`AppShadersMetalRunner` is the proposed test-only executable for `native compare`. Its protocol and optional metadata under `projection.testing` are part of the artifact design, but its emission policy remains open: generation may always include it or include it only when compare testing is enabled. When it is emitted, its source is part of the generated payload; the application library never depends on or links it.

## Read the artifact envelope

Every `artifact.json` starts with this identity and then embeds one semantic contract and one projection. This excerpt is intentionally incomplete:

```json
{
  "$schema": "https://vgpu.sh/schemas/native/v1/artifact.schema.json",
  "schemaVersion": 1,
  "contractId": "vgpu-native-artifact/v1",
  "canonicalization": "JCS-RFC8785+VGPU-PATHS-v1",
  "compiler": {
    "name": "@vgpu/native",
    "version": "0.1.0"
  },
  "semantic": {
    "schemaVersion": 1,
    "contractId": "vgpu-native-semantic/v1",
    "module": { "name": "AppShaders", "swiftName": "AppShaders" },
    "layoutModel": "wgsl-host-shareable-v1",
    "capabilities": {
      "vocabulary": 1,
      "languageFeatures": ["uniform_buffer_standard_layout"],
      "features": []
    }
  },
  "projection": {
    "schemaVersion": 1,
    "contractId": "vgpu-native-metal-projection/v1",
    "backend": "metal",
    "abi": {
      "projection": 1,
      "bindingSlots": 1,
      "bindingModel": "vgpu-metal-binding-slots-v1"
    }
  }
}
```

The root envelope owns compiler identity, input and payload hashes, and logical, semantic, and build fingerprints. Its `files` entries contain only `path`, `size`, and `sha256`; backend-specific roles and references belong to the selected projection instead of leaking into the generic envelope.

The `semantic` object is independent of Metal. It records:

- the Swift module and public names;
- effect, draw, and compute program kinds;
- authored and resolved WGSL entry points and stage interfaces;
- the fixed `wgsl-host-shareable-v1` layout model, host-shareable types, and intrinsic WGSL alignment, size, offset, and stride values reflected by Tint;
- WGSL resource bindings, including their address space and access independently from the referenced intrinsic layout;
- typed override defaults and selected values baked before translation;
- literal or override-backed workgroup dimensions;
- explicitly enabled WGSL environment features and backend-neutral execution requirements;
- the generated Swift, binding-layout, and required `VGPUABI` contract integers.

Intrinsic layout does not acquire a uniform or storage variant. Address-space constraints are a separate validation result under the recorded language-feature set; validation cannot rewrite a reflected layout. A struct ending in a runtime-sized array records its fixed prefix, while the trailing array records its element stride. Neither carries an allocation-specific element count or final byte length; that extent belongs to the resource and binding at runtime.

The `projection` object records only the selected Metal result:

- the macOS deployment target, Metal compiler target triple, and Metal language version;
- `vgpu-tint-compiler`, its pinned Dawn/Tint revision, wrapper protocol and binary hash, translator options, and the producing Apple toolchain;
- the single `.metallib` reference;
- emitted Metal function names and interface indices;
- the versioned vgpu mapping from semantic bindings to Metal buffer, texture, and sampler slots, plus every backend-only internal slot;
- resolved compute workgroup dimensions;
- static Metal-device requirements;
- optional WGSL-to-MSL source maps;
- optional compare-runner metadata under `projection.testing`.

vgpu supplies the complete external and internal slot map to Tint and records the result. Tint does not allocate the public ABI. An internal resource introduced by lowering has an explicit role and slot but no invented WGSL binding identity.

Slots are scoped by semantic program, selected stage, and Metal resource class. Within each namespace, active bindings are ordered by `(group, binding)`, projected components by stable component name, and each component occupies a contiguous interval. Only internal roles required by lowering or the versioned vgpu ABI appear in `internalBindings`. A slot `count` is projection width; it does not add WGSL resource binding-array semantics to semantic contract v1. The first alpha rejects WGSL resource binding arrays (`binding_array`) before projection.

There is one `projection`, not a `projections` array. A future backend consumes the same semantic contract but defines its own separately versioned projection.

## Separate runtime compatibility from provenance

Each program fingerprint is the SHA-256 of the `JCS-RFC8785+VGPU-PATHS-v1` canonical form of a logical value with these fields:

- `domain`, fixed to `vgpu-native-program/v1`;
- the semantic contract's `layoutModel`;
- each referenced WGSL input as its stable ID and SHA-256, sorted by ID;
- the explicitly selected WGSL `languageFeatures`, sorted as a set;
- the normalized semantic program without its fingerprint, redundant source list, Swift presentation names, or source spans; and
- only the transitive `types` and `layouts` closure reachable from the program's bindings and entry-point inputs and outputs.

The closure traverses structure members, composite element types, layouts, and member layouts. A change to a directly referenced layout or a transitively reached elemental layout therefore changes the fingerprint; adding an unreachable type or layout does not. Capabilities remain in the normalized program. Feature, language-feature, visibility, and entry binding-ID arrays defined by this contract as unordered sets are sorted before hashing, while arrays whose order is semantic retain that order.

The logical fingerprint covers canonical resolved WGSL and normalized program configuration, including the selected language features. The semantic fingerprint covers the complete backend-neutral semantic object, including `layoutModel` and its intrinsic layouts. The application build fingerprint additionally covers `@vgpu/native`, the `vgpu-tint-compiler` protocol and binary, pinned Dawn/Tint revision, translator flags, generated API and ABI versions, the Metal compiler target triple, minimum OS, macOS SDK, and Apple Metal compiler identity. Toolchain changes therefore invalidate the build cache even when shader semantics did not change.

When a compare runner is emitted, its separate runner-build fingerprint covers the artifact manifest SHA-256, Metal-runner ABI, Swift runner target triple, and Swift toolchain. Those inputs invalidate the runner cache without becoming application runtime-compatibility requirements.

The Metal runtime-projection fingerprint covers the semantic fingerprint, Metal ABI and binding model, deployment target, `.metallib` hash, emitted names, user and internal slots, resolved workgroup sizes, and static device requirements. It excludes compiler and toolchain provenance, inputs, source maps, generated Swift and test sources, and `projection.testing`.

Generated Swift embeds the semantic contract and that runtime projection, not the complete root manifest. Schema version, `layoutModel`, binding-layout ABI, generated-Swift ABI, required `VGPUABI` integer, Metal-projection ABI, binding-slot ABI, and `bindingModel` must all be understood before a program loads. The runtime advertises an integer ABI range it understands instead of comparing package release versions for exact equality.

An incompatible Metal runner protocol blocks `native compare` only. It does not make the application artifact incompatible. Missing source maps reduce diagnostic precision without changing runtime compatibility.

Artifact compatibility and device-capability validation do not expand the published hardware matrix. The first alpha is tested on Apple silicon with macOS 14 or later; Intel-based Macs and Intel or AMD GPUs remain outside that matrix until they have physical-hardware coverage. Apple silicon is not a backend-neutral shader capability, and the runtime does not reject an otherwise compatible artifact solely from the host architecture or GPU vendor.

## Verify payload integrity

The manifest contains no timestamps or absolute machine paths. Its root `files` array hashes the raw bytes of every emitted generated payload—`Package.swift`, Swift library sources, tests, resources, `.metallib`, and runner sources when present—but excludes `artifact.json` itself and the ownership marker. The marker records the raw manifest hash and configuration identity without participating in the artifact fingerprint.

Canonical JSON uses RFC 8785, NFC strings, relative POSIX paths without `.` or `..`, and a defined order for programs, files, bindings, overrides, and capabilities. Semantically ordered arrays keep their order.

The `.metallib` is an opaque Apple toolchain output. Its recorded file hash proves package integrity, but regenerating the same logical inputs is not required to reproduce identical `.metallib` bytes.

## Validate capabilities at the right boundary

Semantic capabilities describe what a program means independently of a backend. The Metal projection carries the corresponding static device requirements globally and per program. A device that cannot run `StepParticles` may still construct `Gradient`; validation uses the program that is actually loaded.

Artifact format requirements include only formats fixed by shader semantics, such as a WGSL storage-texture format. Sampled texture formats, render-target formats, sample counts, blend state, and geometry come from runtime resources and target signatures, so they are checked against `gpu.capabilities` and again during resource or pipeline creation.

Metal family and format tables allow useful preflight checks, but Metal does not expose one universal `supports(format, usage)` query. Final resource and pipeline creation remain authoritative and return a typed failure; the runtime never silently substitutes another format or rendering path.

## Next steps

- [Configure native programs](/native/macos/programs)
- [Use generated bindings](/native/macos/bindings)
- [Build and verify artifacts](/native/macos/build)
- [Compare WebGPU and Metal output](/native/macos/compare)
