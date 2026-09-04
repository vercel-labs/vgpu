# C1 shader I/O projection

This spike tests the boundary between portable WGSL entry-point interfaces, Tint's Metal lowering,
and the state a direct Metal runtime must build. It uses Dawn/Tint commit
`8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca`, compiles the generated MSL with the real Metal
runtime, creates positive and negative render pipelines, and checks six GPU readbacks.

## Result

Capture the complete portable interface from Tint core IR before Metal raise. `Inspector` is a
useful cross-check for user locations and effective interpolation, but it deliberately omits
builtins and cannot be the interface oracle. The selected-entry compiler request should carry this
complete semantic view so the worker can compare it exactly before lowering.

Tint's public `Raise()` then `Print()` seam produces the same MSL and final IR as `Generate()` for
all twelve canaries. It also exposes a backend-private raised interface that the worker can use to
verify its pinned lowering. Do not serialize raised struct or member names: they are synthesized,
collision-sensitive, and the remapped entry-point name is applied only while printing.

The final artifact can remain layered:

- the semantic contract owns the complete backend-neutral interface and portable stage-link
  validation;
- the compiler boundary uses a complete Metal-lowered view to fail closed against the requested
  semantics; and
- the serialized Metal runtime projection needs only physical vertex attributes and fragment
  color/blend-source outputs, because those are the I/O indices used to construct pipeline state.

The runtime projection must preserve sparse indices. Compacting locations changes the program.
Its exact maps and versioned interface model belong in the runtime-projection fingerprint.

## Tint evidence

The canary covers:

- sparse vertex inputs at locations 3 and 7;
- vertex and fragment builtins;
- sparse inter-stage locations 2, 5, and 6;
- default, linear/centroid, and flat interpolation;
- fragment depth and sample-mask outputs;
- an unnamed scalar return;
- a fragment output only at location 3;
- sparse MRT outputs at locations 1 and 4;
- dual-source outputs at location 0 with blend sources 0 and 1;
- a missing inter-stage location, an interpolation mismatch, and a type mismatch.

Core IR contains the complete `IOAttributes` data. In contrast,
`Inspector::GetEntryPoint()` exposes user variables but reduces builtins to a curated set of flags
and reports normalized interpolation even in directions where it is not a meaningful link
contract. The writer output contains MSL and a few generation facts, but no structured I/O map.

For this Tint pin, the generated Metal attributes observed by the gate are:

| WGSL role                                      | Metal role                    |
| ---------------------------------------------- | ----------------------------- |
| vertex input `@location(n)`                    | `[[attribute(n)]]`            |
| vertex output or fragment input `@location(n)` | `[[user(locnN)]]`             |
| fragment output `@location(n)`                 | `[[color(n)]]`                |
| `@blend_src(0 or 1)`                           | `[[index(0 or 1)]]`           |
| `@interpolate(linear, centroid)`               | `[[centroid_no_perspective]]` |
| `@interpolate(flat)`                           | `[[flat]]`                    |

The builtin canaries cover `position`, `vertex_id`, `instance_id`, `front_facing`, `sample_id`,
`depth(any)`, and `sample_mask`.

## Metal evidence

The runtime gate currently records one Apple M4 Pro / Metal 4 result. It does not claim Intel or
discrete-GPU coverage.

Metal accepts vertex attributes 3 and 7 when `MTLVertexDescriptor` contains those exact indices.
Omitting attribute 7 fails pipeline creation. Inter-stage user locations 2, 5, and 6 link without
being compacted, and a missing location or incompatible numeric type fails the link.

Metal did not reject a same-type interpolation mismatch in this experiment. The portable vgpu
validator must therefore require every fragment input location to have a vertex output with the
same scalar kind, component count, normalized interpolation type, and normalized sampling. Extra
vertex outputs remain valid.

Sparse fragment outputs are supported by Metal. A shader writing only color 3 rendered correctly
when only attachment 3 was configured. A shader writing colors 1 and 4 rendered both attachments
correctly. The runtime API must consequently use indexed records or an explicitly nullable slot
representation; a dense array of only the present formats is incorrect.

Metal also creates a pipeline when a shader output has no configured pixel format. The unmatched
output is silently discarded, and reflection does not reveal the omission. A safe public API should
reject an accidental missing slot by default and require an explicit discard marker when omission
is intentional.

Dual-source output is not MRT: blend source 1 at logical color 0 still uses one color attachment.
Both the unblended and Source1-factor pipelines produced the expected pixels on this device. This is
translator and runtime evidence, not a decision to enable the WGSL feature in the first product
profile; that needs an explicit language-feature and device-capability policy.

`MTLFunction` reflects vertex attributes but did not expose fragment stage inputs. The render
pipeline reflection exposed resource bindings only, not varyings, fragment outputs, interpolation,
or blend-source indices. Neither reflection nor successful pipeline creation can reconstruct or
validate the complete shader interface.

## Run

The default command validates the tracked canary surface and reports that native gates were skipped:

```sh
./experiments/native-metal-spikes/c1-shader-io-projection/run.sh
```

To compile the Tint prototype, pass the pinned Dawn release and exact supplemental-header overlay
recorded by `c1-tint-standalone`:

```sh
./experiments/native-metal-spikes/c1-shader-io-projection/run.sh \
  --release-root ../Dawn-8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca-macos-latest-Release \
  --compat-include ../tint-8f25-compat-include \
  --require-tint \
  --require-metal-runtime
```

The equivalent environment variables are `C1_SHADER_IO_TINT_RELEASE_ROOT`,
`C1_SHADER_IO_TINT_COMPAT_INCLUDE`, `C1_SHADER_IO_REQUIRE_TINT=1`,
`C1_SHADER_IO_SKIP_METAL_RUNTIME=1`, `C1_SHADER_IO_REQUIRE_METAL_RUNTIME=1`, and
`C1_SHADER_IO_REQUIRE_OFFLINE_METAL=1`.

The runner verifies the pinned archive and header tree, builds the Tint probe twice, requires
byte-identical executables and generated outputs, runs the Metal probe twice, and removes its
temporary directory. Native products never enter the repository.

If Apple's separately downloadable command-line Metal toolchain is installed, the runner also
compiles all twelve generated MSL files for `air64-apple-macos14.0` and links one `.metallib`.
`--require-offline-metal` makes that gate mandatory. Runtime compilation remains real Metal
evidence, but it does not replace the separate macOS 14 offline gate.

## Remaining integration

This spike establishes the extraction and validation seams; it does not yet change the compiler
protocol or artifact schemas. The next gate should add the exact semantic interface to each worker
request, derive a full private Metal interface after `Raise()`, return the runtime-relevant subset,
and kill mutations that omit, compact, duplicate, or retag any interface item.
