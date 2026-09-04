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

The implemented fixed-resource extraction slice adds four frozen request/response pairs, nine
prelaunch failures with zero launches, thirty-one response failures, three static nominal
authentications, and twenty-three native invocations. It proves program-scoped render and compute
interfaces, literal workgroup dimensions, and one five-binding resource graph with numeric order,
exact stage subsets, one shared binding, seven types, six layouts, and fixed buffer minimum sizes of
8, 24, and 16 bytes. Additional canaries prove an authored fixed `@size`, simple storage-texture
reflection, Dawn-like cross-stage sampler/texture resolution, and explicit runtime-array and
binding-array rejection. Configured and active overrides remain structured failures. This is
partial evidence for conditions 3, 4, and 10.

The executable assembly slice adds four programs: resource-free effect, multi-module draw, and
compute fixtures plus one fixed singular-resource draw. Four nominal allocations produce seven
compiler requests. The gate covers five nominal failures, five declaration failures, three
resolver-symbol failures, three resolver-resource-join failures, two retained-resolver-snapshot
checks, one profile failure, one render-link failure, five fingerprint checks, twelve Swift-name
failures, one stage-isolation check, four slot-allocation failures, and two projection failures. Its
eight semantic invocations are two byte-identical extractions for each fixture; the resource pair
adds four deterministic translations. It proves declaration v2 entry spans and
binding, struct, and member symbol evidence; exact authored Swift presentation with Swift 6 and
helper/generated-module namespace rejection plus binding-local and member-local collision checks;
schema-valid interface interning and fixed resource graphs; program fingerprints; and exact
extraction reprojection. Final aggregation still owns collisions created by local/shared type
placement and generated program API names. The resource fixture retains numeric
bindings `b0`, `b1`, `b2`, `b3`, and `b10`, exact entry subsets, sampling pair and visibility, seven
extracted types expanded to eight semantic types, six layouts, and minimum buffer sizes of 8, 24,
and 16 bytes. This is partial evidence for conditions 3 through 6 and 10.

The integrated Metal companion adds nine one-shot Tint processes: one inventory, two byte-identical
semantic extractions, four deterministic successful translations, and two byte-identical runs of one
structured interface rejection. It also performs two offline AIR compilations, one metallib link,
and two byte-identical 2x2 GPU readbacks on Apple M4 Pro. Its compiler requests come from the nominal
assembly; the interface JSON is only a static oracle. The authored fragment retains the exact
resolver span `6:1–9:2`, and the selected generated vertex reaches Metal with top-origin UV and
explicit counter-clockwise winding. This is executable evidence for the resource-free portions of
conditions 3, 5, 6, 7, 10, and 12, not completion of the whole bridge.

The fixed-resource companion adds four deterministic translation processes after eight semantic
extractions. Four nominal program allocations project seven total compiler requests; the resource
pair preserves its exact stage subsets and external slots, reports no effective internals or size
regions, compiles to two AIR files, and links one metallib. This closes fixed singular-resource
allocation, request projection, response validation, and offline compilation for that fixture.

Exact-static overrides, program-level translator-response combination, resource runtime binding and
readback, compute-resource translation parity, broader resource shapes, the integrated repository
corpus, and production artifact packaging remain open. The recorded GPU evidence is not an Intel,
AMD, or cross-machine result.
