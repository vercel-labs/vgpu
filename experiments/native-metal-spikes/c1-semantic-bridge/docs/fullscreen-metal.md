# Full-screen translation and Metal canary

This companion gate carries the finalized full-screen source through the accepted one-entry Tint
translator, Apple's offline Metal tools, and a live render readback. It is executable evidence for
the frozen source profile, not the final semantic-bridge architecture: until the multi-entry
extractor exists, the two compiler requests use reviewed literal interfaces as an oracle.

Those literals must disappear from request construction once extraction is connected. At that
point the same gate remains useful, but the translator inputs must be projections of one
authenticated extraction rather than handwritten semantic claims.

## Exact path under test

The gate performs this sequence:

```text
authored fragment fixture
  -> authenticated Tint inventory
  -> nominal effect selection
  -> vgpu-native-fullscreen-triangle/v1 finalization
  -> explicit vertex/fragment link check
  -> two translations of each selected entry
  -> metal: two MSL files -> two AIR files
  -> metallib: one linked library
  -> Swift + Metal: two deterministic 2x2 readbacks
```

Both translator requests copy the finalized `source`, `originMap`, and language features. They omit
`originMapSha256` because the existing compiler schema does not contain that field, but the gate
recomputes and verifies the capsule's origin-map hash before projection. Requests use no bindings
or overrides and retain the existing v1 immediate-data reservation at `buffer(30)`.

The reviewed vertex interface is one `vertex_index` input, one perspective/center location-zero
`vec2f` UV output, and one position output. The fragment consumes that exact UV plus
`front_facing`, then writes one location-zero `vec4f` color. Interface arrays use compiler-protocol
canonical order: locations first, then built-ins.

Before any translator launches, the gate compares the render link's location, type, interpolation,
and invariance exactly. Reversing the vertex outputs fails the canonical request validator with
zero launches. A native request that changes the expected vertex UV from `vec2f` to `vec3f` remains
schema-valid but receives a structured `VGPU-NATIVE-TINT-INTERFACE` failure from Tint and produces
no MSL. That negative also runs twice, requires byte-identical responses, and locks its single
diagnostic message and response hash.

## Translation evidence

Each selected entry runs in two fresh worker processes. The gate requires byte-identical stdout,
validates the raw response schema, attaches only provenance proven by the final origin map,
validates the enriched schema and request-specific response semantics, and then compares the
minimal result exactly.

The accepted vertex result has no Metal attributes because it uses only `vertex_index`. The
accepted fragment result maps semantic color location zero to `[[color(0)]]`. Both results must have
empty external bindings, internal bindings, and storage-size regions, no workgroup size, no
diagnostics, and the exact requested WGSL and Metal entry names. A response for one stage is also
rejected when validated against the other stage's request.

The fixture, interface, finalized-source, request, response, and MSL hashes are checked-in
snapshots. AIR and metallib byte sizes are deliberately not snapshots because they are Apple
toolchain products; the gate instead requires regular, non-empty files and successful processes.

## Offline Metal and live readback

The offline gate compiles each accepted MSL source independently with:

```text
-std=macos-metal2.4 -target air64-apple-macos14.0
```

It then links both AIR files into one metallib. The Swift probe loads that library by URL and looks
up the names returned by the validated translator responses rather than maintaining a second set of
runtime names.

The fragment writes `uv.x`, `uv.y`, `front_facing`, and one into an `rgba8Unorm` target. The probe
draws the same three-vertex triangle twice with culling disabled: once with front-facing winding
explicitly set to counter-clockwise and once with clockwise as a control. Each draw renders a 2x2
target, so it observes direction rather than only the ambiguous center UV.

The exact row-major readbacks are:

```text
counter-clockwise:
[ 64,  64,255,255] [191,  64,255,255]
[ 64, 191,255,255] [191, 191,255,255]

clockwise control:
[ 64,  64,  0,255] [191,  64,  0,255]
[ 64, 191,  0,255] [191, 191,  0,255]
```

Increasing green from the first row to the second proves top-origin UV. Blue proves that the v1
vertex order is front-facing under explicit counter-clockwise state; the clockwise control keeps UV
and coverage unchanged while flipping only that fact. Alpha also makes incomplete coverage fail.

## Run

The static gate uses a reviewed local inventory response to exercise the real authentication,
selection, finalization, render-link, compiler-schema, compiler-semantics, and request-snapshot path
with zero compiler launches. It does not require native tools:

```sh
node experiments/native-metal-spikes/c1-semantic-bridge/gates/fullscreen-metal.mjs
```

The complete accepted path is:

```sh
node experiments/native-metal-spikes/c1-semantic-bridge/gates/fullscreen-metal.mjs \
  --worker experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64 \
  --require-worker \
  --require-offline-metal \
  --require-metal-runtime
```

The recorded run used Apple M4 Pro. It performed one inventory invocation, four successful
translation invocations, two byte-identical invocations of one structured negative case, two AIR
compilations, one metallib link, and two byte-identical runtime executions. This is not Intel, AMD,
or cross-machine evidence. It also does not replace semantic extraction, program assembly, artifact
packaging, or the complete repository corpus gate.
