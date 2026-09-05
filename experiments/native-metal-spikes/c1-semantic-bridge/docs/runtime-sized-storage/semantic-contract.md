# Runtime-sized semantic contract

The semantic extractor owns WGSL type and layout meaning. TypeScript validates and joins its graph,
but does not calculate `AlignOf`, `SizeOf`, member offsets, or array strides.

## Canonical shapes

A runtime array uses the existing array type descriptor without `count`:

```json
{
  "kind": "array",
  "element": "t_<element>"
}
```

Its layout has `runtimeSized: true`, retains `arrayStride`, sets `minimumSize` to the zero-element
footprint, and omits `size`:

```json
{
  "type": "t_<runtime-array>",
  "alignment": 4,
  "minimumSize": 0,
  "runtimeSized": true,
  "arrayStride": 4,
  "members": []
}
```

A structure may contain a runtime array only as its final member. The root structure layout is also
runtime-sized. Its `minimumSize` is the fixed zero-element prefix, while the trailing member has its
authored offset, `minimumSize: 0`, `runtimeSized: true`, and no `size`. Every other reachable member
and child layout remains fixed.

Type and layout IDs keep the existing domain-separated content hashes. Omitting `count` and `size`
and retaining `runtimeSized: true` are semantic identity, not presentation.

## Layout minimum versus binding minimum

For a runtime-sized root layout:

- `layout.minimumSize` is the fixed prefix with zero trailing elements;
- `binding.minimumBindingSize` is the smallest valid storage binding and includes one complete
  trailing element stride plus any enclosing structure padding required by WGSL; and
- neither value is an allocation-specific element count or final byte range.

For example, a structure containing one `u32` prefix followed by `array<u32>` has a root
`minimumSize` of `4`, an array stride of `4`, and a binding `minimumBindingSize` of `8`.

The validator requires the root binding type/layout pair to agree, preserves the exact reachable
graph, and rejects a runtime-sized record that is not reached by a storage buffer. A uniform cannot
contain a runtime-sized layout. That address-space restriction is validation; it does not rewrite
the intrinsic layout.

## Entry-local use

Runtime-sized is a property of a binding layout, not proof that generated code needs a byte-size
table. A selected entry that reads only the fixed prefix may translate without an effective size
region or immediate-data binding. If another runtime-sized binding in the same selected stage makes
the region effective, runtime packing still includes every runtime-sized storage binding projected
for that stage, including the prefix-only binding.

The extractor therefore returns semantic facts only. It never predicts
`storageBufferSizeRegions`, Metal slots, packed words, or concrete ranges.
