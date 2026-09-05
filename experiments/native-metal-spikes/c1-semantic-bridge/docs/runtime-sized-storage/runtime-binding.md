# Runtime-sized storage binding

The runtime consumes one nominal semantic program and its authenticated Metal projection. It does
not inspect generated MSL or infer which internal fields Tint emitted.

## Validate concrete ranges

For every active runtime-sized storage binding, encoding captures one logical buffer generation,
effective offset, and effective byte range. Before touching Metal, the runtime requires that the
range:

- is at least the binding's reflected `minimumBindingSize`;
- fits within `logicalBufferSize - effectiveOffset`;
- fits in `UInt32`; and
- is a multiple of four bytes for a storage binding.

The range need not be a multiple of the runtime array stride. Tint subtracts the trailing member
offset and performs the element-size division. The size word is the effective bound range, not
`MTLBuffer.length` and not the physical allocation remainder after the offset.

## Pack only an effective region

When the selected stage has no `storageBufferSizeRegions` entry, the runtime packs no table even if
the semantic program contains a runtime-sized layout.

When a region is present:

1. collect every runtime-sized storage binding projected into that stage;
2. derive `wordCount` as one past their highest physical Metal buffer index;
3. initialize that many `UInt32` words to zero;
4. write each captured effective byte range into the word matching its Metal buffer index; and
5. place those words at the region's model-validated byte offset in the stage's single
   `immediate-data` payload.

Fixed storage buffers and uniforms leave zero holes and do not extend the table. A runtime-sized
binding whose generated code reads only its fixed prefix still participates when another binding
causes the stage region to exist; this keeps table extent derivation a projection/runtime rule
instead of an MSL parser.

The prefix roles are filled according to `vgpu-metal-immediate-data-layout-v1`. Unused fixed roles
are zeroed unless the corresponding pipeline/runtime feature supplies a value. Upload size may be
rounded for the selected Metal mechanism, but those padding bytes are deterministic and remain
transient.

## Encode and rebind

Resource generations and ranges are captured for each encoded command. Replacing a binding or
changing its effective range causes the runtime to bind the new external buffer/range and repack the
immediate payload before the next use. No artifact regeneration or pipeline specialization is
required merely because the runtime-array length changed.

The live gate proves this with two ranges over one oversized backing allocation. With the same
generated Metal function, projection, allocation, and binding offset, ranges `28` and `52` upload
size words `[0, 28]` and `[0, 52]`; `arrayLength()` plus a last-element read return `[2, 202]` and
`[4, 404]`. Two M4 Pro processes produce the same report. Eleven malformed manifests and four
invalid concrete ranges fail before dispatch.
