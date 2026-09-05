# C1 Metal immediate-data layout v1

This spike validates a fixed, versioned immediate-data ABI for the Metal
projection. It intentionally does not reproduce Dawn's pipeline-dependent
compact immediate mask.

## Result

`vgpu-metal-immediate-data-layout-v1` is feasible with the pinned Tint writer:

| Stage    | Non-constant zero | Fragment depth min/max | Storage-buffer sizes |
| -------- | ----------------: | ---------------------: | -------------------: |
| Compute  |          byte `0` |                      — |             byte `4` |
| Vertex   |          byte `0` |                      — |             byte `4` |
| Fragment |          byte `0` |        bytes `4` / `8` |            byte `12` |

All offsets are stable for the stage even when a role is unused. In particular,
the no-depth fragment does not configure Tint's depth-range transform, but its
storage-size word remains at byte `12`. Tint emits an eight-byte padding field
from bytes `4..<12` instead of compacting the table toward byte `4`.

The physical binding remains Metal `buffer(30)`. Metal reflection reports an
8-byte, 4-byte-aligned immediate block for compute and vertex, and a 16-byte,
4-byte-aligned block for both fragment variants. The fragment that writes
`frag_depth` materializes the min and max floats at bytes `4` and `8`; the
fragment without `frag_depth` materializes padding over the same reserved span.

This makes the layout version the ABI authority while Tint remains the
authority over which internal roles are effective for a selected entry point.
Runtime size words, bound ranges, uploads, and padding added for the upload
mechanism remain dynamic state rather than shader identity.

## Evidence

The runner generates compute, vertex, depth-writing fragment, and no-depth
fragment MSL twice in separate Tint invocations and requires byte-identical
metadata and source. The recorded MSL hashes are:

- compute: `8c4ebfa39c65a8f3efb36e6af43a004561fedf99b0040f8dd7244071ce2c7f6d`;
- vertex: `8281a6536527239b17be2c4f0380daecec4a09505ce5dfe045a63a3c414ec10f`;
- fragment with depth: `11ed7f8955a7be94856144893e5d68ad03dcf6c480fc568b7c38a21f40b40012`;
  and
- fragment without depth: `e6f3a1f21c6112b23a1c15c0e5b5644f7a598cbfa842cac7971e83f6a6383217`.

Each source compiles to `air64-apple-macos14.0` AIR and links into its own
nonempty metallib.

The live Metal probe renders twice from one 512-byte storage allocation. The
second render rebinds the vertex and fragment storage buffer from byte `0` to
byte `256`, changes the logical range word from `16` to `28`, and changes the
depth range:

- canonical readback: color `[4, 4, 11, 11]`, depth bits `0x3f19999a` (`0.6`);
- rebound readback: color `[7, 7, 22, 22]`, depth bits `0x3ecccccd` (`0.4`).

The first two color words are the fragment and vertex `arrayLength()` results.
The last two are the first storage values observed independently by those
stages, so the result covers both the table update and the real external-buffer
rebind. The authored depth is `0.9`; the exact depth readbacks prove the
fragment min/max words were consumed at their v1 offsets.

The exact immediate uploads are:

- vertex canonical: `0000000010000000`;
- vertex rebound: `000000001c000000`;
- fragment canonical: `00000000cdcc4c3e9a99193f10000000`; and
- fragment rebound: `00000000cdcccc3dcdcccc3e1c000000`.

Two independent live processes returned byte-identical JSON on the local Apple
M4 Pro. The recorded response hash is
`5c9f76fa739045df250f418dbe8dd2b85f6c0ebca5309bf9ab4bf8dd2869db23`.

## Run

The runner downloads and installs nothing. Pass the already extracted official
Dawn release and its verified missing-header overlay:

```sh
./run.sh \
  --release-root ../Dawn-8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca-macos-latest-Release \
  --compat-include ../tint-8f25-compat-include \
  --require-tint \
  --require-offline-metal \
  --require-metal-runtime
```

The equivalent environment variables are
`C1_IMMEDIATE_LAYOUT_TINT_RELEASE_ROOT`,
`C1_IMMEDIATE_LAYOUT_TINT_COMPAT_INCLUDE`,
`C1_IMMEDIATE_LAYOUT_REQUIRE_TINT=1`,
`C1_IMMEDIATE_LAYOUT_SKIP_METAL_RUNTIME=1`,
`C1_IMMEDIATE_LAYOUT_REQUIRE_METAL_RUNTIME=1`, and
`C1_IMMEDIATE_LAYOUT_REQUIRE_OFFLINE_METAL=1`.

Without a release root, the runner reports the native gates as skipped. With a
release root, it verifies the pinned `libwebgpu_dawn.a` and supplemental
`compiler.h` hashes before compiling anything. Temporary MSL, AIR, metallibs,
and executables are deleted at the end of every run.

## Limits of the evidence

The live result covers the local Apple-silicon device only. It does not
establish behavior on Intel Macs or discrete AMD GPUs. The canary uses one
runtime-sized storage word and the currently selected internal roles; adding
user immediates or new internal roles would require either compatible reserved
space or a new layout version. The connected compiler and artifact contracts
now encode the layout identifier and effective regions in the Metal projection,
not in the backend-neutral semantic graph. The connected semantic bridge also
passes live binding and readback for an assembled runtime-sized program using
this compute layout. Production API integration and broader internal-role
coverage remain separate work.
