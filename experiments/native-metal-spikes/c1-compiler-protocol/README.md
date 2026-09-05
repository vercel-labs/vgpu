# C1 compiler protocol

This spike turns the earlier resolver, Tint, and Metal binding experiments into one versioned
translation boundary. It asks whether a caller can submit one fully resolved WGSL entry point and
receive enough trustworthy data to build a native shader artifact without exposing Tint-specific
objects to the rest of the toolchain.

## Result

Yes, for the covered one-shot compiler boundary. The candidate protocol owns its JSON schema, the
Node caller validates requests before launch, and the C++ worker independently decodes the complete
typed request before Tint runs. It derives resource kinds from Tint Inspector, applies the
vgpu-owned Metal slot mapping, compares the exact selected-entry shader interface before and after
Metal lowering, and returns either a structured compiler failure or MSL plus the minimal runtime
projection.

The full gate passes fifteen positive and twenty-two negative native canaries. Every native case is
run twice, for 37 deterministic cases, and produces byte-identical status and output. A separate codec
gate covers 29 fatal framing/complexity faults, nineteen decoded protocol failures, the 64/65 nesting
boundary, fragmented UTF-8, EOF blocking, pipe backpressure, cancellation, timeout, a known SHA-256
vector, and rejection at 128 MiB plus one byte. The covered compiler cases include:

- a resolver-to-compiler request made entirely from relocatable virtual paths;
- module-attributed WGSL diagnostics without invented authored line or column positions;
- exact static per-entry override sets whose `bool`, `i32`, `u32`, `f16`, and `f32` values are
  observable in emitted MSL and resolved workgroup dimensions;
- exact-static override materialization before entry pruning, including a bypassed invalid
  initializer and a required declaration used only by another entry point;
- independent Metal buffer, texture, and sampler namespaces;
- one sampled texture binding array as translator evidence;
- runtime storage-array sizes through the shared immediate-data binding at `buffer(30)`;
- exact sparse vertex attributes `3/7`, inter-stage locations `2/5/6`, fragment colors `1/4`, a
  direct scalar fragment input and unnamed return, and the core compute built-ins;
- effective interpolation defaults, explicit interpolation, built-ins, types, widths, and
  invariance before and after Metal `Raise()`;
- concrete emitted `[[buffer]]`, `[[texture]]`, and `[[sampler]]` indices; and
- fail-closed checks for stage, feature, override, binding, shader-interface, and emitted-name
  mismatches.

This fixture's native gate still uses the verified arm64 Dawn release archive and its monolithic
`libwebgpu_dawn.a`. The companion direct-source gate now covers this exact worker revision,
authenticated entry inventory, the semantic-interface handshake, and semantic extraction for fixed
singular resources and exact-static overrides. Its ordinary publication gate authenticates a
twenty-two-canary request closure, produces byte-reproducible arm64, x86_64, and universal
executables, and passes response parity with the arm64-native monolithic oracle across eight direct
variants. The x86_64 executions run through Rosetta and establish compiler-process behavior, not
Intel or AMD GPU support.

## Boundary

[`contracts/request-v1.schema.json`](./contracts/request-v1.schema.json) describes exactly one
resolved source and one selected entry point. Its variable inputs are:

- resolved WGSL text, a virtual path, and its SHA-256;
- a module-precision origin map;
- WGSL and emitted Metal entry names plus the selected stage;
- the exact flattened semantic interface, with resolved scalar/vector types and normalized
  interpolation but without artifact type IDs or source names;
- the exact, typed static per-entry override set after upstream default materialization;
- an explicit allowlist of WGSL language features; and
- one direct Metal component interval for every reflected WGSL resource binding.

The v1 Metal writer profile is deliberately fixed. Every request carries the candidate
`immediate-data` reservation at Metal buffer index `30` and storage-size byte offset `4`. This
configures Tint; it does not assert that the generated entry point uses the binding. The success
response reports the internal binding and size region only when they are effective.

[`contracts/response-v1.schema.json`](./contracts/response-v1.schema.json) separates expected
compiler failures from successes. Both include the compiler and exact upstream revision. A success
contains MSL, the selected entry point, the unchanged external slot map, effective internal
bindings, storage-size regions, resolved workgroup dimensions for compute entries, and a minimal
stage-discriminated Metal interface. Vertex responses contain only exact location-to-attribute
mappings, fragment responses only exact location/blend-source-to-color/index mappings, and compute
responses only their kind. Built-ins, inter-stage values, types, interpolation, and invariance are
not duplicated from the authoritative semantic request.

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
segments and bindings to 65,536 each, and language features to the five supported values. These
numbers are feasibility policy to measure against a real corpus, not frozen v1 ABI. Each shader
interface direction is limited to 64 flattened values; compute input is limited to its five
allowlisted built-ins and compute output is empty. JSON Schema's
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
[`prototype/override-materializer.h`](./prototype/override-materializer.h) owns exact-static
multi-entry materialization behind a transport-free API that accepts an already parsed
`tint::Program`. It returns typed entry subsets and their canonical program union without file I/O,
hashing, JSON, platform APIs, or Tint pointers in outward records.
[`prototype/json-codec.cc`](./prototype/json-codec.cc) owns stdin framing, strict lexical checks,
SHA-256 verification, JsonCpp configuration, exact object shapes, and typed decoding. The Node side
is only the schema/semantic-validating caller. Its raw invocation helper is named accordingly, and
`decodeTintWorkerResponse` rejects any nonzero exit, signal, stderr, invalid JSON, or response that
does not pass the supplied schema validator before returning a value. There are no temporary WGSL
or mapping files and no typed CLI adaptation. The C++ process independently rejects unknown fields,
crossed hashes and origin maps, negative-zero JSON numbers, noncanonical collection order, unsafe
slot intervals, duplicate binding points, unsupported features, incoherent resource components, and
emitted names outside the `vgpu_` domain.

Compiler diagnostics are bounded to 16,384 UTF-8 bytes at a code-point boundary before JSON
serialization, with a 1 MiB aggregate message budget that preserves at least one error. Only the
WGSL parse and validation phase may attach a Tint source range; later phases cannot claim a
location they do not have.

The prototype does not call Tint's `GenerateBindings`. It obtains selected-entry resources and
override types from Inspector, builds `tint::Bindings` from the request, lowers WGSL to IR, applies
`SingleEntryPoint` and exact override substitution, and then flattens the core-IR parameters and
return value. It compares that normalized interface exactly with the request before calling Metal
`Generate()`, preserving Tint's complete writer preflight. `Generate()` mutates the same IR through
Metal raise, so the worker can flatten the raised wrapper afterward, ignore only declared bound
resource parameters, require semantic equality with the pre-raise view, and validate the emitted
physical slot set. The minimal interface response map is derived from the raised view, not copied
from the request.

The emitted-slot check proves that the expected Metal resource-class/index/count set exists after
lowering; it does not independently recover each original `@group`/`@binding` identity from the
raised wrapper. That association relies on Tint's `BindingRemapper`, and the success response
reserializes the requested source-to-slot mapping. This is an explicit trust boundary rather than a
claim of identity reflection.

One error response for the writer's `generate` phase is schema-only evidence. No stable source was
found that makes this pinned writer's internal `CanGenerate` preflight return a controlled failure;
the structural source gate requires the official `Generate()` path and every successful native
canary traverses it. Some invalid remapped names trap inside Tint instead. The `vgpu_` preflight
guard closes the known unsafe input without a test-only compiler backdoor.

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

The shader-interface wire profile intentionally excludes source names and artifact type IDs. It
supports only scalar/vector leaves, the initial core built-in allowlist, normalized interpolation,
vertex-position invariance, and representable blend-source metadata. Clip distances, primitive and
linear invocation indices, subgroups, fragment depth-mode qualifiers, framebuffer fetch, and nested
I/O structures fail closed until their semantics and capability profiles are explicit.

The internal compiler protocol allowlists `dual_source_blending` and its native canary proves both
location-0 blend sources become Metal color 0 indices 0 and 1. This translator evidence does not
enable dual-source blending in the higher-level product alpha, whose capability policy continues to
reject it.

The direct-build follow-up now provides current source-build and compiler-process distribution
evidence for these same worker sources. Its accepted lock pins their complete source, authenticated
request and response closure, and binary hashes, while its ordinary publication gate reproduces all
eight direct variants.

The override integration follow-up now connects the materializer's exact static view to this
request, binds it to the resolved-source hash, and proves that missing, extra, or stale values fail
before or inside the independently validating worker.

The semantic-bridge follow-up now carries the authenticated fixed-size singular-resource union
through semantic assembly, nominal slot allocation, per-entry request projection, native
translation, and offline Metal linking. It preserves exact binding subsets and sampling pairs,
derives per-binding stage visibility, joins resolver-owned authored names, retains the reachable
type and layout graphs, and fingerprints those semantics. The slot map is derived only from that
authenticated graph and verified independently before the projector can use it.

The remaining gates are:

- carry extracted exact-static overrides through semantic assembly and projection;
- extend the connected bridge to runtime-sized and broader resource shapes, then run the full
  corpus through Apple's offline compiler; and
- connect this compiler response to the deterministic Swift package artifact spike.

There is no Intel GPU result. Rosetta covers the x86_64 compiler executable path, but it cannot
establish Intel or AMD GPU behavior.
