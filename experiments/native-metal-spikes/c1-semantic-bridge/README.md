# C1 semantic-to-compiler bridge

This spike connects vgpu's resolved WGSL graph to the accepted one-entry Tint compiler protocol.
Its executable slices now cover authenticated entry inventory, program selection, full-screen
source finalization, and authenticated semantic extraction for fixed resources, runtime-sized
storage, and exact-static overrides. The fixed-resource, runtime-sized, and override profiles
additionally pass `semantic-v1` assembly, deterministic Metal slot allocation, exact per-entry
projection, native translation, and offline Metal compilation. Fixed direct-resource binding
passes an exact live Metal readback; a second live path observes baked, stage-specific override
values without runtime specialization; and the runtime-sized compute path passes live range packing,
binding, dispatch, and readback. The same one-shot Tint worker supplies inventory, extraction, and
translation without turning TypeScript into a second WGSL compiler.

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

The spike has six explicit owners:

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
6. The runtime derives one resource layout from the nominal program projection, validates a complete
   logical resource set, and encodes only through the context, layout, and pipeline owned by one
   nominal render program.

Apple's offline `metal` and `metallib` tools and the live Metal device remain independent acceptance
boundaries. See [`docs/boundary.md`](./docs/boundary.md) for the data flow and trust rules.

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

The authenticated inventory layer accepts a successful request/response pair only after both JSON
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
with singular active resources, including runtime-sized storage buffers, and scalar exact-static
overrides. It extracts canonical stage interfaces, exact per-entry override subsets, their typed
program union, and positive compute workgroup dimensions resolved from constant or
override-dependent expressions in fresh per-entry lowered IR. Inspector-owned active bindings and
sampling pairs remain part of the same result. Resource binding arrays and runtime-sized uniform
layouts still fail closed.

The passing semantic gate freezes nine request/response pairs. Its static run covers ten prelaunch
failures, twenty-four override-response mutations, thirty-three response mutations, and six focused
runtime-graph checks. The native run reports fifty invocations, ten deterministic repeats, nine
crossed-request checks, five override-fixture successes, two runtime-sized resource successes, two
inactive-configuration successes, one constant-expression success, seven override-semantic
failures, one unsupported-resource failure, and ten protocol failures. The primary resource fixture proves a
numeric five-binding union at
`b0`, `b1`, `b2`, `b3`, and `b10`, exact stage subsets, one shared uniform, seven content-addressed
types, six layouts, and buffer minimum sizes of 8, 24, and 16 bytes. Additional canaries cover an
authored fixed `@size`, a simple storage texture, cross-stage Dawn-like sampler/texture resolution,
a root runtime array, a fixed prefix plus runtime array of authored-size structs, binding-array
rejection, inactive declarations and configurations, typed
override defaults and selections, authored `@id`, exact override unions and subsets, deterministic
successes, malformed protocol requests, and request-specific adapter authentication.

The override-configuration wire now uses WGSL's single pipeline-overridable constant identifier:
the canonical decimal authored `@id` when present, otherwise the declaration name. The schema,
JavaScript producer checks, and native decoder agree on canonical IDs in `0...65535`, strict ASCII
ordering, and rejection of the legacy `name` field. Non-empty configuration is executable. A valid
configured declaration that is inactive in the selected program is accepted but omitted from the
result; result records retain typed `selected` values, evaluable defaults, and authored numeric IDs.

The assembly gate resolves authored effect, multi-module draw, compute, fixed-resource,
runtime-sized storage, and five exact-static override fixtures. It retains nominal resolver
declaration evidence, authenticates extraction, emits ten schema-valid `semantic-v1` programs, and
checks render linking, resource and override joins, exact extraction reprojection, and
fingerprints. All ten fixtures receive nominal program-level Metal allocations and project fourteen
compiler requests without launching the translator.
Its numeric `b0`, `b1`, `b2`, `b3`, and `b10` union preserves exact subsets, sampling pair, and
derived visibility. Seven extracted types become eight semantic types after interface interning;
six layouts and buffer minima of 8, 24, and 16 bytes remain exact. Declaration v3 also retains
override symbols and authored numeric IDs alongside binding, struct, member, and entry evidence.
Swift presentation preserves exact authored names without recasing, suffixing, or backticks.
Per-program assembly rejects noncanonical and Swift 6 reserved names, the `_vgpu` helper namespace,
generated module namespaces in nominal positions, and case-insensitive collisions within bindings,
overrides, or one struct's members. Final aggregation owns collisions created by local or shared type
placement and generated program API names.

The static matrix covers five nominal, five declaration, three resolver-symbol, three
resolver-resource-join, fifteen resolver-override, two retained-snapshot, six override-configuration,
one profile, one link, five fingerprint, fourteen Swift-name, four slot-allocation, and two
projection failures. A separate stage-isolation check proves that one semantic buffer can receive
different vertex and fragment indices. Thirteen authenticated static compiler translations
assemble nine exact `metal-projection-v1` program fragments under nominal ownership; the
runtime-sized request is intentionally not backed by a synthetic compiler response. Their
permutations remain canonical. Nineteen response/combination failures, fourteen independent
verifier canaries, and four
device-requirement checks cover response association, exact entry override subsets and their union,
stage closure, compiler identity, internal reservations, slot collisions, runtime-size regions,
compute dimensions, and fail-closed requirements. Twenty-seven runtime-resource-layout checks cover
nominal ownership, canonical projection, exact fixed-resource descriptors and slots, and exclusion
of MSL, presentation names, and inactive candidate bindings.

With the native worker the gate performs twenty semantic-extraction invocations for ten
deterministic fixtures. It translates the fixed-resource vertex and fragment entries twice each,
the runtime-sized compute entry twice, then six exact-static override entries twice each across
five projected programs. Every response is authenticated against its exact per-entry request. The
runtime-sized translations are byte-identical, assemble one authenticated projection with external
`buffer(0)`, effective immediate-data `buffer(30)`, and a size region at byte `4`, and compile and
link offline. In each of two live M4 Pro processes, two dispatches reuse one backing allocation and
binding offset with effective ranges `28` and `52`, upload immediate words `[0, 28]` and `[0, 52]`,
and read back `[2, 202]` and `[4, 404]`. The override programs preserve a
dependent default, an explicitly bypassed initializer, an equivalent explicit default, different
render-stage subsets, and all five scalar kinds including `f16`. Their six retained MSL sources
contain no `function_constant`, compile to AIR, and link into five metallibs. The render program also
passes an exact four-pixel readback in two independent Swift/Metal processes, with two renders per
process. Its functions are loaded directly by emitted name without `MTLFunctionConstantValues`. See
[`docs/semantic-extraction/override-metal.md`](./docs/semantic-extraction/override-metal.md).

The fixed-resource path compiles both retained MSL sources to AIR and links one metallib exclusively
through the nominal program-projection accessor. It then derives the joined runtime layout from that
same projection, prepares five logical resources into six stage-local commands, and runs two
byte-identical Swift/Metal processes that each validate two renders against the exact readback.
Fifteen preparation failures, two crossed-program encoding failures, and four malformed test
manifests fail at their named boundaries. See
[`docs/semantic-extraction/assembly.md`](./docs/semantic-extraction/assembly.md) and
[`docs/semantic-extraction/metal-slot-projection.md`](./docs/semantic-extraction/metal-slot-projection.md),
[`docs/semantic-extraction/compiler-response-assembly.md`](./docs/semantic-extraction/compiler-response-assembly.md),
and
[`docs/semantic-extraction/runtime-resource-binding.md`](./docs/semantic-extraction/runtime-resource-binding.md).

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
one fixed-resource render pair, one runtime-sized compute program, and five exact-static override
programs are now derived through offline Metal. The runtime-sized compute program and one override
render program additionally pass exact live readbacks. The broader resource profile and repository
corpus coverage remain. Once every request is derived, run
the repository corpus through the same bridge and compile every successful MSL result for the
`air64-apple-macos14.0` target.

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
- [`docs/semantic-extraction/exact-static-overrides.md`](./docs/semantic-extraction/exact-static-overrides.md)
  records executable override materialization, assembly, exact per-entry projection, offline Metal
  evidence, and live observation; and
- [`docs/semantic-extraction/override-metal.md`](./docs/semantic-extraction/override-metal.md)
  records the exact live override signature and the absence of runtime specialization; and
- [`docs/semantic-extraction/metal-slot-projection.md`](./docs/semantic-extraction/metal-slot-projection.md)
  freezes slot ownership, per-entry compiler projection, and the connected offline evidence; and
- [`docs/semantic-extraction/compiler-response-assembly.md`](./docs/semantic-extraction/compiler-response-assembly.md)
  records the executable nominal response-to-program-projection boundary; and
- [`docs/semantic-extraction/runtime-resource-binding.md`](./docs/semantic-extraction/runtime-resource-binding.md)
  records the executable nominal semantic/slot join, program ownership, and prepare/encode boundary
  for the fixed direct-resource gate; and
- [`docs/runtime-sized-storage/`](./docs/runtime-sized-storage/README.md) separates the connected
  runtime-sized semantic, projection, translation, offline, and live-binding boundaries.

## Implementation order

1. Add an authenticated entry-inventory operation to the vgpu Tint tool. This slice is executable.
2. Select programs from a nominally authenticated inventory. This slice is executable.
3. Inject the versioned full-screen source when required and finalize the exact source, source hash,
   origin map, and origin-map hash. This source-finalization slice is executable; resolver-owned
   entry declarations remain unchanged alongside it until program assembly.
4. Add a multi-entry semantic-extraction operation. Singular fixed and runtime-sized storage
   resources are executable, including explicit array-element layout edges, exact-static scalar
   overrides, and resolved constant-expression workgroup dimensions; binding arrays remain open.
5. Assemble and schema-validate `semantic-v1` from that authenticated response and the resolver's
   proven entry spans and resource-symbol evidence. Resource-free effect, multi-module draw, and
   compute programs, fixed and runtime-sized singular resources, and exact-static overrides are
   executable.
6. Allocate program-level slots and derive one existing compiler request per entry point. This is
   executable for resource-free programs, singular fixed-size and runtime-sized resources, and
   exact-static overrides.
7. Authenticate translator responses without compacting indices and combine the exact selected
   stage set into `$defs/program` of `metal-projection-v1`. Resource-free effect/draw, compute, and
   the fixed-resource, runtime-sized, and exact-static override fixtures are executable.
8. Compile and link every accepted MSL source offline. The fixed-resource, runtime-sized, and
   exact-static override fixtures are executable; the authenticated repository corpus remains open.
9. Join semantic resource constraints to projected slots, prepare complete logical resource sets,
   bind the fixed-resource render pair and runtime-sized compute buffer, and observe baked override
   values at runtime. These live canaries are executable; general resources and the production Swift
   runtime remain open.
10. Run the authenticated repository corpus and record expected failures separately.

## Non-goals

This spike does not yet connect the broader resource profile, run the integrated repository corpus,
package a production artifact, implement the production Swift runtime, freeze a Dawn/Tint source
revision, or establish
Intel or AMD GPU support. It also does not
recover general authored diagnostic spans from the current module-only origin map. Exact authored
entry-declaration spans come from resolver tokens and use 1-based locations, UTF-16-code-unit
columns, and an end-exclusive boundary. Tint diagnostics instead report UTF-8 byte columns;
consumers must not combine the two coordinate systems. The spike also does not expose broad Tint
reflection in generated Swift or the Metal runtime artifact.
