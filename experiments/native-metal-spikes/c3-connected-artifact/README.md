# C3 connected artifact spike

This spike connects the first real artifact across the complete native boundary:

```text
C1 semantic + Metal projection + runtime manifest
                    │
Tint-produced MSL ──┴─> offline Metal library
                    │
                    ▼
          deterministic assembler
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
AppShaders (VGPUABI only)   private resources
          │              artifact.json + metallib
          └─────────┬──────────┘
                    ▼
CleanConsumer → public runtime products → VGPUMetalCompute product
```

The probe accepts the Metal library and the source-free handoff emitted by C1:

```sh
./experiments/native-metal-spikes/c3-connected-artifact/run.sh \
  <library.metallib> \
  <c1-handoff.json>
```

Success is one deterministic JSON object on stdout and no stderr. The C1 gate invokes this executable twice, so a passing result represents a real WGSL-to-Tint-to-metallib-to-SwiftPM-to-runtime execution rather than a locally fabricated fixture.

## Boundary under test

The assembler owns the transformation from the C1 handoff into an app-facing Swift package. It validates the single runtime-sized-storage fixture, joins the semantic and physical models, hashes canonical semantic and projection values, and emits an exact descriptor contract. It does not resolve source files, invoke Tint, compile Metal, inspect compiler responses, or accept caller-authored physical slots.

`AppShaders` exposes generated value, layout, binding, and program types. Its only runtime dependency is `VGPUABI`. The artifact descriptor and metallib are private SwiftPM resources reached through a private generated witness passed to the underscored `_VGPUProgramArtifact` bridge. Each loader returns owned `Data` rather than a file-backed mapping, so the runtime hashes and consumes the same byte snapshot. There is deliberately no public closure, `Bundle`, URL, file path, or resolver API.

`CleanConsumer` selects exactly two products: `AppShaders` and the backend-complete `VGPUMetalCompute` bundle. That multi-target backend product makes the neutral `VGPUCore`, `VGPUResources`, and `VGPUCompute` modules importable alongside the selector module `VGPUMetal`; consumers do not redundantly select each neutral product. It does not depend on `VGPUTesting`, compiler tooling, the assembler, or source-language artifacts. `try VGPU.metal()` selects the physical backend, while the generated program carries the authenticated descriptor and library bytes.

The scratch package copies the current C2 prototype's `Package.swift` and `Sources` at probe time. This reuses the implementation being tested without maintaining another runtime fork inside C3. The generated packages themselves remain deterministic and contain no copy of C2.

## Gates and canaries

The probe requires all of the following:

- exact C1 handoff root/evidence contracts and lowercase SHA-256 digests;
- metallib bytes matching the C1 evidence;
- the expected semantic type/layout graph and its matching Metal projection/runtime manifest;
- two byte-identical assemblies, including generated Swift and resources;
- a byte-identical copy relocated before SwiftPM resolution and build;
- an artifact descriptor with the exact connected-artifact shape and a final newline;
- generated Swift compiling both the descriptor and library digests;
- `AppShaders` importing only Foundation and `VGPUABI`, with private resource resolution;
- a clean SwiftPM consumer with no `VGPUTesting` or internal runtime import;
- Swift 6 complete concurrency checking with warnings treated as errors;
- native execution twice with readbacks `[[2, 202], [4, 404]]`;
- fail-closed runtime canaries for altered library bytes, crossed descriptor bytes, a rehashed unsupported ABI, a rehashed unsupported runtime model, a rehashed unknown root key, and a rehashed non-empty sampling-pair set;
- an x86_64 compile-only canary (not a claim of execution on Intel hardware);
- poison executables proving SwiftPM build and runtime do not invoke Node, Tint, or offline Metal tools.

## What this does not freeze

This is a fixture-specific assembly spike, not a general code generator. The public spelling of a future artifact resolver, cache layout, package topology, diagnostics, multi-program organization, and cross-backend artifact container remain open. The only new bridge used here is underscored, and the descriptor carries explicit ABI versions so incompatible experiments fail closed.

The C3 structural artifact-schema matrix remains a separate gate. This spike proves that one valid artifact is genuinely connected and consumed; it does not replace broader mutation coverage or establish production provenance on its own when run with arbitrary inputs outside C1.
