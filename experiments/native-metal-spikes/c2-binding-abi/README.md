# C2 binding ABI

This spike defines a backend-neutral Swift 6 layout and packing contract from WGSL semantics, then
verifies that the TypeScript product agrees with it.

From the repository root:

```sh
experiments/native-metal-spikes/c2-binding-abi/run.sh
```

The runner requires macOS 14+, `node`, `swift`, `cmp`, and the repository's existing
`node_modules/.bin/esbuild`. It installs nothing. SwiftPM build, cache, configuration, and security
paths stay in the ignored local `.build/`; detailed results stay in `.artifacts/`. A missing CPU
prerequisite fails explicitly. GPU readback may skip with a stable reason when Dawn, Metal, or the
WGSL feature is unavailable.

Use a strict GPU release gate on a suitable host:

```sh
C2_REQUIRE_GPU=1 experiments/native-metal-spikes/c2-binding-abi/run.sh
```

For a portability-only x86_64 cross-build and Rosetta execution:

```sh
C2_TEST_X86=1 experiments/native-metal-spikes/c2-binding-abi/run.sh
```

This checks CPU code generation and does not claim physical Intel GPU coverage.

## Contract under test

WGSL `AlignOf`, `SizeOf`, member offsets, array strides, and structure sizes are independent of the
address space. Uniform rules are a separate validation step:

- when `uniform_buffer_standard_layout` is supported, the intrinsic layout is valid under the same
  alignment constraints as storage;
- without the feature, legacy uniform constraints may reject that layout; they do not rewrite it.

`fixtures/cases.json` gives every case two independent descriptions. WGSL goes through the real
`resolveShader()` reflection path and the real `writeLayoutValue()` product packer. A semantic type
tree goes through the Swift prototype. Swift never consumes TypeScript-computed offsets.

The gate checks every recursive path and canonical type signature before comparing layouts. This
prevents isometric changes such as `f32` to `u32` from passing only because their offsets and byte
widths match. It also checks normalized layout hashes, complete zero-initialized bytes, byte hashes,
deterministic repeated execution, and `expected/snapshot.json`.

The 13 cases cover scalars, f16, vectors, vec3 tail packing, square and non-square matrices, matrix
column padding, nested structures, fixed and runtime-sized arrays, explicit `@align` and `@size`,
uniform, and storage. Six strict negative cases freeze the Swift diagnostic code and the equivalent
TypeScript error reason and complete value path for shape, integer-range, and runtime-extent
failures.

## TypeScript layout closure

The previous TypeScript uniform layout was hybrid. It retained the natural four-byte scalar-array
stride accepted with `uniform_buffer_standard_layout`, while also applying legacy 16-byte array and
structure alignment, root-size padding, and nested-structure gaps. That result was neither the
standard-layout ABI nor a valid fallback for implementations without the feature.

Four canaries make the difference observable:

| Case | WGSL semantic offsets and size | Previous TypeScript product |
| --- | --- | --- |
| Root `struct { x: f32 }` | `x` at `0`; align `4`, size `4` | `x` at `0`; align `16`, size `16` |
| `lead`, `array<f32, 3>`, `tail` | `0`, `4`, `16`; size `20` | `0`, `16`, `28`; size `32` |
| `lead`, `Small`, `tail` | `0`, `4`, `8`; size `12` | `0`, `16`, `32`; size `48` |
| `array<Small, 2>`, `tail` | elements `0`, `4`; tail `8`; size `12` | elements `0`, `16`; tail `32`; size `48` |

The root-small-structure case is valid with or without the feature. Its useful four-byte payload was
a prefix of the old 16-byte allocation, but reflected alignment, size, and minimum binding size
still diverged. The other three canaries declare `requires uniform_buffer_standard_layout;`.

`gpu-readback.mjs` uploads the Swift semantic bytes and runs real Dawn/Metal compute pipelines. The
three feature-dependent cases also write different sentinels at the former product offsets. A
supported host must read the semantic values and ignore those hybrid sentinels. The default runner
records a stable skip when that GPU path is unavailable;
`C2_REQUIRE_GPU=1` turns any skip into failure.

The TypeScript reflection path now uses one intrinsic WGSL layout engine and records
`layoutMode: "wgsl-host-shareable-v1"` without embedding an address space in the layout. The binding
still records `uniform` or `storage`; feature-state validation remains separate and never mutates
offsets or strides. All 13 product layouts and packed byte sequences match the independent Swift
implementation.

## f16 result

The f16 contract is IEEE 754 binary16 round-to-nearest-ties-even. Fifteen probes cover ties,
subnormals, overflow, signed zero, infinities, and NaN.

The TypeScript helper, Node `Float16Array`, native arm64 Swift `Float16`, and the portable Swift
converter now agree on all 15 semantic probes. In particular, input f32 bits `3f803000` rounds to
`3c02`, and the overflow boundary `477ff000` rounds to `7c00`.

## Resolved migration

The public layout identity was replaced directly with `wgsl-host-shareable-v1`. There is no
`naga-standard` compatibility alias. The snapshot rejects either the old identity or any return of
address-space-dependent offsets.

## Normative references

- [WGSL §14.4.5: Address Space Layout Constraints](https://www.w3.org/TR/WGSL/#address-space-layout-constraints)
- [WGSL §4.1.2: Language Extensions](https://www.w3.org/TR/WGSL/#language-extensions-sec)
