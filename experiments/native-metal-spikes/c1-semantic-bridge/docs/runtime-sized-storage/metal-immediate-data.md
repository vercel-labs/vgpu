# Metal immediate-data layout

The Metal projection uses one stable, versioned internal layout instead of reproducing
Dawn's pipeline-specific compact `ImmediateMask` or asking the compiler worker to plan the ABI in a
second pass.

The model identity is:

```text
vgpu-metal-immediate-data-layout-v1
```

It is Metal-only projection data and never crosses into `semantic-v1`. A future Vulkan projection
defines its own push-constant or internal-data layout.

## Fixed offsets by stage

Offsets do not change when a role is unused:

| Stage            | Byte offset | Role                 | Type                  |
| ---------------- | ----------: | -------------------- | --------------------- |
| vertex / compute |         `0` | `nonConstantZero`    | `u32`                 |
| vertex / compute |         `4` | `storageBufferSizes` | trailing `array<u32>` |
| fragment         |         `0` | `nonConstantZero`    | `u32`                 |
| fragment         |         `4` | `fragDepthMin`       | `f32`                 |
| fragment         |         `8` | `fragDepthMax`       | `f32`                 |
| fragment         |        `12` | `storageBufferSizes` | trailing `array<u32>` |

The storage-size table is the final variable-length field. Adding a new fixed role or changing an
offset is an incompatible layout and requires a new model version. The layout intentionally does
not reserve speculative fields.

A fragment translation that needs storage sizes but not depth clamping still places the table at
byte `12`; Tint must emit padding for bytes `4..<12` instead of compacting the table to byte `4`.
Vertex and compute functions are already separate Metal stage functions, so their shorter fixed
prefix does not reduce function or pipeline reuse.

## Capacity before generation, use after generation

The translation request owns the layout model, candidate `immediate-data` slot, and offsets before
Tint runs. Those values reserve writer capacity; they do not claim that the generated entry uses an
internal binding or size region.

Tint's final raised interface and writer result remain authoritative:

- emit the `immediate-data` internal binding only when generated MSL uses it;
- emit one `storageBufferSizeRegions` record only when the selected stage needs the size table; and
- retain the compiler-reported region offset and verify that it equals the model's fixed offset for
  that stage.

The Metal projection records `immediateDataLayoutModel` separately from
`storageBufferSizeModel`. The first identifies role positions inside the shared block; the second
identifies the sparse table's contents. Runtime compatibility with the layout model is required only
when the selected stage has an effective `immediate-data` binding, including an entry that uses
ordinary immediates without a storage-size region.

Concrete ranges, table words, derived extent, upload padding, and upload mechanism remain runtime
state and do not affect artifact or runtime-projection fingerprints. The layout model, effective
internal slot, and effective region do affect the Metal runtime projection.

Whether a future pipeline option needs a distinct MSL variant remains separate. In particular,
depth-clamp enablement may select whether Tint consumes `fragDepthMin` and `fragDepthMax`; it never
changes their offsets or compacts later fields.
