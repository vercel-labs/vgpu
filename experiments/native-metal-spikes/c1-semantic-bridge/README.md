# C1 semantic-to-compiler bridge

This spike connects vgpu's resolved WGSL graph to the accepted one-entry Tint compiler protocol.
Its executable slices now cover authenticated entry inventory, program selection, full-screen
source finalization, the first authenticated semantic-extraction profile, and interface-only
`semantic-v1` assembly. The same one-shot Tint worker supplies inventory, extraction, and
translation. This closes the interface-only path between the isolated semantic, translation, and
offline Metal proofs without turning TypeScript into a second WGSL compiler.

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
   render links, builds semantic unions, allocates the versioned Metal ABI, and projects requests.
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
first executable profile accepts one selected compute entry or one selected vertex-fragment pair
when that program has no active resources or overrides. It extracts canonical stage interfaces and
literal compute workgroup sizes from fresh per-entry lowered IR, while returning distinct
structured failures for configured overrides, active resources, active overrides, and non-literal
workgroup sizes.

The semantic gate freezes four request/response pairs, nine prelaunch mutations, fifteen response
mutations, and two static nominal authentications. Against the native worker it runs eighteen
one-shot requests. These include deterministic render and compute successes, an interface that
extracts even though assembly will later reject its render link, the generated full-screen vertex,
inactive resource and override declarations, the interface-size boundary, malformed protocol
requests, and request-specific adapter authentication.

The interface-only assembly gate resolves authored effect and compute fixtures, retains nominal
resolver declaration evidence, authenticates extraction, emits schema-valid `semantic-v1`, checks
render linking and fingerprints, and projects three compiler requests without launching the
translator. With the native worker it performs four semantic-extraction invocations: two
byte-identical runs for each fixture. Active resources and overrides remain outside this first
profile. See
[`docs/semantic-extraction/assembly.md`](./docs/semantic-extraction/assembly.md).

The integrated full-screen canary carries one real resolved and finalized effect through two native
semantic extractions, interface-only assembly, two deterministic translations per entry, two
offline AIR compilations, one metallib link, and two live 2x2 readbacks. Its nine one-shot Tint
processes are one inventory, two semantic extractions, four successful translations, and two runs of
one structured negative. The checked-in interface JSON is only the static oracle; compiler requests
are projected from the nominal assembly. The authored fragment retains the exact resolver span
`6:1–9:2`. The run proves top-origin UV and counter-clockwise `front_facing` with a clockwise control
on Apple M4 Pro. See [`docs/fullscreen-metal.md`](./docs/fullscreen-metal.md).

## Fixture strategy

Start with a small multi-module closure that covers render, compute, resources, overrides, sparse
interfaces, and generated full-screen source. The interface-only effect and compute requests are now
derived; resources, overrides, and program-level slot allocation remain. Once every request is
derived, run the repository corpus through the same bridge and compile every successful MSL result
for the `air64-apple-macos14.0` target.

The fixture inventory and mutation matrix are specified in
[`docs/fixtures.md`](./docs/fixtures.md). The exact conditions for accepting or discarding this
candidate are in [`docs/exit-conditions.md`](./docs/exit-conditions.md).

The semantic work is split by responsibility so the growing design remains reviewable:

- [`docs/semantic-extraction/contract.md`](./docs/semantic-extraction/contract.md) freezes request
  scope, authentication, response ownership, and process isolation;
- [`docs/semantic-extraction/sampling-and-types.md`](./docs/semantic-extraction/sampling-and-types.md)
  freezes resources, sampling-pair resolution, content-addressed types/layouts, and ordering; and
- [`docs/semantic-extraction/assembly.md`](./docs/semantic-extraction/assembly.md) freezes the pure
  TypeScript join, render linking, fingerprint exclusions, and translator projection.

## Implementation order

1. Add an authenticated entry-inventory operation to the vgpu Tint tool. This slice is executable.
2. Select programs from a nominally authenticated inventory. This slice is executable.
3. Inject the versioned full-screen source when required and finalize the exact source, source hash,
   origin map, and origin-map hash. This source-finalization slice is executable; resolver-owned
   entry declarations remain unchanged alongside it until program assembly.
4. Add a multi-entry semantic-extraction operation. The interface-only profile is executable;
   active resource extraction and the existing exact-static override materializer remain next.
5. Assemble and schema-validate `semantic-v1` from that authenticated response and the resolver's
   proven declaration spans. The interface-only effect and compute slice is executable.
6. Allocate program-level slots and derive one existing compiler request per entry point. Projection
   with empty external bindings and overrides is executable; allocation remains open.
7. Validate and combine translator responses into `metal-projection-v1` without compacting indices.
8. Compile and link every accepted MSL source offline.
9. Run the authenticated repository corpus and record expected failures separately.

## Non-goals

This spike does not yet connect active resources or overrides through assembly, run the integrated
repository corpus, package a production artifact, implement the production Swift runtime, freeze a
Dawn/Tint source revision, or establish Intel or AMD GPU support. It also does not recover general
authored diagnostic spans from the current module-only origin map. Exact authored entry-declaration
spans come from resolver tokens and use 1-based locations, UTF-16-code-unit columns, and an
end-exclusive boundary. Tint diagnostics instead report UTF-8 byte columns; consumers must not
combine the two coordinate systems. The spike also does not expose broad Tint reflection in
generated Swift or the Metal runtime artifact.
