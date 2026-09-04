# C1 compiler protocol

This spike turns the earlier resolver, Tint, and Metal binding experiments into one versioned
translation boundary. It asks whether a caller can submit one fully resolved WGSL entry point and
receive enough trustworthy data to build a native shader artifact without exposing Tint-specific
objects to the rest of the toolchain.

## Result

Yes, for the covered compiler boundary. The candidate protocol owns its JSON schema, validates the
request before Tint runs, derives resource kinds from Tint Inspector, applies the vgpu-owned Metal
slot mapping, and returns either a structured compiler failure or MSL plus the effective binding
metadata.

The full gate passes seven positive and fourteen negative native canaries. Every native case is run
twice, for 21 deterministic cases, and produces byte-identical status and output. The covered cases
include:

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

The production worker transport should treat one decoded JSON response as a handled request and
reserve nonzero process exits for transport failure or a crash. The C++ prototype's `0`, `1`, and
`2` exits are only a convenient typed-CLI convention for this spike; the response's `ok` field is
the compiler outcome. This fixture validates the JSON envelopes and then adapts them to files and
typed arguments; it does not yet exercise the final stdin/EOF JSON codec in the C++ process.

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
host paths. Origin segments are canonical, non-overlapping UTF-8 byte intervals: a boundary cannot
split a code point, and adjacent segments with the same origin must be merged. Canonically ordered
strings use ascending UTF-16 code-unit order, matching RFC 8785 property ordering and remaining
implementable by non-JavaScript consumers.

## Compiler prototype

[`prototype/main.cc`](./prototype/main.cc) exercises the direct Tint API used by this contract. The
Node adapter owns JSON decoding and schema checks for the spike; the C++ process accepts typed
arguments and independently rejects unsafe slot intervals, duplicate binding points, unsupported
features, incoherent resource components, and emitted names outside the `vgpu_` domain.

Compiler diagnostics are bounded to 16,384 UTF-8 bytes at a code-point boundary before JSON
serialization. Only the WGSL parse and validation phase may attach a Tint source range; later
phases cannot claim a location they do not have.

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
  --require-tint
```

The equivalent environment variables are `C1_COMPILER_PROTOCOL_TINT_RELEASE_ROOT`,
`C1_COMPILER_PROTOCOL_TINT_COMPAT_INCLUDE`, and `C1_COMPILER_PROTOCOL_REQUIRE_TINT=1`. The runner
downloads and installs nothing. It verifies the 608-file include tree, library, and exact
single-file supplemental header overlay, builds the prototype twice with warnings as errors, and
requires identical executable hashes. It uses a temporary directory and removes all generated
inputs and binaries on exit. These hashes are feasibility provenance derived from the recorded
official archive; a production source build still needs its own complete manifest and reproducible
binary identity across clean machines.

## Scope and next gates

The sampled texture array proves that the protocol can carry a contiguous count and the pinned
writer can preserve it. It is not initial product support: the semantic API, runtime binding, and
offline Metal compiler have not validated binding arrays end to end. External textures are excluded
because their multi-component lowering needs a separate versioned shape.

Shader interface locations are also intentionally absent. WGSL `@location` values map to different
Metal namespaces depending on whether they describe vertex inputs, inter-stage values, or fragment
outputs. A later interface contract needs a discriminated representation rather than one ambiguous
integer projection.

The remaining gates are:

- extract and type-check evaluated WGSL override defaults before constructing this request;
- define the vertex-input, inter-stage, and fragment-output interface projection;
- implement and fault-test the final JSON stdin/EOF worker codec;
- build the wrapper from direct Tint targets for macOS 14 on arm64 and x86_64;
- validate generated MSL through Apple's offline compiler when that toolchain is available; and
- connect this compiler response to the deterministic Swift package artifact spike.

There is no Intel GPU result. Rosetta can later validate the x86_64 compiler executable path, but
it cannot establish Intel or AMD GPU behavior.
