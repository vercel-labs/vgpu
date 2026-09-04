# Program selection

Program selection is a pure, backend-neutral step between the authored entry inventory and any
source injection or semantic extraction. It consumes only program configuration and an inventory
that the protocol boundary has authenticated against the exact resolved source capsule. It never
parses WGSL, reads resolver reflection, evaluates types, or asks a backend which entries appear
compatible.

## Authenticate before selecting

The inventory protocol is the authority for entry-point names and stages. A successful response is
accepted only while the caller still holds the exact deterministically encoded request bytes. The
accepted snapshot records the request identity, source and origin-map hashes, virtual path,
language features, and canonical entry records. It is deeply frozen and nominally branded inside
the authentication adapter; callers cannot construct an equivalent plain object and pass it to the
selector. The adapter runs the request and response JSON Schemas before it mints that brand.

The normalized configuration source is also attached to the snapshot. A program associated with a
different configuration source fails before selection. This is an internal integrity association,
not a public schema or a cache identity: the source capsule and its authenticated hashes remain the
semantic evidence.

## Apply one rule per required stage

For a required stage, an explicit WGSL name is matched exactly and case-sensitively. If that name
exists only in another stage, selection reports a wrong-stage error. If it does not exist at all,
selection reports an unknown-entry error.

When a required stage is omitted from configuration:

- exactly one entry in that stage is selected;
- more than one entry is ambiguous and requires explicit configuration; and
- no entry is missing, except for an effect's vertex stage.

An effect with no authored vertex selects the immutable
`vgpu-native-fullscreen-triangle/v1` injection profile. An explicit vertex name never falls back to
injection. Other stages do not participate in ambiguity: compute entries do not affect an effect or
draw, and render entries do not affect compute selection.

The required stage order is deterministic: vertex before fragment for render programs, then compute
for compute programs. The configuration boundary projects the full program, including overrides,
into an exact selection view containing only `name`, `source`, defaulted `kind`, and optional
`entryPoints`. The selector supports these normalized shapes:

- `effect`: one fragment and either one authored vertex or the injection directive;
- `draw`: one authored vertex and one authored fragment; and
- `compute`: one authored compute entry.

Here, “compatible” means only “belongs to the required stage.” Vertex-to-fragment linking, effect
vertex-input restrictions, bindings, and every other semantic property are validated after the
finalized capsule is extracted by Tint.

## Keep normalized semantics stable

The selection result always names each chosen authored entry, whether its configuration was
explicit or inferred. It does not record that presentation distinction, so explicitly naming the
only candidate and omitting that name produce the same normalized selection and later fingerprint.

The result is deeply frozen and nominally branded. Its private brand also records the exact
authenticated inventory instance that produced it. Re-authenticating even identical request and
response bytes therefore requires running the pure selector again; a plan cannot be crossed with a
second nominal inventory that happens to carry the same request identity. The public request
identity remains useful lineage, but it is not a substitute for this in-process association.

The injection result is still a directive rather than a fabricated entry name. The source
finalizer is the only owner of the generated WGSL bytes and collision-resistant generated name. A
later semantic extraction must authenticate that concrete generated entry before program assembly.

Selection failures use stable internal codes:

- `VGPU-C1-PROGRAM-INVENTORY` for an unauthenticated inventory or one associated with another
  normalized configuration source;
- `VGPU-C1-PROGRAM-CONFIG` for a shape that escaped configuration validation;
- `VGPU-C1-PROGRAM-ENTRY-MISSING` when a required stage has no candidate;
- `VGPU-C1-PROGRAM-ENTRY-AMBIGUOUS` when an omitted stage has multiple candidates;
- `VGPU-C1-PROGRAM-ENTRY-UNKNOWN` when an explicit name is absent; and
- `VGPU-C1-PROGRAM-ENTRY-STAGE` when an explicit name belongs to another stage.

The build command can project configuration and entry errors to its public configuration-invalid
diagnostic. The inventory code represents a failed integrity boundary and must not be downgraded to
ordinary configuration ambiguity. Stale or crossed inventory instances and capsule bytes are
detected by finalization or assembly, where the nominal association, current capsule, and retained
inventory request identity are all available.
