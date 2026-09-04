# Full-screen injection

Full-screen injection is a pure TypeScript finalization step. It consumes an authenticated authored
source capsule and the program selector's versioned injection directive, then produces one new
capsule for semantic extraction and translation. It does not discover entry points, parse WGSL,
infer interfaces, or choose a backend.

The only supported profile in this spike is
`vgpu-native-fullscreen-triangle/v1`. It means all of the following together:

- a triangle-list draw with exactly three vertices and no vertex buffers;
- the vertex order used by the current TypeScript `effect()` implementation;
- one `@builtin(position)` output and one top-origin `@location(0)` `vec2f` named `uv`;
- the exact source template, naming derivation, and append algorithm below; and
- an injected semantic entry with no authored name or source span.

Changing the template bytes, vertex order, output interface, naming derivation, topology, or vertex
count requires a new profile. A caller must reject an unknown profile rather than substituting its
newest implementation.

## Trust boundary

The selector may request injection only for an effect whose authenticated authored inventory has
no vertex entry. Its result is a directive, not a fabricated WGSL entry:

```ts
{
  origin: "injected",
  stage: "vertex",
  injectionProfile: "vgpu-native-fullscreen-triangle/v1"
}
```

The selection plan remains nominally attached to the exact authenticated inventory instance and
also carries its authored request identity as lineage. Before changing source, the finalizer parses
the privately retained request bytes, re-encodes them with the official deterministic encoder, and
requires their identity and capsule fields to match both values. A cloned or independently
re-authenticated inventory, even for the same request, requires a new selection. A changed source,
path, source hash, origin map, origin-map hash, or language-feature set invalidates the pair before
injection.

The finalizer is the only owner of the generated names and bytes. It returns a concrete selection
only after finalization:

```ts
{
  origin: "injected",
  stage: "vertex",
  names: { wgsl: "vgpu_fullscreen_vertex_<64 lowercase hex characters>" }
}
```

The resolver remains the authority for authored declaration spans. Tint remains the authority for
whether the finalized WGSL parses and whether the generated entry has the expected semantic
interface. The finalizer must not consult `resolved.reflection` or scan WGSL to make either claim.

An authored vertex selection is a strict source-capsule no-op. The source text, virtual path,
source hash, origin map, origin-map hash, and language features pass through unchanged, and no
injection metadata is produced. Resolver declaration records travel alongside this step rather
than through it, so they remain unchanged by construction. An explicit vertex name that is absent
never reaches this fallback; program selection rejects it as an unknown or wrong-stage entry.

## Exact v1 template

The v1 template is the following 562-byte ASCII string, including its final LF and excluding the
separate LF used to join it to authored WGSL. Its SHA-256 is
`1df2bf26698725848906383255e92b9a8a4b76c896db33fb6f2566f8031982f6`.

```wgsl
// vgpu-native-generated: vgpu-native-fullscreen-triangle/v1
struct VGPU_FULLSCREEN_OUTPUT_NAME_V1 {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vgpu_fullscreen_entry_name_v1(@builtin(vertex_index) vi: u32) -> VGPU_FULLSCREEN_OUTPUT_NAME_V1 {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uv = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var out: VGPU_FULLSCREEN_OUTPUT_NAME_V1;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}
```

Rendering replaces all three occurrences of `VGPU_FULLSCREEN_OUTPUT_NAME_V1` with the derived
output-structure name and the one occurrence of `vgpu_fullscreen_entry_name_v1` with the derived
entry name. Missing or additional markers are profile drift and fail the build.

This source intentionally uses the same positions and UV values as TypeScript `effect()`:

```text
position: (-1, -1), (3, -1), (-1, 3)
uv:       ( 0,  1), (2,  1), ( 0,-1)
```

`@vgpu/wgsl-std/fullscreen` remains a useful oracle for the interpolated top-origin UV mapping, but
it is not imported or copied mechanically into this profile. Its current vertex order has the
opposite winding. UV-only image comparisons cannot observe that difference, while a fragment using
`@builtin(front_facing)` can. The v1 order therefore follows `effect()` and requires an explicit
`front_facing` parity canary.

The generated source contains no imports, resources, overrides, or helper declarations. Appending
an `import` after resolution would not be valid ordinary WGSL, and resolving the flattened source a
second time would change mangling, declaration elimination, bytes, and provenance. Injection never
re-runs the resolver. If an authored virtual module, package map, or resolver option changes, the
caller discards the inventory and selection plan and starts again from resolution.

## Collision-resistant names

Let `authoredSourceSha256` be the already-validated lowercase hexadecimal hash of the exact resolved
authored WGSL. The finalizer derives:

```text
H = SHA-256(
      UTF-8("vgpu-native-fullscreen-triangle-name/v1")
      || 0x00
      || ASCII(authoredSourceSha256)
    )

entry  = "vgpu_fullscreen_vertex_" + H
output = "vgpu_fullscreen_output_" + H
```

For the test input `authoredSourceSha256 = "00…00"`, with 64 zeroes, `H` is
`19be0484eb77bd42af2ebdc4c72d6a0a3450a14b8121e31d55f1c967e7d40a69`.

The full digest is retained. The derivation excludes program presentation names, virtual paths,
origin input IDs, and language features, so programs backed by identical resolved source bytes can
share one finalized capsule. The profile domain ensures a future profile receives a different
namespace.

The finalizer first proves that the derived entry name is absent from the authenticated authored
inventory. A collision with any other module-scope namespace is still rejected by Tint when it
parses the finalized source. There is no adaptive suffix, retry, or diagnostic-driven renaming: a
failure is deterministic and fail-closed. With content-derived full-digest names, an authored
source that intentionally contains the name would need to satisfy a SHA-256 fixed-point or
preimage-style condition after those same bytes change its source hash.

## Append without rewriting authored bytes

The final source is assembled in one exact order:

```text
finalText = authoredText || LF || render(v1Template, derivedNames)
```

The LF is appended unconditionally. If `authoredText` already ends in LF, the result contains one
blank line. The finalizer never normalizes line endings, whitespace, escapes, or Unicode in the
authored prefix. The generated block is ASCII with LF line endings and ends in LF.

The generated byte range is:

```text
startByte = UTF-8 byte length of authoredText
endByte   = UTF-8 byte length of finalText
```

It includes the joining LF. These are UTF-8 offsets, not JavaScript string indices. The range is
internal finalization evidence and may help classify generated diagnostics; it is not an authored
`sourceSpan`.

The finalizer computes the new `source.sha256` over the exact UTF-8 bytes of `finalText`. The source
`virtualPath` is unchanged: path plus content hash identify a revision of the same generated
source. The resolver's cache key and authored inventory identity may be retained as lineage, but
neither is a cache key or identity for the finalized capsule.

## Preserve provenance as a generated gap

`origin-map-v1` already defines gaps between mapped segments as generated text with no authored
provenance. Finalization therefore creates the new map by:

1. validating the authored map against the authored source byte length and hash;
2. preserving `sources` and `segments` exactly;
3. preserving `generatedSource.virtualPath`;
4. replacing only `generatedSource.sha256` with the final source hash;
5. validating the new map against the final source byte length; and
6. requiring that no segment intersects the generated byte range.

The generated block is not added to `sources`, and no segment points to it. In particular, the
finalizer must not call `buildModuleOriginMap()` on the appended text: that builder treats text
after the last resolver header as part of the last authored module and would falsely extend its
segment across the injection.

After constructing the map, the finalizer recomputes `originMapSha256` over its deterministic
key-sorted JSON encoding. The encoder preserves string values exactly; it does not normalize WGSL
or identities. NFC remains a precondition for the virtual path and authored origin input IDs.

A diagnostic wholly inside the generated range names the generated virtual WGSL but receives no
`origin`. A caller must reject a response that attributes such a diagnostic to an authored input.

## Keep authored declaration spans outside source finalization

The authored declaration index is built directly from
`resolved.ast.modules[*].entryPointDeclarations` and the resolver's virtual-path-to-input table. It
is retained as trusted resolver output, not reconstructed from flattened WGSL. The source finalizer
does not accept or emit this index: the build coordinator carries it unchanged beside the finalized
capsule until program assembly. This keeps byte finalization from becoming a second owner of
resolver evidence.

Program assembly then validates and preserves every selected authored record exactly:

- `input` continues to identify the authored source module;
- lines and columns remain 1-based;
- columns continue to count UTF-16 code units; and
- `end` remains exclusive.

Appending source cannot shift these positions because they refer to individual authored module
texts, not the flattened generated source. Program assembly must match every selected authored
entry against this retained index and reject missing, crossed, duplicate, or out-of-bounds records.

The injected semantic vertex uses `origin: "injected"` and `names.wgsl`. It omits both
`names.authored` and `source`, as required by `semantic-v1`. The internal UTF-8 generated range must
never be converted into a UTF-16 authored span.

## Finalization API

The executable pure boundary is:

```ts
finalizeProgramCapsule({ inventory, selection }) => {
  capsule,
  selection: concreteSelection,
  injection?
}
```

`inventory` is the nominal authenticated snapshot that privately retains the exact authored
inventory request bytes. `selection` must be the nominal plan minted from that same inventory. For
injection, `injection` records only build-internal evidence such as the profile and generated UTF-8
range; the generated output-structure name is not part of program semantics. The resolver-owned
declaration index remains a separate build input and joins the concrete selection during assembly.

Calling the function twice with the same nominal inventory and selection produces byte-identical
results. A finalized capsule cannot be passed back in the inventory position because it has no
inventory brand, so the API cannot append a second vertex. Multiple fragment selections over the
same authored fragment-only capsule receive the same generated names and may reuse the same
finalized capsule.

Every later semantic-extraction and translation request must copy the finalized `source` and
`originMap` unchanged. Semantic extraction also carries the finalized `originMapSha256`; the
existing translation schema omits that field, so compiler projection revalidates the copied map and
source through its complete semantic/resource preflight. The final inventory projection is deeply
frozen and runs the same preflight before launch. Each authenticated operation creates a new request
identity from its own exact encoded bytes; the authored inventory identity is lineage only and must
not be reused.

## Expected failures

The completed pipeline should keep these internal failure classes distinct:

- `VGPU-C1-FULLSCREEN-PLAN`: the selection is unauthenticated, stale, crossed, not an injection
  directive for an effect, or already consumed against another capsule;
- `VGPU-C1-FULLSCREEN-PROFILE`: the profile is unknown, template hash drifted, or marker counts no
  longer match v1;
- `VGPU-C1-FULLSCREEN-CAPSULE`: authored source, path, hash, origin map, origin-map hash, inventory
  identity, or language features disagree;
- `VGPU-C1-FULLSCREEN-PROVENANCE`: a final map changed authored sources or segments, maps any byte
  in the generated range, or does not describe the final source;
- `VGPU-C1-FULLSCREEN-ENTRY`: the finalized Tint result omits the derived vertex, changes its stage,
  loses an authored entry, adds another entry, or exposes a generated-name collision; and
- `VGPU-C1-FULLSCREEN-RESOURCE-LIMIT`: the finalized source or request exceeds an existing worker
  limit before launch.

A missing, crossed, duplicated, or out-of-bounds authored declaration record is an assembly
failure, not a source-finalization failure. A structured Tint syntax or semantic diagnostic inside
the generated range is an injection failure with generated-source location and no authored origin.
It must not trigger a different name, profile, language feature, or source rewrite.

## Executable evidence and remaining gates

The current gate locks the exact template byte count and hash, marker counts, name-domain test
vector, one rendered-capsule hash, the unconditional LF rule, byte determinism, exact authored
prefix, Unicode preservation, UTF-8 generated range, generated provenance gap, reuse across
fragment selections, authored-vertex no-op, nominal-brand failures, same-request inventory
crossing, name collision, and resource limit. It runs one authored and two finalized inventories
with the accepted native worker; the final responses are byte-identical and contain exactly one
derived vertex plus the authored fragment. The integrated semantic-assembly, translation,
offline-toolchain, and live-render evidence is recorded separately in
[`fullscreen-metal.md`](./fullscreen-metal.md) so this source-finalization contract stays focused.

The companion now performs the previously open declaration and interface joins. It captures the
declaration index in the same call that runs the real resolver, authenticates the finalized native
extraction, assembles the effect, and derives both compiler requests from that nominal assembly. The
authored fragment span is exactly `6:1–9:2`; the generated vertex keeps no authored span. Its nine
Tint processes preserve the existing translation, offline compilation/link, UV, and
`front_facing` results. The checked-in interface JSON is only a static expected-value oracle.

The fixed singular-resource bridge now covers nominal slot allocation, exact per-entry requests,
request-specific compiler-response validation, and offline Metal linking. Program-level response
combination, exact-static override extraction/assembly, runtime resource binding, the authenticated
repository corpus, and production artifact packaging remain. Resolver, inventory,
compiler-protocol, direct-build, offline Metal, and corpus baselines must stay green while those
pieces are connected.
Intel, AMD, and cross-machine hardware evidence also remain outside this run.

The source-finalization gate still uses a second authenticated inventory invocation as an isolated
final-source oracle. That invocation belongs to this gate, not the long-term build pipeline. The
semantic-extraction gate separately proves the production path from finalization to one multi-entry
extraction, including the concrete generated name and interface on the exact finalized bytes later
sent to translation.
