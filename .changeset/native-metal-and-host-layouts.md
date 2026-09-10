---
"vgpu": minor
"@vgpu/wgsl": minor
"@vgpu/core": minor
---

## Summary

Add public `vgpu native doctor`, `check`, `build`, and `verify` command routing and
guides for generating self-contained Swift/Metal shader packages. Commands load
the optional companion lazily; help does not require it or a native toolchain.
The `@vgpu/native` companion remains private and unpublished. This changeset does
not publish it or qualify a release compatibility matrix.

Expose captured WGSL source graphs and authored entry-point declaration spans for
consistent build-time validation and generation. Imports are resolved once per
captured graph, and snapshot resolution retains the captured source and edges.

Breaking changes for this pre-1.0 minor: reflected host-shareable layouts now use
intrinsic WGSL alignment and size, with `layoutMode: "wgsl-host-shareable-v1"`.
Read address space from the binding, not the removed
`HostShareableLayout.addressSpace` field. Code relying on the previous
`"naga-standard"` mode or padded uniform layout sizes must migrate.

JavaScript-owned binding values now require the reflected shape, exact component
counts, and in-range integers instead of silent coercion, truncation, or filling.
Invalid values produce `VGPU-SET-VALUE-INVALID` with structured reason/path and
expected/actual details. Binding ownership and stored values are retained when
candidate validation fails; this is a per-candidate guarantee, not an atomic
transaction across `set({ a, b })` or a rollback of arbitrary GPU errors. Shared
uniform updates preserve the previous accepted value on validation failure, and
half-float packing uses round-to-nearest, ties-to-even.

The strict binding checks and candidate handling add approximately 1.4 KB gzip to
the measured full client entry; `init-only` is unchanged. The changed WGSL runtime
modules add approximately 2.8 KB gzip to the tooling entry. Captured-graph modules
are absent from the measured browser entries. Only the six affected package
bundle ceilings are updated to the existing 512-byte convention;
audiences, growth thresholds, and unrelated ceilings are unchanged.

This changeset requests the next minor; it does not assign or publish a version.

## Migration

### Affected usage

Consumers of the earlier host-layout and JavaScript-owned binding contracts,
including those in vgpu 0.4.x and 0.5.0-rc.0, must review custom reflection/packing
code and values passed to `effect`, `draw`, `compute`, and shared `uniforms`.
The changes affect both browser/WebGPU use and native build-time tooling; they
are not conditional on opting into Metal. Existing valid values need no shape
change. The captured-source-graph APIs and optional native CLI commands are new;
handwritten `WGSLModule` objects also need the new declaration metadata below.

### Steps

1. Replace comparisons against `"naga-standard"` with
   `"wgsl-host-shareable-v1"`. Regenerate cached reflection metadata and derive
   offsets, sizes, alignment, and strides from the new layout instead of
   carrying forward implicit uniform-only padding. Read `binding.addressSpace`,
   not `binding.layout.addressSpace`. Address-space validation is separate from
   intrinsic layout; it does not repair an invalid WGSL declaration by changing
   its bytes. If a shader depended on implicit padding to satisfy uniform
   constraints, express the required alignment/size in WGSL and revalidate it.
2. Supply numbers for numeric scalars and complete, correctly typed values for
   each reflected binding. Use arrays or typed arrays with exact vector/matrix
   component counts and fixed-array lengths; matrices remain column-major.
   Supply integers within the `i32`/`u32` range instead of relying on coercion,
   truncation, or wrapping. Struct values must have all required members and no
   unrelated fields. Select fields when reusing a larger settings object.
   Later direct struct updates still shallow-merge with an existing binding
   value; shared uniforms still deep-merge plain objects, but the resulting
   candidate must be valid. Member shorthand starts from reflected zero values
   when the binding has not received a value yet.
3. Handle `VGPU-SET-VALUE-INVALID` as a rejected candidate. Its structured detail
   contains `reason`, `path`, `expected`, and `actual` (and scalar `type` where
   applicable). A validation failure preserves that binding's previous accepted
   values and ownership. A first invalid shared-uniform value is rejected when
   a shader first adopts its layout. Do not assume global atomicity for
   `set({ a, b })`: an earlier binding may already have changed when a later
   binding fails. Separate member-shorthand keys are sequential even when they
   target the same binding. This is not rollback of arbitrary GPU errors.
4. If checking packed `f16` bytes or implementing another packer, update expected
   halfway rounding to round-to-nearest, ties-to-even.
5. If constructing `WGSLModule` fixtures or adapters by hand, provide the required
   `entryPointDeclarations` array. Use an empty array only for modules without
   entry points; otherwise include their authored names, stages, and declaration
   spans. Resolver-produced modules already supply this field. Span lines and
   UTF-16 columns are 1-based, and the end position is exclusive.

#### Reflection access before

```ts illustrative
const addressSpace = binding.layout.addressSpace;
if (binding.layout.layoutMode === "naga-standard") {
  useCachedUniformOffsets();
}
```

#### Reflection access after

```ts illustrative
const addressSpace = binding.addressSpace;
if (binding.layout?.layoutMode === "wgsl-host-shareable-v1") {
  useReflectedOffsetsAndStrides(binding.layout);
}
```

#### Binding values before and after

```ts illustrative
// WGSL: struct Params { gain: f32, tint: vec3f }
// Before: a string, missing vector components, and unrelated fields were tolerated.
shader.set({ params: { gain: "1", tint: [1], debug: true } });

// After: provide only the complete values required by this binding.
shader.set({ params: { gain: 1, tint: [1, 0, 0] } });
```

Native commands do not change existing WebGPU deployment requirements. Opt-in
native generation needs the documented private companion and macOS/Xcode Metal
toolchain; the public CLI alone does not install or publish `@vgpu/native`.
Follow the native tooling guides for configuration, supported shader profiles,
output ownership, and verification. This development changeset does not qualify
cold installation, signing, or an Intel/minimum-OS release matrix.

### Verification

Typecheck reflection consumers to find removed-field and old-mode references.
Recompute layout/packing fixtures and compare member offsets, strides, and
`f16` bytes. Exercise valid updates plus wrong shapes, unknown/missing fields,
and out-of-range integers; confirm the rejected binding retains its last valid
value and that multi-binding callers do not rely on all-or-nothing updates.
Run affected WebGPU rendering/compute paths after selecting exact struct fields.
For native opt-in, run `vgpu native doctor`, `check`, `build`, and `verify` using
the documented configuration, then build and execute a generated Swift consumer
on the intended Mac. The partial examples above are illustrative, not standalone
typechecked programs.
