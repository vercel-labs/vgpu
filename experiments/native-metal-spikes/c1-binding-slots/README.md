# C1 binding slot projection

This spike tests whether vgpu can own a deterministic WGSL-to-Metal binding ABI instead of
accepting a translator-generated map as a cache or runtime contract.

## Result

The candidate projection works for the covered resource model. It allocates compact, contiguous
Metal indices independently for each `(semantic program, shader stage, resource class)` namespace.
Bindings are ordered by WGSL group and binding number; multi-slot components occupy one contiguous
interval. Vertex and fragment entries in one render program therefore share a semantic program but
have independent Metal namespaces, while two selected compute entries from one WGSL source remain
two semantic programs.

The allocator and an independently implemented verifier agree on eight positive cases, twenty
input mutations, and nine corrupted-output mutations. The cases cover sparse groups, all three
Metal resource classes, stage-local resources, two programs from one source, exact capacity,
sampled texture arrays, expanded multi-component bindings, and translator-owned internal slots.

The Tint feasibility wrapper also passes eight deterministic WGSL-to-MSL canaries and eight strict
negative map canaries. It constructs `tint::Bindings` only from the vgpu allocation, verifies the
selected entry point's reflected resources, generates MSL, then inspects Tint's raised IR to ensure
that the emitted entry interface uses the exact declared user intervals. Generated MSL checks also
tie the storage-size and immediate-data roles to their assigned indices. The source guard
rejects accidental use of Tint's `GenerateBindings` helper.

## Candidate contract

The fixture uses these provisional rules:

- allocate user resources upward from index zero, separately for buffers, textures, and samplers
  in each selected stage;
- sort semantic bindings by `(group, binding)` and components by name before allocation;
- treat `count` as a contiguous half-open interval, so a texture array at index `0` with count
  `3` occupies texture indices `0`, `1`, and `2`;
- reserve translator-owned bindings from the high end of their namespace and emit only the roles a
  selected program needs; and
- reject unknown, inactive, duplicate, colliding, overflowing, or non-canonical projections before
  shader compilation.

The candidate profile reserves compute buffer index `30` for Tint's runtime storage-buffer size
table and index `29` for immediate data. A canary forces both mechanisms in one entry point and
confirms that Tint emits both distinct slots. These numbers and the fixture ceilings of 31 buffers,
128 textures, and 16 samplers are test inputs, not frozen public limits or a claim about every
supported Metal device.

The sampled texture-array canary confirms that the pinned Tint writer preserves a reflected
three-element type at the assigned base index. This is future evidence, not alpha support: the
current semantic contract has no binding-array cardinality, the other resource-array classes are
not covered, and the emitted MSL has not passed the offline compiler. The initial contract should
therefore reject all binding arrays until that cardinality is versioned through semantic reflection,
code generation, and runtime binding.

The expanded external-texture case likewise proves only that the projection model can represent
multiple components. The wrapper intentionally rejects Tint external textures until their lowering
is specified and tested end to end.

## Run

The allocator contract has no native compiler prerequisite:

```sh
./run.sh
```

To rebuild and exercise the feasibility wrapper, provide the official Dawn release and exact
missing-header overlay described by
[`c1-tint-standalone`](../c1-tint-standalone):

```sh
./run.sh \
 --release-root ../Dawn-8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca-macos-latest-Release \
 --compat-include ../tint-8f25-compat-include \
 --require-tint
```

`C1_TINT_RELEASE_ROOT`, `C1_TINT_COMPAT_INCLUDE`, and `C1_REQUIRE_TINT=1` are equivalent environment
variables. The runner installs and downloads nothing, writes all native build products and
generated MSL to a temporary directory, runs every positive and negative canary twice, and removes
the directory on exit. It verifies `libwebgpu_dawn.a` and the supplemental `compiler.h` against the
recorded hashes for the exact Dawn commit. It does not hash the rest of the extracted header tree;
the archive is feasibility evidence rather than a production supply-chain boundary.

When Apple's separately downloadable Metal compiler is already available, the same run compiles
each generated source with MSL 2.4 for an explicit macOS 14 AIR target and links a metallib. Use
`--require-offline-metal` or `C1_REQUIRE_OFFLINE_METAL=1` to make that gate mandatory. The recorded
workspace run skips this gate because the Metal toolchain is not installed.

## Scope of the evidence

The official Dawn archive is useful only as a semantic feasibility dependency. It is arm64, has a
macOS 26 deployment target, exposes a monolithic `libwebgpu_dawn.a`, and omits one header required
by its installed Tint headers. It is not the production compiler artifact.

Before this ABI can be frozen, a direct-target Tint build must pass at the macOS 14 baseline for
arm64 and x86_64, the offline Metal gate must cover the full shader corpus, and the allocation
profile must partition shader buffer slots from vertex-stream indices. The runtime-size-table
packing also needs a canary with multiple runtime storage buffers. There is no Intel hardware
result; an x86_64 build and Rosetta execution can reduce CPU-path risk but cannot establish Intel or
AMD GPU behavior.
