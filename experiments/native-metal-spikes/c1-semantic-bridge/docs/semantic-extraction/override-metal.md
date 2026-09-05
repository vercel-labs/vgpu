# Exact-static override Metal observation

Status: passed on Apple M4 Pro with the accepted arm64 worker and Apple Metal toolchain.

This companion closes the live-observation portion of the exact-static override slice. It carries
one authored render program through the real resolver, authenticated semantic extraction,
`semantic-v1` assembly, exact per-entry compiler projection, two fresh translations per entry, AIR
compilation, metallib linking, pipeline creation, and exact `rgba8Unorm` readback. No runtime API can
change an override value after the artifact has been built.

## Observe every stage-specific value

The authored source retains three overrides with defaults that differ from the selected
configuration:

| Override        | Default | Selected | Static use                  | Readback channel |
| --------------- | ------- | -------- | --------------------------- | ---------------- |
| `VERTEX_ONLY`   | `0.5`   | `0.625`  | vertex only                 | red              |
| `SHARED`        | `0.25`  | `0.375`  | vertex and fragment         | green and alpha  |
| `FRAGMENT_ONLY` | `0.75`  | `0.125`  | fragment only               | blue             |

The vertex entry uses `vertex_index` to emit one oversized full-screen triangle. It carries
`VERTEX_ONLY` and its use of `SHARED` through a constant flat `vec2f` varying. The fragment entry
combines that varying with its own uses of `FRAGMENT_ONLY` and `SHARED`. Adding one quarter of the
integer pixel coordinate to red and green makes a four-pixel signature that also detects incomplete
coverage, row-order changes, or an inverted origin.

The exact row-major `2 × 2` result is:

```text
[159,  96, 32, 96] [223,  96, 32, 96]
[159, 159, 32, 96] [223, 159, 32, 96]
```

The selected values and arithmetic are exact binary fractions. Their `rgba8Unorm` conversions do
not land on half-way rounding cases. Every pixel center is also well inside the oversized triangle,
and the flat value is identical at all three vertices, so neither edge coverage nor provoking-vertex
choice enters the oracle. The render pass clears to magenta, making an uncovered pixel visibly fail.

## Keep specialization out of runtime

Both retained MSL sources are rejected if they contain `function_constant`. The Swift probe source
is hash-locked and rejected if it mentions `MTLFunctionConstantValues` or the `constantValues:`
function overload. It obtains both functions only with `library.makeFunction(name:)`, builds the
pipeline directly, and performs two renders. The gate runs that executable in two independent
processes and requires byte-identical JSON and all four readbacks to match the frozen pixel oracle.

The runtime receives only the linked metallib and emitted names derived from the authenticated
program projection. It does not receive WGSL, semantic override records, translator requests,
generated MSL, or temporary compiler paths. The metallib remains inside the gate's scratch directory
until both live processes finish and is then removed.

## Run the gate

From the repository root, after building the accepted direct worker:

```sh
node experiments/native-metal-spikes/c1-semantic-bridge/gates/semantic-assembly.mjs \
  --worker experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64 \
  --require-worker \
  --require-offline-metal \
  --require-metal-runtime
```

The complete gate reports eighteen semantic extractions across all nine assembly fixtures. Its
override branch reports twelve translations across six entries and five programs, six AIR files,
five metallibs, and four live renders. The exact override readback hash is
`c09bf995ecabe58508a0d9be2130be57de81710ddea084015f2e744e8f40eeee`.

## Limits

This result proves baked render values on the available Apple-silicon device. It does not add public
runtime specialization, execute an override-dependent compute dispatch, cover resources in the
override render, establish Intel or AMD GPU support, or replace the broader hardware and toolchain
matrix. The x86_64 worker can be checked under Rosetta, but that validates the compiler process, not
an Intel GPU.
