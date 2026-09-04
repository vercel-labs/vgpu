# C1 semantic-to-compiler bridge

This spike connects vgpu's resolved WGSL graph to the accepted one-entry Tint compiler protocol.
Its executable slices now cover authenticated entry inventory, program selection, full-screen
source finalization, authenticated fixed-resource semantic extraction, fixed singular-resource
`semantic-v1` assembly, deterministic Metal slot allocation, exact per-entry projection, native
translation, and offline Metal compilation. The same one-shot Tint worker supplies inventory,
extraction, and translation without turning TypeScript into a second WGSL compiler.

## Hypothesis

A small authenticated Tint inventory can expose entry-point names and stages without asking
TypeScript to parse WGSL types. TypeScript can then select each program and, when an effect has no
authored vertex entry, inject the versioned full-screen source before finalizing the source capsule.
One backend-neutral, multi-entry Tint extraction per finalized capsule, module configuration, and
selected-entry set can produce the exact semantic evidence needed to assemble that program. A pure
TypeScript adapter can then project one translation request per selected entry point.

The final semantic extraction and every translation intentionally parse the same finalized bytes in
fresh processes. The semantic extraction is the WGSL authority; translation is a fail-closed check
against stale, crossed, or incorrectly projected requests. Reusing the same pinned Tint
implementation does not constitute a differential compiler proof, so Naga remains a separate
non-authoritative corpus oracle.

## Boundaries

The spike has five explicit owners:

1. `@vgpu/wgsl` resolves imports, emits relocatable WGSL, owns module-level provenance, and reports
   exact authored entry-declaration spans from its tokens.
2. A fresh Tint inventory authenticates the available entry names and stages against the resolved
   source capsule.
3. TypeScript selects programs, injects the versioned full-screen source when required, validates
   render links and authenticated semantic unions, derives visibility, allocates the versioned
   Metal ABI, and projects requests.
4. A fresh Tint extraction owns the complete backend-neutral semantics and exact-static override
   membership and values for every selected entry in the finalized capsule.
5. The existing Tint translator validates one request, generates MSL, and returns only the minimal
   Metal runtime projection.

Apple's offline `metal` and `metallib` tools remain a sixth, independent acceptance boundary. See
[`docs/boundary.md`](./docs/boundary.md) for the data flow and trust rules.

## Current executable evidence

`vgpu-native-tint-entry-inventory/v1` is implemented as a second contract in the existing one-shot
Tint worker. The worker dispatches inventory or translation from the request's exact `contractId`;
each invocation still accepts one framed request and exits.

The inventory caller uses a deterministic JSON encoder that sorts object keys but never normalizes
string values. In particular, WGSL code units and their UTF-8 encoding remain exact. The response
authenticates those encoded request bytes with:

```text
SHA-256(UTF-8("vgpu-native-tint-entry-inventory-request-bytes/v1")
  || 0x00
  || exact encoded request bytes)
```

The request separately authenticates the origin map with a SHA-256 of its deterministic,
key-sorted JSON encoding. The TypeScript caller requires the source `virtualPath` and every origin
map input ID to be NFC before encoding; it does not apply that requirement to WGSL text. The
standalone worker validates UTF-8, shape, hashes, and protocol invariants but does not independently
prove NFC, so canonical path and input identities remain a caller precondition.

The checked-in gate covers four request fixtures, four response fixtures, thirteen prelaunch
mutations including cyclic and non-NFC requests, five response mutations, one retained-request
association mutation, and zero worker launches for all prelaunch failures. With a native worker it
performs thirteen invocations: each fixture twice, four raw protocol mutations, and one valid NFC
Unicode origin-map case. Static Unicode canaries also prove that decomposed WGSL survives wire
encoding without normalization and that path limits count Unicode code points consistently.

The next executable slice accepts a successful request/response pair only after both inventory JSON
Schemas and semantic association checks pass. It mints a frozen in-process inventory whose nominal
brand is lost by cloning or deserialization. The pure program selector consumes an exact
configuration-owned selection view and that branded inventory; it never receives WGSL or resolver
reflection. It selects an explicit entry or the only entry in each required stage, ignores stages
the program does not use, and emits a versioned injection directive only for an effect with no
authored vertex.

The selection gate passes twelve positive cases, twenty selection failures, and three inventory
authentication failures. It covers effect, draw, and compute programs; defaulted effect kind;
explicit and inferred normalization; missing, ambiguous, unknown, and wrong-stage entries; source
crossing; schema-invalid inventory records; cloning; accessors; `null`; prototype pollution; and
deterministic frozen output. See [`docs/program-selection.md`](./docs/program-selection.md) for the
ownership and error contracts.

The full-screen finalizer now consumes that exact nominal inventory/selection pair, renders the
versioned triangle, appends it without rewriting authored bytes, and produces a frozen finalized
capsule with a generated provenance gap. Its static gate passes eight positive cases and ten local
failures. With the accepted native worker it performs three inventory invocations: one over the
authored source and two byte-deterministic runs over the finalized source. Both final runs expose
exactly the derived vertex and authored fragment. The final inventory request also repeats the
complete semantic/resource preflight before a worker can launch. Resolver-owned declaration spans
remain a sibling input for program assembly; the finalizer neither rewrites nor claims to validate
them. See [`docs/fullscreen-injection.md`](./docs/fullscreen-injection.md) for the exact profile and
remaining semantic gates.

`vgpu-native-tint-semantic-extraction/v1` is now implemented as the worker's third contract. Its
current executable profile accepts one selected compute entry or one selected vertex-fragment pair
when that program has no active overrides and every active resource is singular with a fixed-size
layout. It extracts canonical stage interfaces and literal compute workgroup sizes from fresh
per-entry lowered IR, and combines them with Inspector-owned active bindings and sampling pairs.
Runtime-sized buffers, resource binding arrays, configured or active overrides, and non-literal
workgroup sizes still produce structured failures.

The semantic gate freezes four request/response pairs, nine prelaunch mutations, thirty-one
response mutations, and three static nominal authentications. Against the native worker it runs
twenty-three one-shot requests. The primary resource fixture proves a numeric five-binding union at
`b0`, `b1`, `b2`, `b3`, and `b10`, exact stage subsets, one shared uniform, seven content-addressed
types, six layouts, and buffer minimum sizes of 8, 24, and 16 bytes. Additional canaries cover an
authored fixed `@size`, a simple storage texture, cross-stage Dawn-like sampler/texture resolution,
runtime-array and binding-array rejection, inactive declarations, deterministic interface-only
successes, malformed protocol requests, and request-specific adapter authentication.

The assembly gate resolves authored effect, multi-module draw, compute, and fixed-resource
fixtures, retains nominal resolver declaration evidence, authenticates extraction, emits four
schema-valid `semantic-v1` programs, and checks render linking, resource joins, exact extraction
reprojection, and fingerprints. All four fixtures receive nominal program-level Metal allocations
and project seven compiler requests without launching the translator; overrides remain outside the
executable assembly profile.
Its numeric `b0`, `b1`, `b2`, `b3`, and `b10` union preserves exact subsets, sampling pair, and
derived visibility. Seven extracted types become eight semantic types after interface interning;
six layouts and buffer minima of 8, 24, and 16 bytes remain exact. Declaration v2 retains binding,
struct, and member symbols alongside entry spans. Swift presentation preserves exact authored names
without recasing, suffixing, or backticks. Per-program assembly rejects noncanonical and Swift 6
reserved names, the `_vgpu` helper namespace, generated module namespaces in nominal positions, and
case-insensitive collisions within the binding set or one struct's members. Final aggregation owns
collisions created by local or shared type placement and generated program API names.

The static matrix covers five nominal, five declaration, three resolver-symbol, three
resolver-resource-join, two retained-snapshot, one profile, one link, five fingerprint, twelve
Swift-name, four slot-allocation, and two projection failures. A separate stage-isolation check
proves that one semantic buffer can receive different vertex and fragment indices.

With the native worker the gate performs eight semantic-extraction invocations, then translates the
fixed-resource vertex and fragment entries twice each. It freezes every request, response, and MSL
hash, compiles both MSL sources to AIR, and links one metallib. See
[`docs/semantic-extraction/assembly.md`](./docs/semantic-extraction/assembly.md) and
[`docs/semantic-extraction/metal-slot-projection.md`](./docs/semantic-extraction/metal-slot-projection.md).

The integrated full-screen canary carries one real resolved and finalized resource-free effect
through two native semantic extractions, semantic assembly, two deterministic translations per
entry, two offline AIR compilations, one metallib link, and two live 2x2 readbacks. Its nine one-shot
Tint processes are one inventory, two semantic extractions, four successful translations, and two
runs of one structured negative. The checked-in interface JSON is only the static oracle; compiler
requests are projected from the nominal assembly. The authored fragment retains the exact resolver span
`6:1–9:2`. The run proves top-origin UV and counter-clockwise `front_facing` with a clockwise control
on Apple M4 Pro. See [`docs/fullscreen-metal.md`](./docs/fullscreen-metal.md).

## Fixture strategy

Start with a small multi-module closure that covers render, compute, resources, overrides, sparse
interfaces, and generated full-screen source. Resource-free effect, draw, and compute requests plus
one fixed-resource render pair are now derived; exact-static overrides and the broader resource
profile remain. Once every request is derived, run the repository corpus through the same bridge
and compile every successful MSL result for the `air64-apple-macos14.0` target.

The fixture inventory and mutation matrix are specified in
[`docs/fixtures.md`](./docs/fixtures.md). The exact conditions for accepting or discarding this
candidate are in [`docs/exit-conditions.md`](./docs/exit-conditions.md).

The semantic work is split by responsibility so the growing design remains reviewable:

- [`docs/semantic-extraction/contract.md`](./docs/semantic-extraction/contract.md) freezes request
  scope, authentication, response ownership, and process isolation;
- [`docs/semantic-extraction/sampling-and-types.md`](./docs/semantic-extraction/sampling-and-types.md)
  freezes resources, sampling-pair resolution, content-addressed types/layouts, and ordering; and
- [`docs/semantic-extraction/assembly.md`](./docs/semantic-extraction/assembly.md) freezes the pure
  TypeScript join, render linking, and fingerprint exclusions; and
- [`docs/semantic-extraction/metal-slot-projection.md`](./docs/semantic-extraction/metal-slot-projection.md)
  freezes slot ownership, per-entry compiler projection, and the connected offline evidence.

## Implementation order

1. Add an authenticated entry-inventory operation to the vgpu Tint tool. This slice is executable.
2. Select programs from a nominally authenticated inventory. This slice is executable.
3. Inject the versioned full-screen source when required and finalize the exact source, source hash,
   origin map, and origin-map hash. This source-finalization slice is executable; resolver-owned
   entry declarations remain unchanged alongside it until program assembly.
4. Add a multi-entry semantic-extraction operation. The fixed singular-resource profile is
   executable; runtime-sized layouts, binding arrays, and the existing exact-static override
   materializer remain next.
5. Assemble and schema-validate `semantic-v1` from that authenticated response and the resolver's
   proven entry spans and resource-symbol evidence. Resource-free effect, multi-module draw, and
   compute programs plus fixed singular resources are executable.
6. Allocate program-level slots and derive one existing compiler request per entry point. This is
   executable for resource-free programs and singular fixed-size resources.
7. Validate translator responses without compacting indices. The fixed-resource pair is executable;
   program-level `metal-projection-v1` combination remains open.
8. Compile and link every accepted MSL source offline. The fixed-resource pair is executable; the
   authenticated repository corpus remains open.
9. Run the authenticated repository corpus and record expected failures separately.

## Non-goals

This spike does not yet connect overrides, runtime-sized resources, or the broader resource profile
through assembly and projection. It also does not bind the fixed-resource fixture at runtime, run
the integrated repository corpus, package a production artifact, implement the production Swift runtime, freeze a
Dawn/Tint source revision, or establish Intel or AMD GPU support. It also does not recover general
authored diagnostic spans from the current module-only origin map. Exact authored entry-declaration
spans come from resolver tokens and use 1-based locations, UTF-16-code-unit columns, and an
end-exclusive boundary. Tint diagnostics instead report UTF-8 byte columns; consumers must not
combine the two coordinate systems. The spike also does not expose broad Tint reflection in
generated Swift or the Metal runtime artifact.
