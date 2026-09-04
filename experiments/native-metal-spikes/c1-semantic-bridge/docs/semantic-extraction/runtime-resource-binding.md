# Runtime resource binding

Status: design selected; executable fixed-resource binding is the next C1 slice.

This slice connects one nominal Metal program projection to concrete runtime resources without
letting application code restate the physical slot map. It is an internal spike contract, not the
production Swift API proposed in the public documentation.

## Join semantics and physical slots once

The serializable Metal program fragment is intentionally not sufficient to validate a runtime
resource by itself. It owns physical stage-local slots, while `semantic-v1` owns the resource kind
and its constraints:

- buffer address space, access, layout, and minimum binding size;
- texture dimension, sample type, and multisampling;
- sampler kind; and
- per-entry texture/sampler compatibility.

`assembleMetalProgramProjection` already retains the exact nominal semantic assembly behind the
program projection. The runtime boundary therefore derives its layout from the projection alone:

```js
const layout = runtimeResourceLayoutForMetalProgramProjection(projection);
```

The function accepts no caller-provided assembly, allocation, descriptors, or slots. A cloned or
deserialized projection has no authority. The resulting frozen nominal layout contains only the
joined runtime facts:

```js
{
  semanticProgram,
  kind,
  bindings: [
    {
      semanticBinding,
      descriptor: {
        kind: "buffer",
        addressSpace: "uniform",
        access: "read",
        minimumBindingSize: 8,
        runtimeSized: false
      },
      slots: [
        { stage: "vertex", resourceClass: "buffer", index: 0, count: 1 },
        { stage: "fragment", resourceClass: "buffer", index: 0, count: 1 }
      ]
    }
  ],
  samplingPairs: [
    { stage: "fragment", texture: "g0b2", sampler: "g0b3", mode: "filtering" }
  ]
}
```

Bindings preserve semantic `(group, binding)` order. Slots preserve canonical stage and resource
class order. The layout omits authored and Swift names, MSL, compiler candidates, runtime objects,
buffer ranges, and derived storage-size words. Those facts have different owners.

## Prepare before encoding

Resource binding has two phases:

```js
const prepared = prepareMetalResourceBindings({ layout, resources });
encodeMetalResourceBindings(prepared, encoder);
```

The production Swift core follows the same boundary:

```swift
let prepared = try binder.prepare(layout: layout, resources: resources)
try binder.encode(prepared, into: encoder)
```

`prepare` requires exactly one logical value for every semantic binding. Generated Swift binding
sets provide those values; callers never provide a stage, Metal index, or resource class. The
binder validates the complete set, context identity, value variant, access and usage, buffer slice,
texture properties, sampler descriptor, and every sampling pair before producing a frozen or
otherwise immutable prepared value. A failure occurs before the first `setVertex*`,
`setFragment*`, or `setCompute*` call.

`encode` accepts only that prepared value and fans one logical resource out to all of its verified
stage-local slots. For example, one `frame` buffer may be encoded at both vertex `buffer(0)` and
fragment `buffer(0)`. Metal buffer, texture, and sampler indices remain independent namespaces in
each stage. The direct binding model in this slice requires `count: 1`; argument buffers and
resource arrays need a new binding model rather than an implicit branch here.

## Keep resource state with the resource

A buffer resource contributes its context identity, Metal object, logical byte length, usage,
offset, and explicit bound range. The range is validated against `minimumBindingSize`, the logical
length after the offset, the current integer ceilings, and the storage alignment rules. It is not
inferred from `MTLBuffer.length`, because a resource can expose only a logical slice of a larger
allocation.

A texture resource contributes its dimension, sample count, format classification, usage, and
Metal object. A sampler wrapper retains the descriptor facts required to prove filtering,
non-filtering, or comparison compatibility; `MTLSamplerState` alone does not expose enough state to
reconstruct that proof reliably. All wrappers retain the creating context identity.

Instance-owned uniform uploads remain resources at this internal boundary. Their frame-slot and
lifetime policy is upstream of `prepare`; the binder sees the already selected buffer slice and
does not decide which in-flight upload allocation wins.

## Runtime-sized storage remains projection-driven

This first live gate uses only fixed-size buffers, so its projection has no effective
`internalBindings` and no `storageBufferSizeRegions`. The candidate `immediate-data` reservation in
compiler requests must never be encoded.

When runtime-sized storage joins this path, `prepare` derives size words from the effective bound
ranges and the program projection's emitted regions. It does not accept caller-authored words or
promote unused candidate reservations. The existing C1 buffer-size spike remains the range and
word-layout oracle for that later integration.

## Executable proof

The connected gate will:

1. obtain MSL and emitted entry names only from the nominal program projection;
2. derive the runtime layout through the nominal join above;
3. validate all five logical resources before creating binding commands;
4. prove stage-local namespaces, including different resources at vertex and fragment
   `buffer(1)`, and prove that one shared uniform fans out to both stages;
5. use pipeline reflection only as an independent test oracle, never as runtime slot authority;
6. bind buffers, a sampled texture, and a filtering sampler through the prepared plan;
7. draw and compare an exact readback whose value depends on every logical resource; and
8. run static negatives for cloned ownership, incomplete or extra sets, incorrect resource kinds,
   invalid buffer ranges, incompatible texture/sampler facts, post-prepare mutation, and attempted
   use of the inactive `buffer(30)` candidate.

The test process may serialize a deterministic snapshot of the already validated layout to its
Swift probe. That file is test transport only: it is not an artifact format and does not turn raw
JSON into trusted runtime authority. The Swift probe decodes it strictly and independently checks
the fixture invariants before touching Metal.

No API decision in this fixed direct-binding slice is tied. Direct encoder calls follow the
accepted binding model; logical resources are keyed by semantic identity rather than stage; and
prepare/encode separation is required to preserve atomic validation.
