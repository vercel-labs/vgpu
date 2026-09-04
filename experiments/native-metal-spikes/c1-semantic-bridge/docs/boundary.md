# Semantic bridge boundary

## Data flow

```text
authored virtual modules + package map
  -> resolveVirtualShader
  -> authored capsule {
       resolved WGSL, source SHA-256,
       origin-map-v1 + canonical SHA-256,
       exact authored entry-declaration spans
     }
  -> fresh Tint entry inventory, authenticated to the authored capsule
  -> pure TypeScript program selection
  -> deterministic full-screen injection when required
  -> finalized capsule { exact bytes + hashes + provenance }
  -> fresh Tint semantic extraction, once per finalized capsule/configuration/selected set
  -> authenticated backend-neutral entry records
  -> pure TypeScript program assembly
       -> semantic-v1
       -> program/stage slot allocation
       -> compiler request-v1 per entry
  -> fresh Tint translation process per request
  -> validated compiler response-v1
  -> program-level metal-projection-v1
  -> metal -> AIR -> metallib
```

Resolved WGSL, its SHA-256, its versioned origin map and canonical origin-map SHA-256, and its proven
entry-declaration spans form one capsule. Full-screen injection produces a new finalized capsule:
the generated range has no authored span, and its versioned bytes participate in the finalized
identity. Semantic extraction and translation receive the exact same finalized WGSL bytes, source
identity, source hash, and origin map. No stage may substitute one member without invalidating the
others.

## Ownership

| Boundary                 | Owns                                                                                                                                                                                                                                      | Must not own                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Resolver                 | Virtual module graph, imports, mangled WGSL, source hash, module provenance, exact authored entry-declaration spans                                                                                                                       | WGSL type semantics or Metal slots                                  |
| Tint inventory           | Authenticated entry-point names and stages for one authored capsule and language-feature set                                                                                                                                              | Program selection, WGSL type reflection, or Metal policy            |
| TypeScript adapter       | Program selection from the authenticated inventory, versioned full-screen injection, render linking, semantic unions, canonical ordering, emitted-name policy, slot allocation, projection                                                | Parsing WGSL types, evaluating overrides, or inferring MSL output   |
| Semantic Tint extraction | Entry interfaces, full binding declarations and per-entry active sets, sampling pairs, reachable semantic types and intrinsic layouts, exact-static override membership and values, resolved workgroup sizes, language-feature validation | Program grouping, Metal names, Metal slots, runtime artifact policy |
| Tint translator          | One-entry request validation, independent semantic comparison, override materialization, Metal lowering, generated MSL, effective internal resources                                                                                      | Program-wide policy or broad semantic artifact generation           |
| Apple tools              | Acceptance of generated MSL for the exact language version and deployment target                                                                                                                                                          | WGSL semantics or source provenance                                 |

The adapter may verify and canonically copy Tint's exact-static sets, but it never recomputes their
membership or values. It builds each program union from those authenticated per-entry records.

## Entry inventory and injection

The inventory request carries the authored capsule identity and explicit WGSL language-feature set.
Its response repeats the authenticated request identity and returns only canonical entry names and
stages. TypeScript applies the configuration's explicit-or-single-match selection policy to that
inventory; it does not inspect WGSL text to discover a stage or type.

When a selected effect has no authored vertex entry, the adapter injects the versioned vgpu
full-screen vertex source and rebuilds the source hash, origin map, origin-map hash, and request
identity. The generated range is provenance, not an authored source span. The selected generated
name and stage are validated by the final semantic extraction. An effect with an authored vertex
does not receive the generated source.

## Semantic extraction

The extraction request carries:

- the finalized virtual WGSL and its SHA-256;
- the generated virtual source identity;
- the complete versioned origin map and its canonical SHA-256;
- the explicit selected entry names and expected stages;
- the complete module-level override configuration; and
- the explicit WGSL language-feature set.

The response repeats an authenticated request identity and returns canonical records for every
selected entry. Those records include complete flattened inputs and outputs, full binding
declarations and per-entry active binding IDs, sampling pairs, the exact-static override membership
and selected values, resolved compute workgroup dimensions, every reachable semantic type, the
host-shareable intrinsic layouts, and structured diagnostics.

Extraction is multi-entry so one parse and configuration produces an atomic view of the module.
Translation remains one-entry because its protocol, failure attribution, output identity, and cache
boundary are already accepted at that granularity.

## Independent verification

The translator receives semantic data only through its existing strict request schema. In a fresh
process it must parse the same finalized source again, authenticate the source hash and selected
entry, apply the exact override values, compare the complete core-IR interface, perform Metal
lowering, and inspect the raised interface.

Compiler-request fields have three explicit provenances:

- source text, source identity, source hash, and origin map come unchanged from the finalized
  capsule;
- entry identity, semantic interface, exact-static override set, and language features come from
  the same authenticated semantic assembly graph used to serialize `semantic-v1`; and
- emitted names, external slots, and candidate internal reservations come from the adapter's
  versioned Metal policy.

The per-entry exact-static subset remains in the authenticated extraction record because
`semantic-v1` stores its program-level union. Request construction must not consult the existing
TypeScript reflection projection or parse raw initializer text.

This second pass detects adapter bugs and stale or crossed data. It does not prove Tint correct
against the WGSL specification by itself. Corpus canaries, Apple's compiler, live Metal readback,
and Naga differential observations cover different failure classes.

## Artifact projection

The existing compiler response does not echo a request identity. The trusted caller therefore keeps
each response attached to its one-shot process invocation and applies schema plus request-specific
semantic validation for the selected entry, projected interface, external slots, effective internal
slots, size regions, and workgroup dimensions. A response must never be cached or combined as a
self-identifying value.

The adapter combines per-entry responses only after those checks pass. Program-level binding and
internal-binding records may contain one vertex and one fragment slot in canonical stage order; the
per-entry compiler protocol still carries only the selected stage. Compute programs may contain
compute slots only.

The artifact retains complete backend-neutral semantics separately from its minimal Metal runtime
projection. Synthesized Tint structures, raised member names, generated MSL, and broad compiler
reflection do not become runtime ABI.

## Process packaging

The spike may prototype entry inventory and semantic extraction as sibling executables while
iterating on Tint APIs. The distribution candidate is one source-built vgpu Tint tool with separate
inventory, semantic, and translation operations. Each invocation is a fresh process with a strict
operation-specific JSON schema. This avoids shipping multiple copies of the same static Tint closure
without weakening process isolation. The application runtime ships none of these operations.
