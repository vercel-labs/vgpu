# C1 semantic-to-compiler bridge

This spike connects vgpu's resolved WGSL graph to the accepted one-entry Tint compiler protocol.
It closes the gap between isolated semantic, override, slot-allocation, translation, and offline
Metal proofs without turning TypeScript into a second WGSL compiler.

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

## Fixture strategy

Start with a small multi-module closure that covers render, compute, resources, overrides, sparse
interfaces, and generated full-screen source. Once every request is derived rather than handwritten,
run the repository corpus through the same bridge and compile every successful MSL result for the
`air64-apple-macos14.0` target.

The fixture inventory and mutation matrix are specified in
[`docs/fixtures.md`](./docs/fixtures.md). The exact conditions for accepting or discarding this
candidate are in [`docs/exit-conditions.md`](./docs/exit-conditions.md).

## Implementation order

1. Add an authenticated entry-inventory operation to the vgpu Tint tool.
2. Select programs in TypeScript, inject the versioned full-screen source when required, and
   finalize the exact source, source hash, origin map, origin-map hash, and entry-declaration spans.
3. Add a multi-entry semantic-extraction operation and connect the existing exact-static override
   materializer to it.
4. Assemble and schema-validate `semantic-v1` from that authenticated response and the resolver's
   proven declaration spans.
5. Allocate program-level slots and derive one existing compiler request per entry point.
6. Validate and combine translator responses into `metal-projection-v1` without compacting indices.
7. Compile and link every accepted MSL source offline.
8. Run the authenticated repository corpus and record expected failures separately.

## Non-goals

This spike does not implement the Swift runtime, freeze a Dawn/Tint source revision, establish Intel
or AMD GPU support, recover general authored diagnostic spans from the current module-only origin
map, or prove a production artifact. Exact authored entry-declaration spans are still required and
come from resolver tokens. The spike also does not expose broad Tint reflection in generated Swift
or the Metal runtime artifact.
