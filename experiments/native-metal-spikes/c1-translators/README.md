# C1: WGSL-to-Metal translation

This fixture compares two WGSL-to-MSL candidates against vgpu's shader contract before either translator becomes part of a generated native artifact.

## Hypothesis

A viable translator must accept resolved vgpu WGSL, preserve every applicable entry point, bake typed overrides before translation, apply a deterministic Metal slot policy, reject invalid input, and emit MSL that Apple's tools accept at the macOS 14 baseline.

Semantic coverage and product integration are separate decisions. Passing the shader corpus selects a provisional semantic leader. It does not prove that the translator can be shipped in the build pipeline with structured metadata, authored-source diagnostics, acceptable size, or deterministic standalone artifacts.

## Candidates

- **Tint**, exercised through `webgpu@0.4.0` and its pinned Dawn build. The harness creates real Metal compute and render pipelines and captures Dawn's generated MSL. This proves the embedded translator path, not a standalone build-time Tint compiler.
- **Naga 30.0.1**, exercised through the small pinned Rust harness in [`naga-harness`](./naga-harness). It validates WGSL, assigns explicit Metal slots, emits MSL 2.4, and writes a structured projection of bindings and entry-point names.

Both candidates receive the same resolved WGSL. Overrides become typed WGSL constants before translation; neither candidate may defer them to Metal function constants.

## Canaries

| Canary | Contract | Tint/Dawn | Naga 30.0.1 |
| --- | --- | --- | --- |
| `alignment-and-io` | Scalar, `vec3`, matrix, explicitly padded uniform array, built-ins, interpolation, texture, and sampler | Pass | Pass |
| `uniform-standard-layout` | Natural stride-four `array<f32, 3>` in `var<uniform>`, matching the current host packer | Pass | Reject |
| `binding-slots` | Sparse WebGPU groups/bindings projected into compact independent Metal namespaces | Pass | Pass |
| `multiple-entry-points` | Two compute, one vertex, and one fragment entry point | Pass | Pass |
| `typed-overrides` | `f32`, `u32`, and `bool` values baked before translation, including workgroup size | Pass | Pass |
| `invalid` | Deliberate abstract-float-to-`u32` type error | Reject | Reject |

The portable alignment canary uses an explicit wrapper:

```wgsl
struct PaddedWeight {
  @size(16) value: vec2f,
}

struct Params {
  scalar: f32,
  direction: vec3f,
  transform: mat4x4f,
  weights: array<PaddedWeight, 3>,
}
```

This is valid for both candidates. It is intentionally separate from `uniform-standard-layout`, which captures a real dialect mismatch: Dawn advertises `uniform_buffer_standard_layout` and keeps the natural stride, while Naga 30.0.1 enforces a 16-byte uniform-array stride even with all Naga validation capabilities enabled. C2 must either preserve this feature through the chosen translator, lower the layout explicitly, or narrow the host ABI.

## Observed result

The normalized full-corpus observation is checked in at [`snapshots/observed.json`](./snapshots/observed.json). The corpus contains 226 WGSL files. The resolver accepts 224; the two known resolver-negative fixtures retain their expected semantic error codes. Of the resulting translator inputs, 223 are expected-valid and one is an intentional translator-negative fixture.

| Candidate | Expected-valid WGSL | Intentional negative | Metal validation |
| --- | ---: | ---: | --- |
| Tint embedded in Dawn | 223 / 223 | 1 / 1 rejected | Real Metal pipelines cover every applicable entry point |
| Naga 30.0.1 | 220 / 223 | 1 / 1 rejected | 220 / 220 emitted sources compile through `MTLDevice.makeLibrary` at MSL 2.4 |

Naga's three expected-valid corpus failures are one shared language gap: the FFT library uses `ptr<workgroup>` parameters covered by WGSL's `unrestricted_pointer_parameters` extension. Dawn advertises and accepts that extension; Naga recognizes it but does not implement it. Enabling unrelated Naga capabilities does not close the gap.

Tint is therefore the provisional semantic leader. Naga remains useful as a differential oracle. This fixture does **not** freeze the translator choice because the tested Tint path does not yet return a standalone MSL artifact plus structured binding and entry-point projection.

## Run

Run the contract canaries:

```sh
./run.sh --quick
```

Run the canaries and every repository WGSL source:

```sh
./run.sh --full
```

The runner detects prerequisites and never installs tools or system components. It requires the existing `@vgpu/wgsl` build output. The full run also requires `rg`. Candidate-specific behavior is:

- missing `cargo` skips Naga and makes the comparison partial;
- a non-Darwin host or missing `webgpu` package skips the embedded Tint/Dawn path;
- available Swift and Metal frameworks compile Naga output with `MTLDevice.makeLibrary` at MSL 2.4;
- offline `metal` plus `metallib` runs only when Xcode reports the separate MetalToolchain as installed;
- set `C1_REQUIRE_OFFLINE_METAL=1` to make the unavailable offline toolchain a hard failure.

Cargo builds the lockfile-pinned harness but does not install Rust or modify the repository dependency graph. All build products, resolved WGSL, MSL dumps, logs, runtime binaries, and normalized live results go to ignored `.artifacts/`.

## What remains before C1 closes

The current machine does not have Xcode's downloadable MetalToolchain, so offline `metal` and `metallib` validation is recorded as skipped. Finding the `metal` launcher alone is not sufficient.

Before freezing Tint, a standalone build pinned to the tested Dawn commit must:

- emit MSL and structured binding/entry-point projection without depending on a runtime WebGPU device;
- pass offline `metal` and `metallib` for the corpus at the macOS 14 deployment target;
- preserve authored diagnostic provenance, or clearly identify generated MSL diagnostics where mapping is unavailable;
- prove deterministic artifacts, pixel/buffer parity, distribution size, startup behavior, and license obligations.

Runtime compilation is useful evidence that the generated MSL is accepted by the installed driver stack. It is not a substitute for the offline compiler and packaging gates.
