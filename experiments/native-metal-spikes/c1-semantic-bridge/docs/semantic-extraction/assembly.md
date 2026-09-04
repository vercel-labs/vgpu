# Semantic program assembly

Assembly is a pure TypeScript join. It consumes one authenticated extraction, the exact nominal
selection/finalization objects that produced its request, resolver-owned authored declaration and
resource-symbol evidence, and deterministic presentation policy. It does not parse WGSL or consult
mutable `ResolvedShader.reflection` after that evidence is minted. The executable profile accepts
singular resources with fixed-size layouts and programs without overrides.

## Ownership of the join

The adapter adds facts that Tint cannot or should not own:

- `effect`, `draw`, or `compute` kind;
- authored versus injected entry origin;
- authored entry names and exact resolver-token declaration spans;
- module, program, Swift, and emitted Metal names;
- source IDs from the finalized origin map;
- validation of program-wide unions and derived stage visibility;
- backend-neutral capability policy;
- fingerprints; and
- versioned Metal slot allocation after backend-neutral assembly.

Tint remains authoritative for interfaces, active bindings, sampling pairs, exact-static
overrides, types, layouts, and resolved workgroup size. Interning an authenticated inline interface
shape into a content-addressed semantic type ID is adapter normalization, not type inference. The
adapter uses the exact `vgpu-native-semantic-type/v1` hash domain. The adapter can
reject inconsistent facts but cannot repair or approximate them.

## Assembly invariants

The complete adapter must prove all of the following before producing `semantic-v1`:

1. The extraction is nominally attached to the exact request bytes, finalized capsule, and
   selection instances retained by the caller.
2. The response entries equal the selected names and stages exactly. A render response has vertex
   then fragment; compute has only compute.
3. Every authored entry has one resolver-token span whose input belongs to the origin map. Its
   snippet contains the authored name, not the resolved or generated WGSL name. Injected entries
   omit both authored name and source span.
4. Every entry binding and sampling pair references an active result binding; every declared result
   binding is active in at least one selected entry. Derived visibility is exactly the set of those
   stages.
5. The result override array is exactly the union of the entry override sets, and selected/default
   values agree wherever an override is shared.
6. Types and layouts have valid content IDs and form exactly the reachable transitive closure. No
   dangling or extra graph node is accepted.
7. Entry interfaces, binding arrays, override arrays, features, and root unions use their contract
   canonical order.
8. Root capabilities are the exact union of program capabilities. Language features equal the
   explicit request set; execution requirements come from versioned adapter policy applied only to
   authenticated facts.

The executable profile applies the association, entry, source-span, resource-symbol join, link,
canonical ordering, transitive type/layout closure, capability, exact reprojection, and fingerprint
checks now. It copies the authenticated program binding union, entry subsets, sampling pairs, types,
and layouts exactly, then derives only stage visibility and Swift presentation. It accepts singular
fixed-size resources and rejects `dual_source_blending`. Exact-static override unions remain a
later slice rather than a partially populated success; their selected join is specified in
[`exact-static-overrides.md`](./exact-static-overrides.md). Metal slots are derived only after this
backend-neutral assembly is complete.

For semantic v1, `program.sources` contains every WGSL input listed by the finalized origin map.
Module-level provenance cannot honestly claim a smaller entry-reachability set, so assembly does
not guess one. The program fingerprint still pairs those source IDs with exact input hashes.

## Interface linking

Render linking happens after extraction and before slot allocation or translation. For every
fragment input location, the vertex output must contain the same location, semantic type,
normalized interpolation, and invariance. A vertex may export additional locations. Built-ins are
stage contracts and do not link by numeric location.

Interface arrays retain extractor order: user locations first and built-ins second. Sparse values
are never compacted. This is the same order required by the compiler request protocol, so request
projection does not introduce a second sorting policy.

An effect with the generated full-screen vertex goes through the identical linker. Its vertex entry
has `origin: "injected"`, only `names.wgsl`, no `source`, and authenticated extracted I/O. The
fragment remains authored with `names.authored`, `names.wgsl`, and its resolver-owned span.

## Presentation and stable identity

Swift identifiers preserve their exact authored spelling. Assembly does not recase, suffix, or
backtick an identifier. Per-program assembly rejects noncanonical names, Swift 6 reserved
identifiers, the `_vgpu` helper namespace, `Swift`, `Foundation`, or `VGPUABI` in nominal
positions, and case-insensitive collisions within the binding set or one struct's members. It
deliberately does not compare module, program, and struct names with each other or reserve
`Bindings`, `artifact`, and conditional `Vertex`: final aggregation owns those checks after it
decides local versus shared type placement. Swift names do not enter type or layout content IDs or
program fingerprints. The arbitrary semantic override `id` is removed:
`names.wgsl` is its stable program-local identity, `names.authored` preserves public diagnostics,
and optional `wgslId` preserves an authored numeric WGSL ID.

An interface leaf's optional `name` is diagnostic context only. It may enter the complete semantic
artifact when independently proven, but it is excluded from the program fingerprint. With
referenced source hashes held constant, changing only that metadata must not change the program
fingerprint; it can still change complete semantic and transitive artifact hashes. The extractor's
first implementation omits these names rather than manufacturing lowered symbols.

The program fingerprint includes selected resolved WGSL IDs and hashes, the layout model, explicit
language features, normalized executable program semantics and capabilities, and only the reachable
type/layout closure. It excludes its own value, redundant `sources`, Swift names, source spans, and
interface diagnostic names. Arrays declared as sets are sorted before hashing; interface and member
arrays keep their semantic order.

## Translator projection

Only a validated assembled program can create compiler requests. Each selected entry receives:

- source text, source identity, source hash, and origin map copied from the finalized capsule;
- stage, resolved WGSL name, interface, exact-static selected overrides, and language features
  projected from the authenticated semantic graph; and
- emitted Metal name plus external and candidate internal slots from versioned adapter policy.

The projector rehydrates every interface type from the assembled content IDs, then requires exact
equality with the retained authenticated extraction before it can return a compiler request. It
also requires a frozen nominal Metal allocation minted for that exact assembly. A clone, a
hand-written map, or an allocation belonging to a structurally equal but distinct assembly fails
before translation. Resource-free and fixed-size singular-resource programs now use the same
projection path; only their derived external slot sets differ.

For each interface leaf, projection resolves the semantic type ID, proves that it is a scalar or
vector of one scalar, and emits the original authenticated inline `{ scalar, width }` shape. It
rejects any mismatch with the retained extraction instead of reconstructing a type from WGSL. The
translator then starts in a fresh process, parses the same bytes, materializes the supplied values,
and compares the complete entry interface and resource mapping before MSL generation. A local
projection bug therefore fails closed instead of silently changing the runtime artifact.

The connected resource gate now authenticates each one-shot response against its schema and exact
nominal request, including the external map and empty effective internal result expected by the
fixture. It combines the complete stage set into the exact `$defs/program` fragment, preserving
sparse interface indices, stage-local slots, effective internal resources, storage-size regions,
and resolved compute dimensions. Broad extraction facts remain in `semantic-v1`; they are not
copied into the runtime projection. Top-level target, toolchain, metallib, fingerprint, and module
aggregation remain a subsequent artifact slice. Slot ownership and the candidate-versus-effective
split are detailed in [`metal-slot-projection.md`](./metal-slot-projection.md).

## Executable evidence

The static assembly gate resolves effect, multi-module draw, compute, and fixed-resource fixtures,
mints declaration evidence only through those real resolver calls, authenticates reviewed
extraction responses, and assembles four schema-valid programs. The resolved-declarations v2
snapshot retains entry spans plus binding, struct, and member symbol evidence. Four nominal slot
allocations project seven compiler requests, including both fixed-resource render stages. The gate
covers five nominal failures, five declaration failures including a cross-module span
mutation, three resolver-symbol failures, three resolver-resource-join failures, two retained
resolver-snapshot checks, one rejected profile, one broken render link, five fingerprint checks,
twelve Swift-name failures, four slot-allocation failures, and two projection failures. One
additional mutation proves stage-local buffer indices can differ for a shared semantic binding.
None of those checks launches the translator. The draw case
also proves that the resolver preserves public entry names while mangling imported helpers and
module-local types; `names.authored` and `names.wgsl` retain their separate authorities even when
their current values are equal.

The resource fixture has the numeric binding union `b0`, `b1`, `b2`, `b3`, and `b10`, exact entry
subsets, one filtering sampling pair, and visibility derived from those subsets. Its seven extracted
types become eight semantic types after interface interning, while all six layouts remain exact;
the three buffer minimum sizes are 8, 24, and 16 bytes. Reprojection removes only adapter-owned
presentation and visibility and must reproduce the complete authenticated extraction exactly.

With the accepted native worker, the gate performs eight semantic-extraction invocations: two
byte-identical runs for each of four fixtures. Seven static compiler translations assemble four
schema-valid program projections, with nineteen authentication/combination failures and independent
slot, runtime-region, workgroup, and requirements canaries. It then translates the resource vertex
and fragment twice each, authenticates one result per stage, compiles two AIR files for the macOS 14
target through the projection source accessor, and links one metallib. The resulting program
preserves the requested external slots and reports no effective internal binding or size region. A
nominal join derives its runtime layout from that program alone; two Swift processes then prepare
five logical resources into six stage-local commands and each validate two renders against the
exact expected readback. Pipeline reflection remains an independent oracle rather than binding
authority. The complete fixed-resource evidence is recorded in
[`runtime-resource-binding.md`](./runtime-resource-binding.md).
The independently integrated full-screen companion runs one
inventory, two semantic extractions, four successful translations, two structured-negative
translations, combines a resource-free program projection, and performs live readback. Its compiler
requests come from the nominal assembly, while the checked-in interface JSON remains a static
oracle. The authored fragment's resolver-owned
end-exclusive span is exactly `6:1–9:2`; the injected vertex omits authored provenance. Exact-static
overrides, broader resource runtime coverage, repository corpus integration, production artifact
packaging, and Intel/AMD hardware evidence remain open.
