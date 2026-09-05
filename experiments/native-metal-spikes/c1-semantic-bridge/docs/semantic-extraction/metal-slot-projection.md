# Metal slot allocation and compiler projection

This slice connects one nominal `semantic-v1` assembly to the existing one-entry Tint compiler
protocol. The adapter owns physical Metal allocation; callers provide neither slot maps nor a
second description of shader resources.

## Ownership boundary

`allocateMetalSlotsForAssembly` accepts only an in-process semantic assembly minted from the exact
authenticated extraction, finalized capsule, and resolver declaration evidence. It derives a
complete program allocation, runs the binding allocator and its independent verifier, freezes the
result, and associates it with that exact assembly identity.

`compilerRequestForAssembledEntry` requires both nominal values. A clone, a hand-written lookalike,
or an allocation minted for a structurally equal but distinct assembly fails before the compiler
worker starts. This keeps physical backend policy downstream of authenticated semantics without
making the allocation part of backend-neutral `semantic-v1`.

The low-level allocation is deterministic within independent
`(semantic program, shader stage, Metal resource class)` namespaces. Active bindings use numeric
WGSL `(group, binding)` order followed by component name in ASCII order within each namespace;
WGSL binding numbers are identities, not Metal indices. A binding shared by stages is allocated
independently in each stage and may therefore have different indices. Buffer, texture, and sampler
indices never consume one another.

The current direct profile maps one singular semantic resource as follows:

- `buffer` becomes one direct Metal buffer slot;
- `texture` and `storage-texture` become one direct Metal texture slot; and
- `sampler` becomes one direct Metal sampler slot.

Resource binding arrays are rejected by semantic extraction because semantic v1 does not carry
their cardinality. `external-texture` also fails before compiler projection because its lowered
multi-component Metal representation is not in this direct profile.

## Per-entry compiler request

The program allocation is a union. Projection filters it to the selected entry's exact active
binding set, removes the now-implicit stage field from every direct slot, restores numeric WGSL
group and binding coordinates from the semantic graph, and rejects missing or extra stage slots.
Source bytes, origin map, entry identity, interface, and language features still come from evidence
retained by the nominal assembly. For exact-static programs, projection selects only the entry's
canonical override-name subset from the program's typed union and sends those selected values to the
one-entry translator.

Compiler protocol v1 carries the versioned `vgpu-metal-immediate-data-layout-v1` model, a candidate
stage-local `immediate-data` reservation, and that model's storage-size transport offset on every
request. The v1 offsets are fixed at byte `4` for vertex/compute and byte `12` for fragment; unused
roles never compact later fields. The integration canary uses Metal `buffer(30)`, which is a
fixture/profile reservation rather than a public hardware-limit claim. Candidate capacity does not
claim that the selected entry uses either feature. Only the generated response can populate
effective `internalBindings` or `storageBufferSizeRegions`, and its region must match the model's
stage offset.

## Executable evidence

The fixed-resource render fixture allocates this exact union:

| Semantic binding | Vertex      | Fragment     |
| ---------------- | ----------- | ------------ |
| `g0b0`           | `buffer(0)` | `buffer(0)`  |
| `g0b1`           | `buffer(1)` | —            |
| `g0b2`           | —           | `texture(0)` |
| `g0b3`           | —           | `sampler(0)` |
| `g0b10`          | —           | `buffer(1)`  |

The `g0b10 -> buffer(1)` result proves that sparse WGSL numbers are not copied into Metal. A
separate mutation makes `g0b10` active in both stages and proves `buffer(2)` in vertex alongside
`buffer(1)` in fragment, so stage isolation is not inferred from the fixture's coincidental
`g0b0 -> buffer(0)` pair.

The static gate assembles ten programs, mints ten nominal allocations, and projects fourteen
schema-valid compiler requests. Thirteen synthetic compiler translations assemble nine static
program projections; the runtime-sized request is deliberately reserved for real Tint. Fourteen
independent verifier canaries protect the combined projection boundary. The gate rejects cloned and
crossed allocations, a missing allocation, and external texture lowering without launching Tint.

With the accepted native worker, the resource entry pair is translated twice per stage. Request,
response, and MSL bytes are deterministic snapshots. Each response reproduces the exact validated
external map and returns empty effective internal bindings and size regions, as expected for this
fixed-size fixture. Both MSL sources compile with Metal 2.4 for
`air64-apple-macos14.0`; their two AIR files link into one non-empty metallib. The connected runtime
derives semantic constraints plus these exact slots from the nominal program projection. Two Swift
processes each prepare six commands for five logical resources and validate two renders against the
exact readback.

The runtime-sized compute request translates twice with byte-identical real Tint results and
assembles a tenth authenticated projection with external `buffer(0)`, effective immediate-data
`buffer(30)`, and a storage-size region at byte `4`. The retained MSL compiles and links offline. A
live M4 Pro gate then runs two processes. Within each process, two dispatches reuse one backing
allocation and binding offset with effective ranges `28` and `52`; they upload sparse immediate
words `[0, 28]` and `[0, 52]` and read back `[2, 202]` then `[4, 404]`.

Run the strong gate from the repository root after building the direct worker:

```sh
node experiments/native-metal-spikes/c1-semantic-bridge/gates/semantic-assembly.mjs \
  --worker experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64 \
  --require-worker \
  --require-offline-metal \
  --require-metal-runtime
```

This evidence includes pipeline creation, direct fixed-resource binding, runtime-sized compute
binding, and exact readback. Exact-static override assembly, offline linking, and an exact live
render observation also pass in the same gate without runtime function constants. Artifact
packaging, broader compute-resource encoding, the repository corpus, production Swift runtime, and
additional hardware remain open. The numeric canary ceilings are not a
supported-device profile. See
[`runtime-resource-binding.md`](./runtime-resource-binding.md) for the runtime ownership and
limitations.
