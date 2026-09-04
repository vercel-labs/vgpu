# Semantic bridge fixtures

## Executable inventory slice

The current entry-inventory gate checks four request/response fixture pairs:

- `empty-module` succeeds for resolver output containing only a generated module header, with an
  empty provenance-segment array and empty inventory;
- `multi-stage` succeeds with entries in canonical stage/name order;
- `library-only` succeeds with an empty inventory; and
- `invalid-wgsl` fails with a structured WGSL diagnostic and no result.

The static gate applies thirteen prelaunch mutations and requires zero worker launches. They cover
an unknown request field, crossed source and provenance identities, stale hashes, a source NUL,
noncanonical feature order, non-NFC path and origin identities, noncanonical origin segments, source
and segment limits, the JSON allocation limit, and a cyclic request. Five response mutations cover
crossed request and compiler identities, entry ordering and duplication, and an invalid failure
shape. A separate association mutation changes the retained request after encoding and proves that
old request bytes cannot validate it.

The native gate makes thirteen one-shot worker invocations. It executes each of the four fixtures
twice to prove byte-deterministic responses, sends four malformed requests directly to the worker
decoder, and sends one valid origin map with an NFC Unicode input ID. The four raw mutations are an
unknown top-level field, a stale origin-map hash, a NUL appended to source with otherwise coherent
hashes and provenance, and unordered language features.

Unicode has distinct identity, source, and limit canaries. The valid native origin ID proves that
canonical non-ASCII identities cross the worker boundary. A static request appends decomposed
`Cafe\u0301` to WGSL and proves the deterministic encoder retains those exact code units and UTF-8
bytes instead of replacing them with NFC `Caf\u00e9`. Another static request proves the 4,096-unit
virtual-path limit counts Unicode code points, matching JSON Schema and C++. NFC is required of
virtual paths and origin input IDs by the TypeScript caller; WGSL bytes are never normalized, and
the standalone worker does not independently prove NFC.

## Executable semantic-extraction slice

The extractor freezes four request/response pairs. `render-interface` and `compute-interface`
succeed with canonical interfaces; the compute case also returns a literal `1 x 1 x 1` workgroup
size. `active-resource` now succeeds with the numeric binding union `b0`, `b1`, `b2`, `b3`, `b10`.
Its vertex subset is `b0`, `b1`; its fragment subset is `b0`, `b2`, `b3`, `b10`, with `b0`
shared across stages and the texture/sampler pair at `b2`/`b3`. The graph contains seven types, six
layouts, and fixed buffer minimum sizes 8, 24, and 16. `active-override` remains a structured
unsupported failure.

Nine prelaunch mutations stop before a worker can run. Thirty-one response mutations cover request
and compiler association, entry identity, canonical numbers and ordering, builtin types, diagnostic
provenance, dual-source rules, binding subsets and union, sampling-pair roles and resolved classes,
content IDs, graph closure, fixed-layout invariants, child-layout association, and resource limits.
Three successful responses are nominally branded against the exact finalized capsule; cloning or
crossing the capsule loses that authority.

The native gate makes twenty-three one-shot invocations. Beyond the four frozen responses and
repeated successes, it proves that extraction is independent from later render-link validation,
accepts the generated full-screen vertex and authenticates it through the adapter, ignores inactive
resource and override declarations, preserves an authored fixed `@size`, extracts a simple storage
texture, and resolves unknown sampler/texture classes over both render stages using Dawn's policy.
Runtime arrays and sized binding arrays fail explicitly. The gate also covers the interface-size
boundary, missing and wrong-stage selections, and malformed raw protocol requests.

## Executable program-selection slice

The selection gate uses reviewed inventory and program literals. Twelve positive cases cover the
default effect with injection, authored effects, inferred and explicit draw and compute entries,
multiple candidates with explicit names, irrelevant stages, interface checks deferred to semantic
extraction, canonical request-identity member order, prototype pollution, frozen input, and
byte-deterministic frozen output. Explicitly naming a sole candidate produces the same normalized
selection as inference.

Twenty selection negatives cover missing and ambiguous required stages, unknown and wrong-stage
explicit names, an explicit absent effect vertex that must not inject, forbidden stage keys,
malformed identifiers, `null`, accessors, a public program not projected to the narrow selection
view, raw and cloned inventories, and a source-crossed inventory. Three authentication negatives
reject a non-string entry name, an extra entry field, and a valid structured inventory failure.

The gate intentionally does not ask JavaScript whether an authored effect vertex consumes a vertex
location. Selection means stage membership only; the authenticated semantic extractor owns that
later effect-interface rejection.

## Executable full-screen finalization slice

The finalization gate has eight positive cases covering the locked v1 template and name vector,
deterministic frozen output, exact UTF-8 ranges, astral and decomposed Unicode, the unconditional LF
join, an authored-vertex no-op, capsule reuse across fragment selections, generated diagnostic
provenance, and parity with the current TypeScript triangle positions and UVs.

Ten local failures cover cloned finalized capsules, false authored provenance on a generated
diagnostic, cloned plans, cloned inventories, inventories crossed at both different and identical
request identities, unknown profiles, malformed source hashes, derived entry collisions, and the
16 MiB finalized-source limit. A plan is nominally attached to the exact authenticated inventory
instance in addition to carrying its request identity. The final inventory projection is deeply
frozen and repeats the inventory request's semantic and resource preflight before launch.

With the accepted arm64 worker, the gate performs one authored inventory followed by two finalized
inventories. The latter responses are byte-identical and contain exactly the derived vertex and the
authored fragment in canonical order. Adversarial final-response mutations and overrides remain
part of the wider integrated closure below; interface extraction, fixed singular-resource assembly,
and the resolver-owned entry and resource-symbol joins are now exercised by the assembly gates.

## Executable semantic assembly slice

The assembly gate resolves four authored fixtures and captures their declaration evidence in the
same real-resolver call. One effect exercises generated full-screen vertex injection, render
linking, and an authored fragment. One draw imports its fragment from a second module, proving
auxiliary-symbol mangling, preserved public entry names, and exact spans in separate authored inputs.
One compute program exercises an authored compute entry and resolved `4 x 2 x 1` workgroup
dimensions. A fourth multi-module draw fixture exercises five fixed singular resources at `b0`,
`b1`, `b2`, `b3`, and `b10`, exact stage subsets, one shared binding, one filtering sampling pair,
and derived visibility. Its seven extracted types become eight semantic types after interface
interning, its six layouts remain exact, and its buffer minimum sizes are 8, 24, and 16 bytes. The
four fixtures produce schema-valid `semantic-v1` programs and fixed program fingerprints. Four
nominal program allocations produce seven compiler requests: five resource-free requests plus the
resource render pair.

The static matrix covers five nominal-association failures, five declaration failures including a
cross-module span mutation, three resolver-symbol failures, three resolver-resource-join failures,
two retained-resolver-snapshot checks, one unsupported-profile failure, one broken render link,
five fingerprint checks, twelve Swift-name failures, one stage-isolation check, four slot-allocation
failures, and two projection failures. Resolver
declaration v2 evidence retains exact binding, struct, and member symbols as well as entry spans.
Assembly preserves authored Swift spellings and rejects noncanonical and Swift 6 reserved names,
the `_vgpu` helper namespace, generated module namespaces in nominal positions, and
case-insensitive collisions within one binding set or one struct's members. Final aggregation owns
collisions created by local/shared type placement and generated program API names. Neither stage
recases, suffixes, or adds backticks. Pre-translation failures launch no translator. With the
accepted arm64 worker, two deterministic native extractions per fixture add eight one-shot
invocations and must assemble to the same reviewed semantic objects and fingerprints. The resource
graph must also reproject exactly to its authenticated extraction. Its two entries then run twice
each through translation; exact request, response, and MSL hashes are frozen before both sources
compile and link offline. The same nominal program projection supplies the runtime layout and MSL to
a Swift probe. Five logical resources prepare into six commands; two processes must each validate
two renders against the same exact 2x2 readback. The fixed-resource runtime matrix and limitations are recorded in
[`semantic-extraction/runtime-resource-binding.md`](./semantic-extraction/runtime-resource-binding.md).

## Integrated full-screen Metal canary

The companion Metal gate uses a second fragment fixture that exposes UV and `front_facing` as pixel
values. It compares real resolver output with checked-in WGSL and declaration snapshots, then joins
the authenticated extraction with that nominal declaration evidence. The interface JSON supplies
only the reviewed static oracle; both compiler requests are projected from the assembled program.
The authored fragment span is exactly `6:1–9:2`. Each entry is translated twice, and one additional
schema-valid request runs twice to prove that Tint deterministically rejects a crossed UV width with
one structured interface diagnostic.

The two accepted MSL sources compile to separate AIR files and link into one metallib. A Swift probe
loads translator-returned function names, renders 2x2 targets with explicit counter-clockwise and
clockwise state, and runs twice. Exact RG values prove top-origin UV; blue is 255 for CCW and zero
for the CW control. The complete path uses nine one-shot Tint processes: one inventory, two semantic
extractions, four successful translations, and two runs of the structured negative. See
[`fullscreen-metal.md`](./fullscreen-metal.md) for snapshots, commands, and limitations.

## Initial authenticated closure

Use real repository shaders only after a small purpose-built closure can localize failures. The
initial closure must contain:

- a multi-module render graph with imported structs and aliases;
- direct, struct, and unnamed scalar entry-point returns;
- sparse vertex attributes, inter-stage locations, and fragment colors;
- vertex and fragment built-ins, normalized interpolation and sampling, and invariance;
- a generated full-screen vertex entry paired with an authored fragment entry;
- stage-local and shared buffer, texture, and sampler bindings;
- multiple compute entries with disjoint active bindings and overrides;
- required, defaulted, dependent, and explicitly bypassed override initializers;
- literal, constant-expression, and override-expression workgroup dimensions;
- a runtime-sized storage buffer and the conditional immediate-data size region;
- `f16` values and explicit `uniform_buffer_standard_layout`; and
- internal dual-source evidence, while the alpha profile still rejects the feature.

Expected semantic objects, fingerprints, and request hashes remain reviewed oracles rather than
being regenerated from translator responses. Actual compiler requests must be derived from the
authenticated assembly. Fixed singular-resource extraction, assembly, nominal slot allocation,
exact per-entry projection, translation, offline compilation, and one fixed direct runtime readback
now establish the connected path. Overrides, broader resource shapes and runtime behavior, corpus,
and packaging fixtures remain to be connected.

## Repository corpus

The product corpus excludes `experiments/native-metal-spikes/**`; those shaders are isolated
canaries with independent expectations. The current inventory contains 226 authored WGSL paths and
217 distinct byte-content hashes; nine additional paths share a hash with another path. The
resolver accepts 224 paths and rejects two intentional fixtures. Corpus identities are virtual paths
plus content hashes. Inventory, resolution, and execution results retain every authored path;
aggregate reporting records duplicate hashes separately and never deduplicates work by raw content
hash.

Start the integrated corpus with these representative graphs:

- `gradient/shader.wgsl`, including the generated full-screen vertex entry;
- `batch-rendering/blit.wgsl` for uniform, texture, and sampler bindings;
- `fluid/curl.wgsl` plus `fluid-common.wgsl` for imports and read/write storage; and
- `scene-lit-cube.wgsl` plus the imported light module for render linking and stage-local bindings.

Add the ocean-surface graph as the second tier to prove that `GRID` is active in one selected entry
and inactive in another. Only then run the complete corpus matrix: all 226 paths are inventoried and
attempted by the resolver, all 60 library-only roots retain their resolver outcome and are covered
transitively where imported, and deterministic program selections cover all 226 expected-valid
authored entry points through the semantic bridge and one-entry translator. Generated full-screen
entries are counted separately.

## Mutation matrix

Mutations must fail at the earliest owning boundary:

- source bytes, source hash, virtual source identity, origin map, or origin-map hash crossed after
  resolution or injection;
- deterministic request bytes re-encoded differently, or a response identity not equal to
  SHA-256 of the inventory domain, one NUL byte, and those exact request bytes;
- an inventory response with the wrong request identity, or an unknown, duplicate, or wrong-stage
  entry selection;
- a non-NFC source virtual path or origin input ID rejected by the caller, without normalizing WGSL;
- a generated full-screen range attributed to authored source, a stale injection version, or
  different finalized bytes sent to extraction and translation;
- a missing, crossed, or out-of-bounds authored entry-declaration span;
- undeclared language feature or a feature unsupported by semantic contract v1;
- missing required override, extra override, wrong scalar kind, non-finite float, stale evaluated
  default, or an exact-static set crossed between entries;
- missing, extra, inactive, reordered, colliding, or wrong-stage resource slot;
- duplicate interface location or built-in, wrong semantic type, interpolation mismatch, invalid
  invariance, or a broken vertex-to-fragment link;
- resource binding arrays and external-texture lowering while they remain outside the translation
  protocol;
- dual-source output in the alpha profile;
- translator response detached from its one-shot invocation or with the wrong entry, Metal name,
  workgroup size, interface, external slot, internal slot, or size region; and
- physical checkout paths in any normalized request, response, diagnostic, or snapshot.

Pre-translation negatives count translator launches and require zero. Translator negatives require
a structured `ok: false` response; a nonzero process exit remains a transport or crash failure.
