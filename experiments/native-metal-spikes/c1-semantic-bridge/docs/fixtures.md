# Semantic bridge fixtures

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

Every expected semantic object and compiler request is a reviewed literal fixture. Tint may validate
it, but no test regenerates its own expected value from the translator response.

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
- an inventory response with the wrong request identity, or an unknown, duplicate, or wrong-stage
  entry selection;
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
