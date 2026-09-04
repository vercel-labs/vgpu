# Semantic program assembly

Assembly is a pure TypeScript join. It consumes one authenticated extraction, the exact nominal
selection/finalization objects that produced its request, resolver-owned authored declaration
spans, and deterministic presentation policy. It does not parse WGSL or consult
`ResolvedShader.reflection`.

## Ownership of the join

The adapter adds facts that Tint cannot or should not own:

- `effect`, `draw`, or `compute` kind;
- authored versus injected entry origin;
- authored entry names and exact resolver-token declaration spans;
- module, program, Swift, and emitted Metal names;
- source IDs from the finalized origin map;
- stage visibility and program-wide unions;
- backend-neutral capability policy;
- fingerprints; and
- later Metal slot allocation.

Tint remains authoritative for interfaces, active bindings, sampling pairs, exact-static
overrides, types, layouts, and resolved workgroup size. Interning an authenticated inline interface
shape into a content-addressed semantic type ID is adapter normalization, not type inference. The
adapter can reject inconsistent facts but cannot repair or approximate them.

## Assembly invariants

Before producing `semantic-v1`, the adapter proves all of the following:

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

Swift identifiers are deterministic collision-resolved presentation names. They do not enter type
or layout content IDs or program fingerprints. The arbitrary semantic override `id` is removed:
`names.wgsl` is its stable program-local identity, `names.authored` preserves public diagnostics,
and optional `wgslId` preserves an authored numeric WGSL ID.

An interface leaf's optional `name` is diagnostic context only. It may enter the complete semantic
artifact when independently proven, but it is excluded from the program fingerprint. Changing a
diagnostic label must not rebuild otherwise identical executable semantics. The extractor's first
implementation omits these names rather than manufacturing lowered symbols.

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

For each interface leaf, projection resolves the semantic type ID, proves that it is a scalar or
vector of one scalar, and emits the original authenticated inline `{ scalar, width }` shape. It
rejects any mismatch with the retained extraction instead of reconstructing a type from WGSL. The
translator then starts in a fresh process, parses the same bytes, materializes the supplied values,
and compares the complete entry interface and resource mapping before MSL generation. A local
projection bug therefore fails closed instead of silently changing the runtime artifact.

Response combination happens only after each one-shot invocation passes schema and
request-specific semantic checks. The program-level Metal projection preserves sparse interface
indices, stage-local slots, effective internal resources, storage-size regions, and resolved compute
dimensions. Broad extraction facts remain in `semantic-v1`; they are not copied into the runtime
projection.
