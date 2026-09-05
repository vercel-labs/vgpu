# Semantic bridge exit conditions

Accept the bridge only when all of these conditions pass from a clean checkout:

1. No integrated fixture hand-authors `semanticInterface`, active binding sets, evaluated override
   values, or resolved workgroup dimensions after the authored expectation boundary.
2. Tint inventory authenticates the authored source, source hash, origin map and its deterministic
   hash, virtual identity, and language features before TypeScript selects a program. Its response
   identity is SHA-256 over the domain, one NUL byte, and the exact deterministically encoded request
   bytes. Encoding preserves WGSL without Unicode normalization.
3. Full-screen injection, when selected, produces one finalized capsule whose exact WGSL bytes,
   source identity, source hash, and origin map are shared unchanged by semantic extraction and
   every translation request. The extraction identity and caller-side translation association cover
   the canonical origin-map hash.
4. Semantic extraction authenticates the finalized capsule, selected entries, module configuration,
   and language features, owns exact-static membership and values, and produces byte-identical JSON
   twice.
5. Program assembly validates `semantic-v1`, exact resolver-derived authored entry-declaration
   spans, render links, canonical ordering, and exact unions before slot allocation or translator
   launch. Resolver spans retain 1-based locations with UTF-16-code-unit columns and end-exclusive
   boundaries; they are never interpreted as Tint's UTF-8-byte diagnostic columns.
6. Every translation request passes the existing JSON Schema and semantic validator. Its provenance
   fields come from the finalized capsule, its semantic fields come from the authenticated semantic
   assembly graph, and its Metal fields come from the versioned allocator; no field comes from a
   parallel TypeScript reflection projection.
7. A fresh translator process matches the requested entry interface and exact-static override set,
   then produces byte-identical validated responses across two executions. The caller retains the
   one-shot request association because the existing response does not echo a request identity.
8. Combined external and internal slots match selected stages, contain at most one interval per
   stage, preserve sparse indices, and never include an inactive binding.
9. Compute workgroup dimensions match exactly between the semantic artifact and translator result.
10. Every mutation fails at its named boundary; pre-translation failures prove that no translator
    process was launched.
11. Normalized outputs contain no absolute checkout or temporary paths. Semantic entries use exact
    authored declaration spans proven by resolver tokens or omit a span when injected. Diagnostics
    claim an authored module only when the origin map proves it and never invent authored line or
    column spans. Source virtual paths and origin input IDs are NFC caller inputs; WGSL is preserved
    byte-for-byte, and acceptance does not rely on the standalone worker proving NFC.
12. Every successful MSL source compiles with `-std=macos-metal2.4` and target
    `air64-apple-macos14.0`; `metallib` links the complete selected set.
13. The authenticated repository corpus records all 226 paths, 217 distinct content hashes, every
    success and expected failure, and all 226 expected-valid authored entry points; it produces the
    same inventory twice and retains Naga results as non-blocking differential evidence.
14. Existing resolver, override, compiler-protocol, binding-slot, shader-interface, direct-build,
    offline Metal, and structural artifact gates remain green.

Passing this list closes the resolved-WGSL-to-offline-metallib C1 integration gate. It does not close
the production artifact, Swift runtime, supported Xcode/macOS/hardware matrix, general authored
diagnostic source mapping, compare runner, or pixel/buffer parity gates.

The implemented inventory slice currently proves four request and four response fixtures, thirteen
prelaunch mutations with zero launches, five response mutations, one retained-request association
mutation, and thirteen native worker invocations. Those native invocations cover two executions of
each fixture, four malformed raw requests, and one valid NFC Unicode origin map. This is evidence
for conditions 2 and 10, not a claim that the complete bridge exit list has passed.

The implemented selection slice additionally proves twelve positive selections, twenty typed
selection failures, and three inventory-authentication failures. JSON Schema validation precedes
the nominal inventory brand; cloned snapshots and selection plans lose their brands; explicit and
inferred single-entry choices normalize identically; and the selector does not receive WGSL or
resolver reflection. This extends evidence for conditions 2 and 10.

The implemented full-screen slice adds eight positive finalization cases, ten local failures, and
three native inventory invocations. It proves exact append bytes and hashes, UTF-8 ranges,
generated-gap provenance, authored-vertex no-op behavior, exact nominal plan/inventory association,
prelaunch validation of the final request, and two byte-identical final inventories containing only
the derived vertex plus authored fragment. This is partial evidence for conditions 3 and 10.

The implemented semantic-extraction slice now freezes eight request/response pairs, ten prelaunch
failures, twenty-four override-response mutations, and thirty-one existing response mutations. Its
native run reports forty-seven invocations, nine deterministic repeats, eight crossed-request
checks, five fixture successes, two inactive-configuration successes, one constant-expression
workgroup success, seven semantic failures, and ten protocol failures. It proves program-scoped
render and compute interfaces; configured, defaulted, and active exact-static override unions;
exact per-entry override subsets; authored `@id` handling; omission of inactive configured
declarations; and
positive workgroup dimensions resolved from constant and override-dependent expressions. The
existing resource evidence still includes the numeric five-binding graph, authored fixed `@size`,
storage-texture reflection, cross-stage sampler/texture resolution, and structured runtime-array and
binding-array rejection. This closes the native extraction portion of condition 4 and adds evidence
for conditions 3 and 10. The connected override assembly and offline translation path described
below now extend that evidence through conditions 5, 6, 7, and 12 for the five override fixtures.

The executable assembly slice now contains nine programs: resource-free effect, multi-module draw,
compute, one fixed singular-resource draw, and five exact-static override configurations. Nine
nominal allocations produce thirteen compiler requests. The gate covers five nominal failures, five
declaration failures, three resolver-symbol failures, three resolver-resource-join failures, fifteen
resolver-override checks, two retained-resolver-snapshot checks, six override-configuration checks,
one profile failure, one render-link failure, five fingerprint checks, fourteen Swift-name failures,
one stage-isolation check, four slot-allocation failures, and two projection failures. Its eighteen
semantic invocations are two byte-identical extractions for each fixture. It proves declaration v3
entry spans plus binding, struct, member, and override symbol evidence; exact authored Swift
presentation with Swift 6 and helper/generated-module namespace rejection plus binding-local,
override-local, and member-local collision checks; schema-valid interface interning and fixed
resource graphs; exact per-entry override subsets and typed unions; program fingerprints; and exact
extraction reprojection. Final aggregation still owns collisions created by local/shared type
placement and generated program API names. The resource fixture retains numeric bindings `b0`,
`b1`, `b2`, `b3`, and `b10`, exact entry subsets, sampling pair and visibility, seven extracted types
expanded to eight semantic types, six layouts, and minimum buffer sizes of 8, 24, and 16 bytes. This
is partial evidence for conditions 3 through 7, 10, and 12.

The connected override companion adds twelve deterministic translation processes covering six
entries and five programs. It preserves dependent defaults and initializer bypass, proves that an
omitted default and the equivalent explicit value converge on identical downstream semantics, keeps
different render-stage subsets despite a shared union, carries `bool`, `i32`, `u32`, `f16`, and
`f32`, and requires translated workgroup dimensions to equal semantic dimensions. Its six retained
MSL sources contain no `function_constant`, compile to AIR, and link into five metallibs. Twelve
independent projection mutations include missing and redistributed membership, crossed request
subsets, and changed selected values. This is executable evidence for the override portions of
conditions 4 through 7, 10, and 12. The render fixture additionally runs two independent Swift/Metal
processes with two renders each and requires one exact four-pixel result. The hash-locked probe loads
both functions by emitted name and rejects `MTLFunctionConstantValues` and the function-constant
overload, so the observed selected values cannot be changed at runtime.

The integrated Metal companion adds nine one-shot Tint processes: one inventory, two byte-identical
semantic extractions, four deterministic successful translations, and two byte-identical runs of one
structured interface rejection. It also performs two offline AIR compilations, one metallib link,
and two byte-identical 2x2 GPU readbacks on Apple M4 Pro. Its compiler requests come from the nominal
assembly; the interface JSON is only a static oracle. The authored fragment retains the exact
resolver span `6:1–9:2`, and the selected generated vertex reaches Metal with top-origin UV and
explicit counter-clockwise winding. Its compiler and runtime consume MSL and emitted names only
through the authenticated program projection. This is executable evidence for the resource-free
portions of conditions 3, 5, 6, 7, 10, and 12, not completion of the whole bridge.

The fixed-resource companion adds four deterministic translation processes after eight semantic
extractions. Four nominal program allocations project seven total compiler requests; the resource
pair preserves its exact stage subsets and external slots, reports no effective internals or size
regions, combines the exact stage set into `$defs/program`, compiles the retained sources to two AIR
files, and links one metallib. From that nominal projection it derives one frozen runtime layout,
prepares five logical resources into six stage-local commands, and runs two byte-identical Swift
processes on Apple M4 Pro, each validating two renders/readbacks. Twenty-seven static layout checks,
fifteen preparation failures, two crossed-program encoding failures, and four malformed manifests
cover the current fixed direct profile. This closes fixed singular-resource allocation, request
projection, response authentication, program projection, offline compilation, and runtime
binding/readback for that fixture.

Exact-static override extraction, authenticated assembly into `semantic-v1`, exact per-entry
translation projection, deterministic native translation, offline Metal compilation, and a
nondegenerate live render observation have passed. Compute-resource translation and runtime parity,
broader resource shapes, the integrated repository corpus, production artifact packaging, and the
production Swift runtime remain open. The recorded GPU evidence is not an Intel, AMD, or
cross-machine result.
