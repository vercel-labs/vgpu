---
"vgpu": minor
"@vgpu/wgsl": minor
"@vgpu/core": minor
---

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
