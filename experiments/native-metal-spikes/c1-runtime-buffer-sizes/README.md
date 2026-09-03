# C1 runtime storage buffer sizes

This spike tests the byte-size table that Tint needs when lowering WGSL `arrayLength()` to Metal.
It compares Tint's legacy dedicated UBO path with the immediate-data path used by the pinned Dawn
Metal backend.

## Result

The immediate-data transport is the candidate. One stage-local internal binding at Metal
`buffer(30)` carries ordinary immediates and the storage-buffer-size region together, leaving the
generic external buffer interval at `0..<30`. The legacy UBO transport remains in the canary only
as an equivalence check; it should not become the artifact contract.

The candidate size-table rule is direct and sparse:

- a runtime-sized storage binding projected to Metal `buffer(i)` reads size word `i`;
- only runtime-sized storage bindings contribute values, so fixed storage and uniform bindings
  leave zero holes within the derived extent and do not extend it when they occupy higher slots;
- each value is the concrete binding range in bytes, not `MTLBuffer.length` and not the remaining
  physical allocation after the bound offset; and
- the region's `wordCount` is one past its highest runtime-sized storage Metal buffer index.

The compute canary has five runtime arrays at Metal indices `0`, `2`, `3`, `4`, and `5`, with a
fixed result buffer interleaved at index `1`. The canonical words are
`[32, 0, 32, 36, 20, 112]`. The fixture's immediate block has a non-constant-zero word at byte zero,
so the size region begins at byte `4`; its 24-byte payload is uploaded as a 32-byte block after
alignment. Offset `4` is evidence for this pipeline layout, not a universal constant: artifacts
must record the per-stage offset calculated from that pipeline's immediate mask.

The minimum binding sizes include the layout through one full runtime-array stride, including any
member or element padding: `A` is `4`, `B` is `16`, `C` is `32`, `D` is `16`, and `E` is `24`
bytes. The fixed `Result` buffer remains `40` bytes. A separate allocator case places one runtime
storage buffer at slot `2`, fixed storage at `28`, and a uniform at `29`; its table still ends at
word `2`, proving that higher non-runtime slots do not extend the payload.

On the tested Metal runtime, immediate data reflected as size/alignment `28/4` bytes for compute,
`8/4` for the vertex stage, and `28/4` for the fragment stage. The equivalent UBOs reflected as
`32/16`, `16/16`, and `32/16`. Both transports returned the same results:

- canonical ranges: `[2, 3, 4, 5, 6]`;
- a second dispatch after rebinding larger ranges: `[3, 4, 5, 6, 7]`; and
- a deliberately dense, semantic-order table: `[2, 3, 0, 28, 268435455]`, proving that dense
  runtime-binding order is not interchangeable with physical Metal indices.

Each result buffer also contains five zero values read from the actual storage buffers. Those reads
prevent Metal from optimizing the projected user buffers out of reflection. All five runtime
bindings share a 2,048-byte `MTLBuffer` at different offsets while their logical ranges remain much
smaller. This makes the successful canonical readback evidence for range-byte packing rather than
physical buffer-length packing. An all-storage compatibility table, which additionally writes the
unused fixed-buffer word, returns the same result; the minimal runtime-only payload remains the
candidate.

The stage-local canary compiles the same WGSL storage binding twice: vertex projects it to
`buffer(0)`, while fragment projects it to `buffer(5)`. Metal render-pipeline reflection reports
vertex buffers `[0, 29, 30]` and fragment buffers `[5, 30]`. Index `29` is a consumed vertex stream,
so pipeline creation also covers the exact-capacity coexistence of vertex stream `29` and immediate
data `30`. This is pipeline-compilation and reflection evidence; the stage-local render pipeline is
not drawn.

## Candidate boundaries

The artifact root retains the size-table model. Each program/stage region retains only its byte
offset, while the physical slot lives once in the stage's `immediate-data` internal binding.
`wordCount` is derived as `max(runtime-sized projected Metal slots) + 1`; it is not serialized in
the artifact. Bound ranges, packed words, derived extent, upload padding, and whether the runtime
uses `set*Bytes` or a ring buffer are runtime state, not shader identity or artifact fingerprints.
The snapshot in this spike intentionally includes those dynamic values because it tests the
runtime packer; it is not an artifact schema.

`immediate-data` and `storageBufferSizes` are separate concepts. The fixture includes a program
with `immediate-data` at `buffer(30)` and no storage-size region, demonstrating that other immediate
features may still require the physical binding. Presence of the region, not presence of the
binding, triggers size packing.

Before packing, the allocator rejects ranges above `UInt32.max`, below the reflected
`minimumBindingSize`, beyond `logicalBufferSize - effectiveOffset`, or not aligned to four bytes as
required for storage bindings. A range need not be an exact multiple of the runtime array's element
stride; Tint performs integer division after subtracting the runtime-array member offset.

## Run

The pure JavaScript allocator, independent verifier, fixture snapshot, and mutation suite need no
native tools:

```sh
./run.sh
```

To run the pinned Tint comparison and the Metal runtime canary, provide the already extracted
official Dawn release and its verified missing-header overlay:

```sh
./run.sh \
  --release-root ../Dawn-8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca-macos-latest-Release \
  --compat-include ../tint-8f25-compat-include \
  --require-tint \
  --require-metal-runtime
```

The equivalent environment variables are `C1_SIZE_TABLE_TINT_RELEASE_ROOT`,
`C1_SIZE_TABLE_TINT_COMPAT_INCLUDE`, `C1_SIZE_TABLE_REQUIRE_TINT=1`,
`C1_SIZE_TABLE_SKIP_METAL_RUNTIME=1`, `C1_SIZE_TABLE_REQUIRE_METAL_RUNTIME=1`, and
`C1_SIZE_TABLE_REQUIRE_OFFLINE_METAL=1`.

The runner downloads and installs nothing. It verifies the pinned `libwebgpu_dawn.a` and
supplemental `compiler.h` hashes, rejects accidental use of Tint's automatic binding allocator,
checks post-lowering buffer slots, generates both transports twice, and deletes its temporary build
directory. If both `metal` and `metallib` are available, it additionally compiles and links the
generated compute MSL for the explicit `air64-apple-macos14.0` target. Use
`--require-offline-metal` to make that optional gate mandatory.

The recorded run passes 4 allocator programs, 27 input mutations, 11 independently verified source
or output corruptions, 6 native map failures, deterministic immediate/UBO generation, Metal
reflection, and readback. The offline gate is skipped because `metallib` is unavailable.

## Limits of the evidence

The native result is from the local Apple-silicon machine only. It does not establish behavior on
Intel Macs, discrete AMD GPUs, or Windows/Vulkan. The official Dawn archive is an arm64 feasibility
dependency with a macOS 26 deployment target, not the production compiler artifact. No offline
Metal result is claimed until both compiler tools execute successfully. The fixture values
(`buffer(30)`, offset `4`, and the buffer ceilings) validate this candidate profile; only the slot
partition is supported by the pinned Dawn backend, while the immediate-region offset remains
pipeline-specific.

Primary pinned implementation references:

- [Dawn Metal shader translation](https://dawn.googlesource.com/dawn/+/8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca/src/dawn/native/metal/ShaderModuleMTL.mm)
- [Dawn Metal pipeline layout](https://dawn.googlesource.com/dawn/+/8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca/src/dawn/native/metal/PipelineLayoutMTL.h)
- [Dawn Metal immediate upload](https://dawn.googlesource.com/dawn/+/8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca/src/dawn/native/metal/CommandBufferMTL.mm)
- [Tint MSL writer options](https://dawn.googlesource.com/dawn/+/8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca/src/tint/lang/msl/writer/common/options.h)
