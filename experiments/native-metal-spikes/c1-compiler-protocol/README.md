# C1 compiler protocol

This spike turns the earlier resolver, Tint, and Metal binding experiments into one versioned
translation boundary. It asks whether a caller can submit one fully resolved WGSL entry point and
receive enough trustworthy data to build a native shader artifact without exposing Tint-specific
objects to the rest of the toolchain.

## Result

Yes, for the covered one-shot compiler boundary. The candidate protocol owns its JSON schema, the
Node caller validates requests before launch, and the C++ worker independently decodes the complete
typed request before Tint runs. It derives resource kinds from Tint Inspector, applies the
vgpu-owned Metal slot mapping, and returns either a structured compiler failure or MSL plus the
effective binding metadata.

The full gate passes seven positive and fourteen negative native canaries. Every native case is run
twice, for 21 deterministic cases, and produces byte-identical status and output. A separate codec
gate covers 25 fatal framing/complexity faults, eleven decoded protocol failures, the 64/65 nesting
boundary, fragmented UTF-8, EOF blocking, pipe backpressure, cancellation, timeout, a known SHA-256
vector, and rejection at 128 MiB plus one byte. The covered compiler cases include:

- a resolver-to-compiler request made entirely from relocatable virtual paths;
- module-attributed WGSL diagnostics without invented authored line or column positions;
- exact active override sets whose `bool`, `i32`, `u32`, `f16`, and `f32` values are observable in
  emitted MSL and resolved workgroup dimensions;
- independent Metal buffer, texture, and sampler namespaces;
- one sampled texture binding array as translator evidence;
- runtime storage-array sizes through the shared immediate-data binding at `buffer(30)`;
- concrete emitted `[[buffer]]`, `[[texture]]`, and `[[sampler]]` indices; and
- fail-closed checks for stage, feature, override, binding, and emitted-name mismatches.

This is a protocol and semantic-feasibility result, not a distributable compiler. The native gate
still uses the verified arm64 Dawn release archive and its monolithic `libwebgpu_dawn.a`.

## Boundary

[`contracts/request-v1.schema.json`](./contracts/request-v1.schema.json) describes exactly one
resolved source and one selected entry point. Its variable inputs are:

- resolved WGSL text, a virtual path, and its SHA-256;
- a module-precision origin map;
- WGSL and emitted Metal entry names plus the selected stage;
- the exact, typed set of active overrides after upstream default materialization;
- an explicit allowlist of WGSL language features; and
- one direct Metal component interval for every reflected WGSL resource binding.

The v1 Metal writer profile is deliberately fixed. Every request carries the candidate
`immediate-data` reservation at Metal buffer index `30` and storage-size byte offset `4`. This
configures Tint; it does not assert that the generated entry point uses the binding. The success
response reports the internal binding and size region only when they are effective.

[`contracts/response-v1.schema.json`](./contracts/response-v1.schema.json) separates expected
compiler failures from successes. Both include the compiler and exact upstream revision. A success
contains MSL, the selected entry point, the unchanged external slot map, effective internal
bindings, storage-size regions, and resolved workgroup dimensions for compute entries. It does not
duplicate broad semantic reflection that belongs upstream of translation.

The worker transport carries one UTF-8 JSON request on stdin and uses EOF as its only frame. It is
therefore deliberately one process per request. A decoded JSON request produces exactly one UTF-8
JSON response and exits `0`, whether `ok` is `true` or `false`. Empty input, malformed JSON, invalid
UTF-8, duplicate keys, a second value, excessive depth or complexity, and an oversized frame exit
`65` with empty stdout. Invalid argv exits `64`, a caught worker-internal transport failure exits
`70`, and I/O failure exits `74`. A signal is also fatal. The caller discards every stdout byte
unless exit is `0` and the channel contains exactly one schema-valid response. These exit values are
an experimental process convention, not a portable protocol ABI. The gate directly covers the
usage (`64`) and framing (`65`) exits; the internal (`70`) and I/O (`74`) branches are not
fault-injected yet.

JsonCpp is configured fail-closed for comments, trailing commas, duplicate keys, extra values,
single quotes, special floats, BOMs, and a bounded stack. JsonCpp does not itself guarantee strict
raw UTF-8, strict JSON numbers, or valid UTF-16 surrogate escapes, so a bounded lexical preflight
checks those properties and limits allocation units before the parser allocates its DOM. This is
lexical validation, not a second JSON parser. A representable JSON scalar or array that passes
those framing policies is still a decoded request and therefore returns a structured protocol
failure instead of being misclassified as broken framing.

The experimental resource policy is 128 MiB for the stdin frame, 64 JSON containers, 262,144 JSON
allocation units, 16 MiB of decoded UTF-8 source, 64 MiB of decoded UTF-8 MSL, 160 MiB of captured
stdout, and 64 KiB of captured stderr. Diagnostics are limited to 16 KiB per message and 1 MiB of
message text in aggregate. Origin sources and overrides are limited to 4,096 entries each, origin
segments and bindings to 65,536 each, and language features to the four supported values. These
numbers are feasibility policy to measure against a real corpus, not frozen v1 ABI. JSON Schema's
`source.text.maxLength` counts Unicode code points; the worker adds the stricter 16 MiB UTF-8 byte
limit for memory control. One allocation unit means one JSON value or one object-member name; the
Node caller computes that same recursive metric from its typed value, while the C++ lexical pass
counts it before constructing the DOM. Boundary canaries require 262,144 to reach the decoder and
262,145 to fail framing with empty stdout.

## Diagnostics and virtual sources

[`lib/virtual-resolver.mjs`](./lib/virtual-resolver.mjs) wraps the existing `@vgpu/wgsl` resolver
with an in-memory, POSIX virtual filesystem. It rejects absolute paths, traversal, case collisions,
ambiguous package prefixes, and generated-header spoofing. Its logical request hash is stable when
the same source graph moves between physical checkouts.

The current resolver output cannot support honest authored spans: its source map has no usable
mappings, and dead-code elimination and name mangling can move generated lines. The protocol
therefore preserves Tint's range in the resolved virtual source and adds only a proven authored
module identity when that range falls wholly inside one module segment. Gaps and cross-segment
ranges remain unattributed.

Virtual paths and logical input identities must already be NFC-normalized and cannot be absolute
host paths. NFC remains an explicit caller precondition in this spike: the Node caller rejects NFD,
but the standalone C++ worker has no Unicode normalization dependency and does not prove NFC. It
does independently validate strict UTF-8 and every other path constraint. Origin segments are
canonical, non-overlapping UTF-8 byte intervals: a boundary cannot split a code point, and adjacent
segments with the same origin must be merged. Canonically ordered strings use ascending UTF-16
code-unit order; a non-BMP/BMP canary verifies that the C++ comparator agrees with JavaScript.

## Compiler prototype

[`prototype/main.cc`](./prototype/main.cc) exercises the direct Tint API used by this contract.
[`prototype/json-codec.cc`](./prototype/json-codec.cc) owns stdin framing, strict lexical checks,
SHA-256 verification, JsonCpp configuration, exact object shapes, and typed decoding. The Node side
is only the schema/semantic-validating caller. Its raw invocation helper is named accordingly, and
`decodeTintWorkerResponse` rejects any nonzero exit, signal, stderr, invalid JSON, or response that
does not pass the supplied schema validator before returning a value. There are no temporary WGSL
or mapping files and no typed CLI adaptation. The C++ process independently rejects unknown fields,
crossed hashes and origin maps, noncanonical collection order, unsafe slot intervals, duplicate
binding points, unsupported features, incoherent resource components, and emitted names outside
the `vgpu_` domain.

Compiler diagnostics are bounded to 16,384 UTF-8 bytes at a code-point boundary before JSON
serialization, with a 1 MiB aggregate message budget that preserves at least one error. Only the
WGSL parse and validation phase may attach a Tint source range; later phases cannot claim a
location they do not have.

The prototype does not call Tint's `GenerateBindings`. It obtains selected-entry resources and
override types from Inspector, builds `tint::Bindings` from the request, lowers WGSL to IR, and
checks the raised entry interface against the declared Metal intervals after generation. This
keeps the vgpu ABI authoritative on both sides of Tint.

One error response for the writer's `generate` phase is schema-only evidence. No stable source was
found that makes this pinned writer return a controlled generation failure; some invalid remapped
names trap inside Tint instead. The `vgpu_` preflight guard closes the known unsafe input without a
test-only compiler backdoor.

## Run

Build the existing WGSL package once so its resolver output is available, then run the platform-
independent contract and resolver gates:

```sh
pnpm --filter @vgpu/wgsl build
./experiments/native-metal-spikes/c1-compiler-protocol/run.sh
```

To compile the prototype and require every native canary, provide the official Dawn release and
exact supplemental-header overlay recorded by
[`c1-tint-standalone`](../c1-tint-standalone):

```sh
./experiments/native-metal-spikes/c1-compiler-protocol/run.sh \
  --release-root ../Dawn-8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca-macos-latest-Release \
  --compat-include ../tint-8f25-compat-include \
  --jsoncpp-root ../jsoncpp-1.9.8 \
  --require-tint
```

The equivalent environment variables are `C1_COMPILER_PROTOCOL_TINT_RELEASE_ROOT`,
`C1_COMPILER_PROTOCOL_TINT_COMPAT_INCLUDE`, `C1_COMPILER_PROTOCOL_JSONCPP_ROOT`, and
`C1_COMPILER_PROTOCOL_REQUIRE_TINT=1`. The JsonCpp root must be an exact checkout of official tag
`1.9.8` at commit `8519b8381f3c741ad1421f88237b1deda0b11412` and match its compiled-source
closure. The runner downloads and installs nothing. It verifies the Dawn 608-file include tree,
library, exact single-file supplemental header overlay, JsonCpp compiled-source closure, and
license. It compiles JsonCpp's
three official translation units directly, builds the worker twice with warnings as errors, and
requires identical executable hashes. The tracked provenance includes the official archive URL,
size and SHA-256 plus the selected MIT license text; source is not vendored. Distribution and
productization of that dependency remain a later decision.

## Scope and next gates

The sampled texture array proves that the protocol can carry a contiguous count and the pinned
writer can preserve it. It is not initial product support: the semantic API, runtime binding, and
offline Metal compiler have not validated binding arrays end to end. External textures are excluded
because their multi-component lowering needs a separate versioned shape.

Shader interface locations are also intentionally absent. WGSL `@location` values map to different
Metal namespaces depending on whether they describe vertex inputs, inter-stage values, or fragment
outputs. A later interface contract needs a discriminated representation rather than one ambiguous
integer projection.

The direct-build follow-up compiles these same worker sources against Dawn/Tint commit
`8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca`, declaring only `tint_api` as the link root. Independent
arm64 and x86_64 Release builds are byte-identical, combine into a deterministic universal
executable, and link no WebGPU implementation, runtime backend, or framework. The arm64 direct
workers run natively and the x86_64 direct workers run under Rosetta; every variant produces
responses byte-identical to this fixture's arm64-native monolithic oracle.

The remaining gates are:

- connect the proven override-default materializer and the broader semantic extractor to request
  construction;
- define the vertex-input, inter-stage, and fragment-output interface projection;
- validate generated MSL through Apple's offline compiler when that toolchain is available; and
- connect this compiler response to the deterministic Swift package artifact spike.

There is no Intel GPU result. Rosetta covers the x86_64 compiler executable path, but it cannot
establish Intel or AMD GPU behavior.
