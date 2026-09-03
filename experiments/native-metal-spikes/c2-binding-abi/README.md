# C2 binding ABI

This spike defines a backend-neutral Swift 6 layout and packing contract from WGSL semantics, then
characterizes where the current TypeScript product agrees or diverges.

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
uniform, and storage. Six strict negative cases freeze both diagnostic code and structured value
path for shape, integer-range, and runtime-extent failures.

## Current TypeScript layout bug

The current TypeScript uniform layout is hybrid. It retains the natural four-byte scalar-array
stride accepted with `uniform_buffer_standard_layout`, while also applying legacy 16-byte array and
structure alignment, root-size padding, and nested-structure gaps. That result is neither the
standard-layout ABI nor a valid fallback for implementations without the feature.

Four canaries make the difference observable:

| Case | WGSL semantic offsets and size | Current TypeScript product |
| --- | --- | --- |
| Root `struct { x: f32 }` | `x` at `0`; align `4`, size `4` | `x` at `0`; align `16`, size `16` |
| `lead`, `array<f32, 3>`, `tail` | `0`, `4`, `16`; size `20` | `0`, `16`, `28`; size `32` |
| `lead`, `Small`, `tail` | `0`, `4`, `8`; size `12` | `0`, `16`, `32`; size `48` |
| `array<Small, 2>`, `tail` | elements `0`, `4`; tail `8`; size `12` | elements `0`, `16`; tail `32`; size `48` |

The root-small-structure case is valid with or without the feature. Its useful four-byte payload is
a prefix of the product's 16-byte allocation, but reflected alignment, size, and minimum binding
size still diverge. The other three canaries declare `requires uniform_buffer_standard_layout;`.

`gpu-readback.mjs` uploads the Swift semantic bytes and runs real Dawn/Metal compute pipelines. The
three feature-dependent cases also write different sentinels at the current product offsets. A
supported host must read the semantic values and ignore those hybrid sentinels. The default runner
records a stable skip when that GPU path is unavailable;
`C2_REQUIRE_GPU=1` turns any skip into failure.

The fix is to use one intrinsic WGSL layout engine, then validate the chosen address space and
feature state without mutating offsets or strides. The product output in this fixture is retained
only as current-behavior characterization.

## f16 result

The f16 contract is IEEE 754 binary16 round-to-nearest-ties-even. Fifteen probes cover ties,
subnormals, overflow, signed zero, infinities, and NaN.

The current TypeScript helper truncates instead of rounding. For example, input f32 bits `3f803000`
produce `3c01` instead of `3c02`, and `477ff000` produces `7bff` instead of `7c00`. Node
`Float16Array`, native arm64 Swift `Float16`, and the portable Swift converter agree on the semantic
result. The truncation is a product bug, not compatibility behavior for Swift to preserve.

## Remaining decision

Layout semantics must be corrected first. After that, the only open compatibility decision in this
spike is whether to replace the misleading `layoutMode: "naga-standard"` name immediately with a
neutral name such as `wgsl-host-shareable-v1`, or retain the old string temporarily as a deprecated
alias. That migration policy does not change the corrected byte ABI.

## Normative references

- [WGSL §14.4.5: Address Space Layout Constraints](https://www.w3.org/TR/WGSL/#address-space-layout-constraints)
- [WGSL §4.1.2: Language Extensions](https://www.w3.org/TR/WGSL/#language-extensions-sec)
