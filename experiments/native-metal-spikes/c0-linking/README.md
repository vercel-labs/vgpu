# C0: Swift module and linker boundaries

This fixture tests whether Swift module boundaries are sufficient to keep unused Metal capabilities out of a release executable.

## Hypothesis

A single Metal implementation type conforms to Core, Resources, Render, and Compute through separate SPI protocols. If conformances in separate source files are an effective linker boundary, a context-only executable should retain only Core. If Swift conformance metadata roots the complete type instead, the implementation must be split into physical targets.

Each capability calls a uniquely named C payload. The verification script reads the final Mach-O symbol table and link map, so it distinguishes live code from code that was only compiled.

## Variants

`UnifiedMetal` is one target and one backend type. Its four capability conformances live in four separate Swift files.

The physical variant uses four targets:

```text
PhysicalMetalCore
├── PhysicalMetalResource
├── PhysicalMetalRender  -> PhysicalMetalResource
└── PhysicalMetalCompute -> PhysicalMetalResource
```

Resource, Render, and Compute extend the package-scoped Core backend type with package-scoped conformances. This requires neither runtime registration nor re-exported imports.

## Results

Both ordinary Release builds and Release builds with whole-module optimization, size optimization, dead stripping, and full LTO produce these live payloads:

| Fixture | Unified target | Physical targets |
| --- | --- | --- |
| Context | `core, resource, render, compute` | `core` |
| Effect | — | `core, resource, render` |
| Compute | — | `core, resource, compute` |

Splitting conformances into source files inside one target is therefore insufficient. The unused witness tables, methods, and payloads remain live even under full LTO. Capability-specific implementation targets satisfy the negative-exclusion contract.

## Product ergonomics

The package also exposes multi-target products for Core, Render, and Compute. Each product contains its neutral modules and only the matching Metal implementation targets.

`ExternalConsumer` proves that:

- a consumer needs one composed product for a single capability;
- source files still use explicit module imports—there is no umbrella module or `@_exported import`;
- Render and Compute products can be selected together;
- SwiftPM deduplicates their overlapping ABI, Core, Resource, and Metal implementation targets;
- each payload appears exactly once in the combined executable.

The resulting marker sets are:

| External product selection | Live payloads |
| --- | --- |
| Core | `core` |
| Render | `core, resource, render` |
| Compute | `core, resource, compute` |
| Render + Compute | `core, resource, render, compute` |

This makes composed products the cleanest package-level selection mechanism. Importing a backend-neutral module cannot automatically choose its Metal implementation; the product dependency is the explicit backend choice.

## Run

```sh
./run.sh
```

Build products, logs, and link maps are written to `.artifacts/` and are ignored. The script builds and runs the local and external fixtures, checks exact payload sets, verifies overlapping products are linked once, and repeats the local comparison with full LTO.

This is a structural linker fixture, not a renderer. Its marker functions prove inclusion and exclusion, but their absolute byte sizes do not predict the size of the eventual implementation.
