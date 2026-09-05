# Runtime-sized storage integration

This slice connects WGSL runtime-sized storage buffers across the authenticated semantic extractor,
`semantic-v1` assembly, Metal projection, native Tint translation, offline Metal compilation, and
live binding/readback. The slice deliberately keeps three facts separate:

1. the semantic layout is runtime-sized;
2. Tint's selected Metal entry actually needs storage-buffer-size transport; and
3. one encoded binding supplies a concrete byte range.

Conflating those facts would either make TypeScript predict Tint lowering or put transient resource
sizes into the artifact. Neither is acceptable.

## Connected flow

```text
finalized WGSL
  -> authenticated Tint semantic extraction
  -> runtime-sized type/layout graph + binding minimum
  -> semantic-v1 assembly
  -> deterministic external Metal slots
  -> one-entry Tint translation with fixed immediate-data layout capacity
  -> effective immediate-data slot and optional size region
  -> runtime range validation and sparse table packing
  -> Metal encode and exact readback
```

The detailed contracts are split by owner:

- [`semantic-contract.md`](./semantic-contract.md) defines the backend-neutral type, layout, and
  binding facts;
- [`metal-immediate-data.md`](./metal-immediate-data.md) defines the fixed Metal-only
  immediate-data layout; and
- [`runtime-binding.md`](./runtime-binding.md) defines dynamic range validation, table packing, and
  encoding.

## Evidence status

| Boundary                | Status | Evidence                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tint writer feasibility | Passed | A fragment entry keeps its size table at byte `12` both with and without depth clamping; generated MSL exposes the expected padding and compiles offline.                                                                                                                                                 |
| Semantic extraction     | Passed | A root runtime array and a structure with a fixed prefix plus trailing runtime array produce exact content-addressed types and layouts. Invalid uniform use and resource binding arrays still fail.                                                                                                       |
| Assembly and projection | Passed | A compute program assembles from authenticated extraction, projects external `buffer(0)`, and authenticates Tint's effective immediate-data `buffer(30)` plus its storage-size region at byte `4`. A sibling no-region canary keeps an effective immediate slot without requiring the storage-size model. |
| Native translation      | Passed | Two real Tint translations are byte-identical, authenticate against the exact projected request, and assemble one nominal program projection rather than relying on a synthetic compiler response.                                                                                                        |
| Offline Metal           | Passed | The retained runtime-sized MSL compiles to AIR and links into a metallib through the authenticated projection accessor.                                                                                                                                                                                   |
| Runtime                 | Passed | Within each process, two dispatches reuse one backing allocation and binding offset. Effective ranges `28` and `52` upload words `[0, 28]` and `[0, 52]`; the same projection reads back `[2, 202]` and `[4, 404]`. The table contains the bound range, not `MTLBuffer.length`.                           |
| Reproducibility         | Passed | Semantic extraction and the two real translations are byte-identical, the integrated AIR/metallib path passes, and two live M4 Pro processes produce the same report.                                                                                                                                     |

The live probe also locks reflection to `buffer/0/16/4`, `buffer/1/8/4`, and
`buffer/30/8/4` (`index/dataSize/alignment`). Eleven malformed-manifest cases and four range
preparation failures reject invalid model identities, slots, regions, and concrete bounds before
dispatch. This is evidence for the available Apple M4 Pro only; it does not establish Intel or AMD
support.

The live fixture uses an internal/raw buffer binder. The public API now selects a specialized typed
resource with immutable allocation capacity and explicit immutable element-count binding views.
The follow-up C2 resource spike must connect that representation to this authenticated Metal path;
this feasibility fixture alone does not prove the public implementation.

WGSL `binding_array` remains outside semantic v1 and the first alpha.
