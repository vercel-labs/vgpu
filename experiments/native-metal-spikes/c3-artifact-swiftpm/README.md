# C3 artifact and SwiftPM spike

This spike splits the C3 artifact gate into two independently falsifiable parts:

- **C3a** assembles a deterministic generated Swift package around an intentionally invalid
  `.metallib` sentinel. It proves the artifact, compatibility, package dependency, resource, and
  clean-consumer boundaries without pretending that Metal accepted the payload.
- **C3b** replaces the sentinel with a real library built from `fixtures/noop.metal` and
  `fixtures/runtime-array.metal`, when Apple's optional Metal toolchain is already installed. It
  loads the packaged resource, creates the no-op compute pipeline, dispatches four threads, and
  requires an exact `[0, 1, 2, 3]` readback.

The spike does not install or download anything and does not invoke Tint. The semantic and Metal
projection records are synthetic contract fixtures; they are not translator-provenance evidence.
In particular, `noop.metal` and `runtime-array.metal` are handwritten C3b canaries outside the
artifact's normal WGSL input graph. They cannot establish a relationship between the recorded WGSL
and MSL. Translation remains a separate C1 gate.

## Run

```sh
bash experiments/native-metal-spikes/c3-artifact-swiftpm/run.sh
```

All generated packages, SwiftPM scratch directories, AIR, and Metal libraries live under a
temporary directory that is removed on exit. C3a must pass on the current host. C3b reports a skip
when the separately downloadable Metal toolchain is absent.

To make C3b mandatory without installing anything:

```sh
C3_REQUIRE_OFFLINE_METAL=1 \
  bash experiments/native-metal-spikes/c3-artifact-swiftpm/run.sh
```

If `metallib` is unavailable, this form exits with a stable failure after C3a passes. If the tools
are present but compilation, loading, pipeline creation, dispatch, or readback fails, both forms
fail rather than converting that failure into a skip.

The recorded 2026-09-04 run passed C3a and mandatory C3b with Apple Metal toolchain build
17C7003j. Two handwritten MSL 2.4 sources compiled for `air64-apple-macos14.0` and linked into one
packaged `.metallib`. The generated probe verified the `Bundle.module` payload hash and produced an
exact `[0, 1, 2, 3]` readback on the Apple M4 Pro.

## C3a assertions

The runner:

1. assembles the same tree twice and compares every byte;
2. compiles all five native JSON Schemas in strict mode, resolves their external references, and
   validates `artifact.json`, then assembles and verifies a future-model descriptor without adding
   that model to the runtime's fixed support set; schema negatives reject legacy ambiguous
   `interfaceLocations`, missing or mismatched stage-discriminated interfaces, invalid interpolation
   roles, workgroup-axis provenance objects and zero dimensions, emitted names outside the `vgpu_`
   domain, legacy arbitrary override IDs, invalid resolved override identifiers, non-finite override
   constants, repeated or non-canonical per-stage binding intervals, stages incompatible with the
   program kind, and components that disagree with their Metal resource class; verifier negatives
   also require every entry's override-name subset, including `[]`, to be present, unique, strictly
   ordered, bounded to 4096 members, and drawn from the program union; the program union must be the
   exact union of those subsets, its WGSL names must be unique and strictly ordered, authored `@id`
   values must be unique when present, and an `f16` override requires the feature in both the
   semantic program and its source module;
3. recomputes input, file, semantic, program, build, runtime-projection, manifest, and payload
   hashes, checks every cross-reference, requires each resolved semantic workgroup size to equal
   the translated Metal projection, and proves that the vertex-buffer policy, storage-buffer-size
   model, shader-interface model and maps, stage-local regions, and immediate-data slots change
   runtime compatibility;
4. distinguishes a runtime-array structure's four-byte fixed-prefix `layout.minimumSize` from its
   eight-byte, prefix-plus-one-element `minimumBindingSize`, requires canonical per-stage size
   regions, rejects invalid region-to-slot relationships, and proves that runtime-sized bindings
   or immediate data alone do not imply a region; it rejects overlaps with external and other
   internal buffers, plus vertex-stage intervals that violate the independently recorded
   vertex-buffer ceiling;
5. preserves `SparseDraw` locations `3` and `7` as Metal vertex attributes and locations `1` and
   `4` as Metal fragment colors, requires unique and exactly matching semantic and projected
   program names after NFC normalization, orders semantic programs by ascending `name` and projected
   programs by ascending `semanticProgram` under the same normalization, resolves every interface
   type to a legal scalar or vector shape, requires exactly one vertex `position` output, checks
   required builtin shapes, canonical location-then-builtin ordering and flat interpolation for
   integer inter-stage values, validates vertex-to-fragment linking, and rejects missing,
   duplicated, reordered, compacted, colliding, or invalid dual-source maps;
6. verifies Swift tools 6.0, Swift language mode 6, macOS 14, the single `VGPUABI` package
   dependency, and the `AppShaders` target's single ABI product dependency;
7. tests the generated package for the native architecture, builds the generated package and clean
   consumer for both `arm64` and `x86_64`, then runs the native consumer and the `x86_64` consumer
   through Rosetta when available;
8. puts failing `node`, `npx`, `pnpm`, Tint, `metal`, and `metallib` shims first on `PATH` for every
   post-generation SwiftPM command and requires that no shim was invoked;
9. resolves exactly one `.metallib` through `Bundle.module`, checks its SHA-256, and confirms its
   bytes begin with `VGPU-C3-STRUCTURAL-SENTINEL-NOT-A-METALLIB`;
10. rejects crossed or out-of-range WGSL source provenance, and rejects the mutation matrix before a
    pipeline-factory closure runs, including ABI, model, fingerprint, and payload-hash mismatches;
    the pipeline selection has no public initializer, determines the conditional region check, and
    is passed unchanged into that closure; and
11. checks the generated package and clean consumer contain no WGSL, MSL, Metal source, AIR,
    JavaScript, translator executable, build directory, or package-resolution residue, and proves
    the package allowlist rejects an injected `.env` file.

The `vgpu-native-program/v1` fingerprint preimage is domain-separated and contains the referenced
WGSL input IDs and hashes, `layoutModel`, the semantic program without its fingerprint, Swift
presentation names, source spans, interface diagnostic names, or redundant source list, and only
the forward type/layout closure reachable from that program's bindings and interfaces. The traversal
starts from interface and binding types plus each buffer binding's explicit layout, follows only
type element/member references and layout type/member/layout references, including every array
layout's explicit `elementLayout`, and never discovers a layout by scanning for a matching type.
Capabilities remain in the program. Arrays declared as unordered unique sets by the schema,
including every entry's override-name subset, are sorted before hashing; semantically ordered arrays
retain their order. Executable self-checks require referenced WGSL, layout-model, language-feature,
binding-root-layout, and explicitly member-linked child-layout changes to change the fingerprint.
`SparseDraw` proves that an interface-only program has an empty layout closure, while `Noop` proves
that a same-type layout reachable only from another program does not change its fingerprint. The
runtime-array fixture also contains a same-type foreign layout that must remain outside the closure,
proving that `elementLayout` owns the physical choice. An unreachable type/layout addition must
likewise not change it. Separate canaries prove that changing an interface location, type, or
normalized interpolation changes the owning program fingerprint.
Interface diagnostic names are removed through a directed projection: rename/removal and
non-mutation canaries prove the exclusion, while program, resolved entry, binding, reachable member,
and override names remain covered. `Noop` uses an authored `@id` override to resolve its workgroup
width; separate canaries prove that the resolved override name and selected value affect its program
fingerprint while its generated Swift name does not. Another canary redistributes override
membership between entries without changing the program union and still changes the owning program
fingerprint.

The projection requires a versioned `storageBufferSizeModel` string and every projected program
contains a canonical `storageBufferSizeRegions` array. `Noop` uses an empty array. `RuntimeArray`
records a compute region at immediate-data byte offset `4` and a separate `immediate-data` internal
binding at `buffer(30)`; the fixture independently chooses `30` as its vertex-buffer ceiling, but
the contract does not equate compute or fragment internal slots with that vertex-only policy.
Neither word counts nor dynamic range bytes are serialized. The runtime checks support for the
model only when the selected program stage has a region, so a future model can remain structurally
readable without blocking unrelated programs.

The projection ABI also requires `vgpu-metal-shader-interface-v1`. Its entry-point interface is
stage-discriminated: vertex entries contain only semantic-location to Metal-attribute mappings,
fragment entries contain only semantic-location and optional blend-source to Metal-color mappings,
and compute entries carry only their kind. Built-ins, inter-stage varyings, normalized
interpolation, and invariance remain in the semantic contract. `SparseDraw` proves that sparse
indices survive schema validation, runtime fingerprinting, generated Swift, and SwiftPM builds
without compaction. Cross-validation requires the exact semantic set, canonical order, v1 identity
mapping, and a compatible vertex-to-fragment link before a fingerprint is accepted.

Runtime support is owned by runtime code. Generation never derives a support set from the
artifact's requested model. Storage-buffer-size support is conditional on the selected stage using
a region, so `Noop` can cross that boundary with an unknown size model while `RuntimeArray` is
rejected. Shader-interface-model support is unconditional because every pipeline selection carries
an interface contract. Generated selections couple the program and stage behind a non-public
initializer. Every compatibility call must name one of those selections explicitly, and the
pipeline closure receives that same validated value instead of independently choosing them again.

Source spans remain excluded from each `vgpu-native-program/v1` fingerprint as provenance, but they
are not trusted blindly: the verifier bounds-checks each span against its declared WGSL input and
requires the selected stage and exact authored entry name inside it. `Noop` deliberately gives that
authored name a different resolved WGSL identity, while the projection continues to link by the
resolved name. The root semantic fingerprint hashes the complete semantic object, so it still
commits to those spans and the runtime-projection fingerprint commits to them transitively through
that root hash. Crossed `Noop`/`RuntimeArray` and mismatched-authored-name spans are executable
negative canaries.

The sentinel deliberately has a `.metallib` filename so the same SwiftPM resource path is tested
in C3a and C3b. Its content is ordinary UTF-8 text and is never passed to Metal in C3a.

## C3b assertions

When `xcrun --find metallib` succeeds, the runner compiles both handwritten Metal canaries and
links them into one library. It invokes Apple's tools with an explicit
`air64-apple-macos14.0` target and `-std=macos-metal2.4`, records their observable versions in the
temporary artifact, packages the resulting library, revalidates the artifact, and executes the
generated C3 Metal probe. The probe loads the exact `Bundle.module` URL and recorded SHA before it
creates `vgpu_c3_noop` and dispatches.

The current handwritten C3b library contains and validates only the `Noop` and `RuntimeArray`
compute functions. It does not contain or look up the synthetic `SparseDraw` vertex and fragment
entries recorded by the structural fixture. C3b therefore does not yet prove that every projected
entry point exists in the packaged library or that the generated sparse render interface can create
a Metal render pipeline.

The target spelling is a fixture-local hypothesis until this gate runs on the supported Xcode
matrix. To keep the payload deployment target consistent with the projection and Swift package,
this fixture rejects a `C3_METAL_TARGET` other than `air64-apple-macos14.0` before compilation.

## Decisions intentionally left open

This fixture uses relative path dependencies because all three packages are assembled as siblings;
it deliberately does not simulate remote package resolution. The public generated-package choice
is `upToNextMinor` during `0.x`, which limits source-compatibility drift while allowing compatible
patch releases. Integer ABI compatibility still does not replace Swift package versioning.

The C3 Metal probe is not the proposed compare runner and does not appear in `projection.testing`.
It exists only to exercise the packaged no-op library when C3b can run. The future packaging
decision remains whether production generation should always emit a real compare runner or emit it
only when compare testing is enabled; this fixture does not choose between those options.

Likewise, the generated resource resolver is fixture-local. It proves `Bundle.module` behavior but
does not freeze a public `Bundle`, URL, or resolver-closure API.

## What remains open

Passing this spike does not close C3. The full gate still needs a real generated artifact connected
to C1, the production `VGPUABI` and runtime, the supported Xcode/macOS matrix, newest-generator to
oldest-runtime consumption, and execution on the declared hardware matrix. A real compare runner
must implement the request/response schemas, prove that protocol incompatibility blocks compare
without blocking application use, and define its build fingerprint inputs, including the Swift
runner target triple. This C3 probe claims none of those properties.
