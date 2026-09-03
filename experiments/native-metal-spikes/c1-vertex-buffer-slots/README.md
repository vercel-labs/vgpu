# C1 Metal vertex-buffer slots

This spike tests how a Metal render pipeline should combine artifact-fixed shader buffer bindings
with vertex-buffer streams. Metal exposes both through the vertex stage's buffer table, so a
projection must keep them disjoint before pipeline creation.

## Result

The pipeline-local hybrid is the candidate. Shader and internal indices remain exact artifact
data. Only the mapping from a logical vertex stream to a Metal buffer index is derived when the
render pipeline is created:

```text
shaderOccupiedEnd = max(shader interval start + count)
stream[i] = shaderOccupiedEnd + i
shaderOccupiedEnd + activeStreamCount <= externalBufferCeiling
```

The fixed `0...20` shader plus `21...28` vertex partition remains in the snapshot as a comparison
baseline. It is deterministic, but rejects a zero-stream program that uses shader buffer index 28.
The hybrid accepts that program and still produces the same `21...28` mapping for the exact
21-shader-buffer, eight-stream case. A sparse case with shader buffers at indices 0 and 11 maps its
first stream to 12, proving that the calculation uses the occupied interval end rather than the
number of bindings.

The allocator and an independently implemented, side-effect-free verifier agree on six cases,
seventeen input mutations, and ten corrupted-output mutations. The fixtures cover zero, one, and
eight streams; pipelines with and without emitted internal bindings; sparse shader intervals;
exact capacity; semantic and physical overflow; deterministic input reordering; and safe mapping
key reuse.

The exact-capacity runtime canary binds all 31 fixture entries, not only reflects them. Eight
vertex streams contribute red, twelve user constants plus two internal constants contribute green,
and nine storage-style arguments contribute blue; the readback is `[128, 64, 191, 255]`.

## Why pipeline creation is not a collision check

The collision canary maps a stage-input attribute and an explicit shader argument to buffer index 0. Metal successfully creates that pipeline. Binding reflection then reports two used entries at
the same index: one stage-input binding and one explicit argument.

The readback makes the alias observable. One draw binds values A then B at index 0 and returns
`0.75`; a second binds B then A and returns `0.25`. The last `setVertexBuffer` supplies both the
vertex fetch and shader argument. The allocator and verifier therefore must reject overlapping
intervals themselves; a successful `makeRenderPipelineState` call is not an oracle.

## Candidate contract

The allocator combines versioned artifact data with pipeline-local vertex-layout state:

- the artifact supplies `shaderBufferIntervals`, `internalReservations`,
  `externalBufferCeiling`, and its runtime-projection fingerprint;
- the vertex layout supplies its fingerprint and active stream count;
- the derived pipeline record stores `vertexInputRange`, including the smaller of physical
  capacity and the semantic stream limit; and
- that record maps active logical `vertexStreams` contiguously from the range start.

The runtime consumes that projected range; it does not reconstruct a ceiling from hardcoded role
indices. The fixture reserves 29 and 30 for two internal roles, so its external ceiling is 29.
Those indices, the static boundary at 21, and this profile's use of all indices `0...30` are fixture
values, not a stable ABI. Metal's 31-entry buffer argument table is a documented platform limit;
how vgpu partitions that table remains versioned projection policy. See Apple's
[Metal capability tables](https://developer.apple.com/metal/capabilities/).

The stream-mapping cache key includes all of the following:

- the semantic program fingerprint;
- the runtime-projection fingerprint that covers emitted Metal and its exact slot map;
- the vertex-layout fingerprint; and
- the binding-profile version.

The fingerprint objects use the same domain-plus-SHA-256 shape as the native contracts, but their
hash bytes are fixture sentinels. This spike validates key composition and collisions, not the
production fingerprint preimages or hashing implementation.

Two render pipelines may reuse the same key and mapping when those inputs are identical, for
example when only blend or target state differs. Reusing the key with different shader intervals,
stream cardinality, or internal requirements is rejected as a mapping-key collision.

The fixture's maximum of eight vertex streams follows the current geometry contract. Physical
buffer-table capacity and semantic per-resource limits are intentionally separate. In particular,
the exact-capacity Metal canary uses twelve user `constant` arguments, nine storage-style `device
const` arguments, and two internal `constant` arguments. That keeps the canary at fourteen
constant-buffer arguments while exercising 31 table entries. Fourteen is a conservative fixture
budget, not a current Metal-family limit or evidence for the untested Intel and discrete-GPU paths.
An alpha may still choose stricter semantic limits, such as twelve uniforms and eight storage
buffers, after translator and device-matrix evidence; this spike does not decide those per-class
caps.

The runner parses the exact-capacity source before any native gate and requires precisely that
12-user-constant, 9-storage-style, 2-internal-constant split. This deterministic guard catches an
accidental all-`constant` rewrite even on a device that accepts more constant arguments.

## Pipeline-switch canary

Two pipelines with the same vertex layout derive different physical stream indices. Pipeline A
uses shader buffer 0 and stream 1. Pipeline B uses shader buffers 0 and 1 and stream 2. Five draws
run in one render command encoder:

```text
A rebound -> B stale -> B rebound -> A stale -> A rebound
green       black      green        white      green
```

The stale pixels prove that `setRenderPipelineState` neither clears nor remaps the vertex buffer
table. The stream must be rebound at its projected Metal index when the pipeline mapping changes;
caching only by logical stream number is incorrect. The prototype performs that rebinding and
checks exact RGBA8 readback. Implementing the same transition in the production state tracker is a
separate gate.

## Run

The default command always runs the pure allocator, mutations, verifier, and snapshot. On macOS it
also builds and runs the Swift/Metal canaries when `swiftc` and a Metal device are available:

```sh
./run.sh
```

Require or skip the runtime gate explicitly with:

```sh
./run.sh --require-metal-runtime
./run.sh --skip-metal-runtime
```

`C1_VERTEX_REQUIRE_METAL_RUNTIME=1` and `C1_VERTEX_SKIP_METAL_RUNTIME=1` are equivalent environment
variables. The runner compiles the Swift harness for the host architecture with a macOS 14.0
deployment target and reports the exact target triple. This checks the harness against the
baseline API surface; it is not execution on macOS 14 or evidence for another CPU/GPU family.

When Apple's separately downloadable offline Metal tools are installed, the same run compiles all
three MSL fixtures with Metal 2.4 for a macOS 14 deployment target and links metallibs. Make that
gate mandatory with:

```sh
./run.sh --require-offline-metal
```

`C1_VERTEX_REQUIRE_OFFLINE_METAL=1` is equivalent. The default run records a skip and names each
missing tool when `metal` or `metallib` is unavailable. The runner downloads and installs nothing,
writes native products only to a temporary directory, runs the runtime probe twice, and removes the
directory on exit.

## Scope of the evidence

The current runtime result is from one Apple silicon machine. There is no Intel or discrete-GPU
hardware result. An x86_64 compile and Rosetta run can reduce CPU-path risk but cannot establish
Intel or AMD GPU behavior.

Runtime compilation with MSL 2.4 on the active OS does not replace the offline macOS 14 gate. The
fixtures are handwritten MSL that isolate Metal's slot and encoder-state behavior; they do not yet
prove that the WGSL translator, artifact serializer, loader, and draw runtime preserve this mapping
end to end. The next integration gate should feed the binding projection's real shader intervals,
internal reservations, and runtime-projection fingerprint into this pipeline-local mapping and
exercise the same switch sequence through the native command path.
