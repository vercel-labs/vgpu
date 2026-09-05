# Sampling, resources, and types

The extractor returns compiler-owned facts in a backend-neutral form. TypeScript may validate,
join, and present those facts, but it does not infer WGSL resource or layout semantics.

## Active bindings and the program union

Every binding ID is its WGSL coordinate, `g<group>b<binding>`. The result-level `bindings` array is
sorted by numeric group and binding and contains exactly the union referenced by the selected
entries. Each entry's `bindings` array is its exact active subset in the same order. A declared but
inactive module resource does not appear in either place.

Binding records use extraction-specific schema definitions with the same semantic field vocabulary
as the corresponding `semantic-v1` variants, but omit adapter-owned `swiftName` and `visibility`:

- buffers contain address space, access, type, layout, and `minimumBindingSize`;
- samplers contain the resolved `samplerKind`;
- sampled textures contain dimension, resolved sample type, and multisampling;
- storage textures contain dimension, format, and access; and
- external textures contain only their common binding identity.

For a binding active in both render stages, its declaration fields must agree. Visibility is not a
Tint response field: TypeScript derives it from the entry subsets. For a fixed buffer,
`minimumBindingSize` equals its root layout size. For runtime-sized storage it instead includes one
complete trailing element and any enclosing-structure padding, while the root layout's
`minimumSize` remains its zero-element footprint. The primary fixed-resource fixture proves sizes
8, 24, and 16 for its three buffers; the runtime fixture proves a four-byte root prefix, a
twelve-byte element stride, and a sixteen-byte binding minimum.

Runtime-sized layouts are accepted only for storage buffers. Resource binding arrays, texel
buffers, input attachments, and runtime-sized uniform layouts fail the current extraction profile.
Singular storage textures are accepted, including the simple
`texture_storage_2d<rgba8unorm, write>` canary. An unsupported shape is never represented
approximately.

## Sampling pairs

Tint Inspector's sampler/texture-use query returns only two binding points. It does not return a
stable order, a source name, an operation mode, or accesses such as `textureLoad` that use no
sampler. For each selected entry the wrapper therefore:

1. joins both binding points to that entry's active resource records;
2. proves that the pair contains one sampled or external texture and one sampler;
3. emits `mode: "comparison"` for `sampler_comparison`, otherwise `mode: "filtering"`;
4. deduplicates identical pairs; and
5. sorts by texture group/binding, sampler group/binding, then mode.

`mode` describes the sampling operation, not the final sampler binding class. An ordinary sampler
paired with an unfilterable texture still has pair mode `filtering` even when its resolved
`samplerKind` is `non-filtering`.

Tint initially reports ordinary samplers and `texture_*<f32>` with unknown filtering classes. The
wrapper resolves those unknowns over the union of both selected render stages, following Dawn's
small `ResolveUnknownTypes` policy:

1. an unknown sampler paired with a concrete `unfilterable-float`, `sint`, or `uint` texture becomes
   `non-filtering`; external textures do not participate in this step;
2. every remaining unknown sampler becomes `filtering`;
3. an unknown f32 texture paired with a resolved filtering sampler becomes `float`; and
4. every remaining unknown f32 texture becomes `unfilterable-float`.

Comparison samplers and depth textures remain concrete. No `unknown` value may cross the response
boundary. This logic belongs in the small vgpu wrapper; linking Dawn Native only to reuse its
device-layer resolver would enlarge the build-time binary and cross the accepted boundary.

The cross-stage canary uses one shared ordinary sampler with a float texture in the vertex entry and
an integer texture in the fragment entry. The integer pair resolves the sampler to `non-filtering`
over the program union; the float texture consequently resolves to `unfilterable-float`. Resolving
each entry independently would disagree on the shared binding and fails this canary.

## Type and layout identities

Type and layout objects use extraction-specific definitions that project the same semantic facts as
`semantic-v1` without its required Swift presentation fields. Structures retain their WGSL type and
member names because those are authored semantic identities; `swiftName` is added only during
assembly.

IDs are content-addressed and domain-separated:

```text
type ID = "t_" + SHA-256(
  UTF-8("vgpu-native-semantic-type/v1") || 0x00 ||
  canonical-json(type descriptor without Swift names)
)

layout ID = "l_" + SHA-256(
  UTF-8("vgpu-native-semantic-layout/v1") || 0x00 ||
  canonical-json(layout descriptor)
)
```

The official encoder sorts object keys, preserves strings, and retains semantic array order. The
consumer recalculates every ID and rejects a mismatch, a dangling reference, a cycle, a same-ID
content collision, or an unreachable extra record. Content addressing lets separate program
extractions merge identical facts without order-dependent remapping.

The extractor's graph closure starts at active buffer bindings. It follows atomic elements, vector
and matrix elements, array elements, structure members, each referenced layout, every array
layout's explicit `elementLayout`, and every layout member. Selected interface leaves instead use
the compiler protocol's inline scalar/vector shape; TypeScript interns those descriptors with the
same type-ID function while assembling `semantic-v1`. If an interface type also appears in a buffer
graph, content addressing deduplicates it exactly. An interface-only extraction has no
host-shareable layout roots, so its `layouts` object is empty. A semantic module made only from such
programs also has an empty layout table; TypeScript must not synthesize `AlignOf` or `SizeOf`.

Layouts retain intrinsic WGSL alignment, fixed size, zero-element runtime minimum, array and matrix
strides, member offsets, effective member sizes, and explicit array-element layout edges. A
dedicated `@size(16)` canary proves that member, root layout, and buffer minimum sizes all retain the
authored fixed footprint. The runtime fixture additionally proves that a struct can have a fixed
prefix plus a trailing runtime array whose element struct contains authored `@size`. The validator
rejects a missing fixed-array count, a count on a runtime array, inconsistent fixed or runtime size
fields, a missing or crossed `elementLayout`, crossed child layouts, dangling or cyclic references,
unreachable records, runtime-sized uniform layouts, and incorrect binding minima. Address-space
constraints are validated separately; uniform or storage use never rewrites the intrinsic layout.

## Overrides and workgroup size

Every result-level override has the exact typed shape below. `default` uses the same constant union
when present:

```json
{
  "name": "SAMPLE_COUNT",
  "wgslId": 17,
  "type": "u32",
  "default": { "type": "u32", "value": 5 },
  "selected": { "type": "u32", "value": 9 }
}
```

`wgslId` appears only for an explicitly authored `@id`; automatic Tint IDs never cross the
boundary. `selected` always exists. Boolean, signed-integer, and unsigned-integer constants use a
typed `{ type, value }` object. Finite `f16` and `f32` constants use a typed `{ type, bits }` object
with canonical lowercase hexadecimal bits. The outer `type` and every constant object's `type`
must agree. `default` is omitted when the declaration has no initializer or when its all-omitted
initializer graph cannot be evaluated; semantic v1 does not need to distinguish those two reasons.

Each entry lists its exact-static override names. Their canonical union produces the result array;
an inactive configured override is absent. Compute workgroup dimensions are emitted only after the
selected values are substituted and Tint proves three positive integers. Dependency expressions
remain in the authenticated WGSL rather than becoming runtime metadata.

## Canonical order

The response uses these orders before it is encoded:

- selected entries: vertex, fragment; or the single compute entry;
- interface values: locations numerically first, with absent blend source before source zero and
  source one, then built-ins in ASCII order;
- bindings and entry binding IDs: numeric group, then numeric binding;
- sampling pairs: texture group/binding, sampler group/binding, then mode;
- overrides and entry override names: WGSL name in ASCII order; and
- structure and layout members: declared order.

Object key order belongs to the deterministic wire encoder. It does not replace these semantic
array-order requirements.
