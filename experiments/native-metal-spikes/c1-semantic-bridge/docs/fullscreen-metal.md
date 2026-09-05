# Full-screen translation and Metal canary

This companion gate carries the finalized full-screen source through authenticated semantic
extraction, resource-free `semantic-v1` assembly, the accepted one-entry Tint translator, Apple's
offline Metal tools, and a live render readback. The compiler requests are projections of the
nominal assembly rather than handwritten semantic claims. The checked-in interface JSON remains an
independent oracle for the static path and for comparing the native extraction; request construction
does not read semantic fields from it.

## Exact path under test

The gate performs this sequence:

```text
authored fragment fixture
  -> real virtual resolver + nominal declaration index
  -> checked-in resolved-WGSL and resolver snapshots
  -> authenticated Tint inventory
  -> nominal effect selection
  -> vgpu-native-fullscreen-triangle/v1 finalization
  -> two authenticated semantic extractions
  -> resource-free semantic-v1 assembly + vertex/fragment link
  -> one projected compiler request per selected entry
  -> two translations of each selected entry
  -> metal: two MSL files -> two AIR files
  -> metallib: one linked library
  -> Swift + Metal: two deterministic 2x2 readbacks
```

Both translator requests copy the finalized `source`, `originMap`, and language features. They omit
`originMapSha256` because the existing compiler schema does not contain that field, but the gate
recomputes and verifies the capsule's origin-map hash before projection. Requests use no bindings
or overrides and retain the existing v1 immediate-data reservation at `buffer(30)`.

The authenticated vertex interface is one `vertex_index` input, one perspective/center location-zero
`vec2f` UV output, and one position output. The fragment consumes that exact UV plus
`front_facing`, then writes one location-zero `vec4f` color. Interface arrays use compiler-protocol
canonical order: locations first, then built-ins. The authored fragment carries its resolver-owned
end-exclusive span exactly as `6:1–9:2`; the injected vertex has no authored name or source span.

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

The authored and resolved fixture, interface oracle, finalized source, semantic request and response,
program fingerprint, translation request and response, and MSL hashes are checked-in snapshots. AIR
and metallib byte sizes are deliberately not snapshots because they are Apple toolchain products;
the gate instead requires regular, non-empty files and successful processes.

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

The static gate runs the real resolver, compares its WGSL, declaration, and reflection output with
checked-in snapshots, and uses reviewed local inventory and semantic responses to exercise nominal
authentication, selection, finalization, assembly, render linking, compiler projection, and request
snapshots with zero worker launches. The interface JSON is an expected-value oracle for that local
semantic response, not a direct compiler-request input. The static gate does not require native
tools:

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

The recorded run used Apple M4 Pro. It performed nine one-shot Tint worker processes: one inventory,
two byte-identical semantic extractions, four successful translations, and two byte-identical runs of
one structured negative. It also performed two AIR compilations, one metallib link, and two
byte-identical runtime executions. This is not Intel, AMD, or cross-machine evidence. This canary
proves the resource-free assembly, translation, program-projection, and runtime path. It
authenticates one compiler result per selected stage and both offline compilation and runtime
function lookup consume only the frozen `{ stage, entryPoint, msl }` records retained by that
nominal projection. The sibling semantic-assembly gate proves fixed singular-resource allocation,
translation, exact program projection, offline linking, and one fixed direct-resource
binding/readback path. It also observes one exact-static override render without runtime
specialization. Broader resource runtime coverage, override-dependent compute execution,
repository-corpus integration, and production artifact packaging remain open.
