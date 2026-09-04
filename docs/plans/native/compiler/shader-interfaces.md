# Native shader-interface contract

Status: the semantic and Metal artifact shapes are accepted. The exact compiler-worker handshake is
integrated and has passed its C1 protocol gate. Render-target API choices for sparse attachments
remain open.

## Keep three different views

Shader I/O crosses three boundaries with different responsibilities:

1. The semantic contract is backend-neutral and complete.
2. The compiler worker must compare that contract with Tint before and after Metal lowering.
3. The generated artifact keeps only the physical interface data the Metal runtime consumes.

These views must not collapse into one broad reflection object. A complete semantic contract is
necessary for portable validation, while serializing Tint's complete raised Metal interface would
turn private backend details into a runtime ABI.

## Record complete portable semantics

Each selected entry point stores flattened input and output leaves. A leaf contains exactly one
`location` or `builtin`, its semantic type ID, effective invariance, and an optional authored name
for diagnostics. Scalar returns do not need a fabricated name.

The stage and direction constrain every field:

- vertex inputs permit user locations, `vertex_index`, and `instance_index`;
- vertex outputs permit user locations and `position`;
- fragment inputs permit user locations, `position`, `front_facing`, `sample_index`, and
  `sample_mask`;
- fragment outputs permit user locations, `frag_depth`, and `sample_mask`; and
- compute inputs permit the core invocation and workgroup built-ins, while compute outputs are
  empty.

User locations on vertex outputs and fragment inputs always carry effective, normalized
interpolation. An omitted floating-point interpolation becomes `perspective/center`; an omitted
sampling value for `flat` becomes `first`. Interpolation is absent from roles where it has no
effect. `invariant: true` is valid only for a vertex `position` output.

The first alpha fails closed on interface features that need another semantic field or capability
profile, including clip distances, primitive indices, subgroups, linear indexing, fragment depth
mode qualifiers, and framebuffer fetch.

Before backend projection, a draw validates its portable stage link. Every fragment user-location
input must have a vertex output with the same location, scalar kind, component count, and normalized
interpolation and sampling. Additional vertex outputs are valid. Locations and built-ins are unique
within their stage role.

## Validate at the compiler boundary

One translation request carries the exact semantic interface for its selected entry point, using a
small scalar-or-vector wire type rather than artifact type IDs or source names. The worker must:

1. materialize the exact-static override values as IR initializers;
2. apply `SingleEntryPoint`, then remove the remaining overrides with an empty substitution map;
3. extract the selected core-IR interface before Metal raise;
4. compare it exactly with the requested semantic interface;
5. call Metal `Generate()` on that same IR, preserving Tint's `CanGenerate` preflight and official
   writer path;
6. inspect the same, now-raised IR and validate the complete lowered interface and emitted physical
   slots privately; and
7. return the generated MSL plus the minimal runtime projection.

The worker must not use its request as evidence that translation honored the request. It also must
not use `Inspector` as the only interface oracle: the C1 canaries show that Inspector omits built-ins
and normalizes interpolation in roles where the semantic contract does not retain it.

The raised IR remains pinned-compiler evidence. Synthesized Metal structures, members, wrapper
entry names, inter-stage fields, and backend built-ins are not serialized into the artifact. The
isolated interface experiment established equivalent writer output, but the integrated worker uses
`Generate()` so Tint's complete preflight remains in the production path.

The worker checks that the expected Metal resource-class, index, and count set exists in the raised
wrapper. It does not recover each original WGSL binding identity from that wrapper. The
source-to-slot association relies on Tint's `BindingRemapper`, and a successful response
reserializes the independently validated requested external map. This is an explicit trust
boundary, not a claim of identity reflection.

## Serialize the minimal Metal map

Metal projection ABI v1 names `vgpu-metal-shader-interface-v1`. Every entry point carries a
stage-discriminated interface:

```json
{
  "stage": "vertex",
  "wgsl": "vertex_main",
  "metal": "vgpu_vertex_main",
  "interface": {
    "kind": "vertex",
    "attributes": [
      {
        "semantic": { "location": 3 },
        "metal": { "attribute": 3 }
      },
      {
        "semantic": { "location": 7 },
        "metal": { "attribute": 7 }
      }
    ]
  }
}
```

Fragment entries map only color outputs:

```json
{
  "stage": "fragment",
  "wgsl": "fragment_main",
  "metal": "vgpu_fragment_main",
  "interface": {
    "kind": "fragment",
    "colorOutputs": [
      {
        "semantic": { "location": 1 },
        "metal": { "color": 1 }
      },
      {
        "semantic": { "location": 4 },
        "metal": { "color": 4 }
      }
    ]
  }
}
```

Compute entries carry `{ "kind": "compute" }`. Built-ins, inter-stage varyings, types,
interpolation, and invariance remain authoritative in the semantic contract and are not duplicated.

Sparse locations are semantic and must never be compacted. Vertex attributes are ordered by
semantic location. Fragment colors are ordered by `(location, blendSource ?? absent)`. The v1
validator requires an exact bijection with semantic vertex inputs and fragment outputs, equality
between semantic and Metal indices, and no physical collisions.

The schemas can enforce the discriminated shape and paired presence of `blendSource` and Metal
`index`. An independent validator enforces canonical ordering, equality, uniqueness, the semantic
bijection, and stage linking.

Dual-source fields remain representable, and the internal compiler protocol allowlists
`dual_source_blending` so its native canary can prove both location-zero blend sources lower to Metal
color zero at indices zero and one. The first alpha still rejects that language feature during
`native check`. A valid future pair has exactly two user-location outputs, both at location zero,
with sources zero and one and the same type. Internal translator and current-device acceptance is
not a product-support promise.

## Fingerprint and runtime compatibility

The Metal runtime-projection fingerprint includes:

- `shaderInterfaceModel`;
- every exact vertex location-to-attribute mapping;
- every exact fragment location and optional blend-source-to-color/index mapping; and
- the existing semantic fingerprint, Metal ABI, resource slots, payload, target, workgroup, and
  device requirements.

Generated Swift preserves the same discriminated entries. A runtime that does not understand the
shader-interface model rejects the program before pipeline creation. Unlike the storage-buffer-size
model, this check is unconditional because every entry point has an interface kind.

## Evidence and remaining gates

`experiments/native-metal-spikes/c1-shader-io-projection` passed Tint raise/print and live Metal
runtime gates on an Apple M4 Pro. It proved sparse vertex attributes, sparse inter-stage locations,
sparse color outputs, multiple render targets, and dual-source lowering. It also proved that Metal
accepted the tested same-type interpolation mismatch and silently discarded an output whose color
attachment was absent. The tested `MTLRenderPipelineReflection` did not expose the varying or color
information needed to reconstruct this contract.

`experiments/native-metal-spikes/c1-compiler-protocol` now carries the exact semantic interface on
every request, compares it before generation, calls `Generate()`, and inspects the same IR after
Metal lowering. Fifteen positive and twenty-two negative native cases pass deterministically,
including sparse interfaces and the internal dual-source canary.

The last direct-source distribution proof predates this interface-handshake change. Its source lock
and hashes are intentionally stale until they are rebaselined against the current worker, so it is
not current arm64, x86_64, or universal distribution evidence.

`experiments/native-metal-spikes/c3-artifact-swiftpm` now carries a synthetic `SparseDraw` program.
It proves that locations `3/7` and colors `1/4` survive schema validation, canonical cross-checks,
runtime fingerprinting, generated Swift, and arm64/x86_64 SwiftPM builds without compaction.

These results do not expand the supported hardware matrix. The live gate ran only on Apple silicon;
an x86_64 package build and Rosetta execution do not establish Intel or AMD GPU behavior. Offline
`metal` and `metallib`, the broader multi-entry semantic-extractor-to-artifact integration, a real
C1-connected artifact, the direct-source rebaseline, full corpus coverage, and pixel/buffer parity
remain open.

Two public render-target decisions remain intentionally outside this contract:

- indexed attachment records versus a nullable positional array for sparse targets; and
- silent discard for a shader output with no attachment versus failure by default with explicit
  discard intent.

The internal shader contract supports either public API. No public target shape should be frozen
until those choices are resolved.
