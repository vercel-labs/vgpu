# Runtime-sized storage integration

This slice is connecting WGSL runtime-sized storage buffers across the authenticated semantic
extractor, `semantic-v1` assembly, the Metal projection, and a live binding/readback path. Semantic
extraction now passes; the downstream assembly, projection, and live fixture remain open. The slice
deliberately keeps three facts separate:

1. the semantic layout is runtime-sized;
2. Tint's selected Metal entry actually needs storage-buffer-size transport; and
3. one encoded binding supplies a concrete byte range.

Conflating those facts would either make TypeScript predict Tint lowering or put transient resource
sizes into the artifact. Neither is acceptable.

## Candidate flow

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
- [`metal-immediate-data.md`](./metal-immediate-data.md) defines the proposed fixed Metal-only
  immediate-data layout; and
- [`runtime-binding.md`](./runtime-binding.md) defines dynamic range validation, table packing, and
  encoding.

## Evidence status

| Boundary                | Status  | Evidence required                                                                                                                                                                                                |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tint writer feasibility | Passed  | A fragment entry keeps its size table at byte `12` both with and without depth clamping; generated MSL exposes the expected padding and compiles offline.                                                        |
| Semantic extraction     | Passed  | A root runtime array and a structure with a fixed prefix plus trailing runtime array produce exact content-addressed types and layouts. Invalid uniform use and resource binding arrays still fail.              |
| Assembly and projection | Pending | A compute program assembles from authenticated extraction, projects an exact storage slot, and records an effective size region only when Tint reports one. A sibling fixed-prefix-only entry records no region. |
| Runtime                 | Pending | Two concrete bound ranges produce different `arrayLength()` and last-element results without changing the artifact. The table contains the bound range, not `MTLBuffer.length`.                                  |
| Reproducibility         | Partial | Semantic extraction and the writer feasibility canary are deterministic. The integrated AIR, metallib, and two-process live path remains pending.                                                                |

The first live integration may use an internal/raw buffer binder. The public Swift representation of
a generated structure with a fixed prefix and runtime array tail remains an API decision; it must
not be accidentally frozen by this feasibility fixture.

WGSL `binding_array` remains outside semantic v1 and the first alpha.
