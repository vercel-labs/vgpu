# Metal integration release plan

Status: planning. MI0 through MI5 are open. The product direction is accepted; this document does
not mark the generated API, production tooling, or hardware matrix as implemented or verified.
See [scope and responsibilities](./README.md) before taking work from the earlier runtime roadmap.

## Release outcome

A developer installs the released build tooling, compiles their WGSL modules, adds the generated
Swift package to an otherwise ordinary Metal application, and uses typed shader functions and
bindings. The application creates all pipelines, resources, encoders, and submissions. It launches
without Node.js, Tint, Xcode, WGSL, or generated MSL in its application bundle.

Target Apple silicon with a macOS 14 deployment floor first. This is an intended support boundary,
not an already passing matrix. Determine the exact build-host and Swift/Xcode floors experimentally.
Do not block this release on Intel GPU testing, Windows, or Vulkan; do not advertise those as supported.

## MI0 — Validate the generated API through documentation

Deliver short, complete examples for:

- WGSL with an import and a typed uniform, loaded into an application-owned render pipeline;
- a vertex/fragment program with a caller-owned vertex buffer and two color outputs;
- compute with caller-owned storage buffers and explicit offset/length;
- use of the generated packing and binding information without the normal encoder convenience.

Show which lines are generated, which are Metal, and which are application code. Define resource
ownership, retained versus borrowed objects, writable CPU ranges, errors, and unsupported features.
The release profile must list supported shader inputs rather than imply all WGSL or all Metal.

Exit: the examples form one coherent API proposal, the three decisions in the scope document have
either evidence-backed choices or explicit user review, and no example depends on a vgpu renderer.
Names are not frozen until MI1 can compile and execute the proposal.

## MI1 — Prove a direct Metal consumer

Build one small generated package and an external SwiftPM consumer using the proposed API. Start
with a uniform-driven render, then a storage compute program. Use actual resolved WGSL, the pinned
worker, and Apple's offline compiler; no handwritten MSL standing in for generated shaders.

The consumer creates its own `MTLDevice`, pipelines, buffers/textures, encoders, and command buffers.
Include nonzero buffer offsets and a runtime-array range so the binding design encounters real
compiler metadata before it freezes. Load functions without exposing physical package paths or
requiring the consumer to know emitted MSL function names.

Exit:

- an unrelated clean project can relocate and consume the package without experimental renderer
  products or experimental runtime handles;
- its render pixels and compute bytes match declared oracles in repeated native processes;
- after generation, Swift build and execution do not invoke Node.js, Tint, `metal`, or `metallib`;
- invalid library bytes, incompatible metadata, and invalid binding inputs fail clearly;
- generated helpers create no command queue, pipeline, submission, or persistent GPU allocation.

Keep this proof narrow. Its success validates the seam; it does not complete production tooling.

## MI2 — Productize the compiler and package generator

Promote the reusable resolver, semantic bridge, exact worker protocol, and offline compilation into
maintained production modules. Implement the minimum command surface: `native doctor`, `native check`,
`native build`, and `native verify` (spellings remain subject to MI0).

Builds pin compiler inputs and validate configuration, selected entry points, overrides, features,
layouts, and interface links. Diagnostics preserve honest source provenance: do not invent authored
line/column locations when only a resolved-source range is available.

Generate Swift, library resources, and minimal compatibility metadata as one coherent output.
On failure or interruption, preserve the last valid package; never leave new Swift beside an old
library. The publication guarantee is part of the contract, not a premature requirement for one
filesystem-specific swap mechanism. Generated output ownership must prevent overwriting user files.

Exit:

- the real shipped worker processes the repository shader corpus and declared canaries, with
  supported programs compiling offline and unsupported cases matching explicit diagnostics;
- the generator is not fixture-specific and validates names, collisions, multiple programs, and
  multiple independent generated packages in the same app;
- normalized Swift and metadata are deterministic for the same inputs; library hashes verify
  integrity, not an unsupported byte-reproducibility claim across Apple compiler versions;
- interruption, compiler failure, paths with spaces, relocation, and clean rebuild tests pass;
- MI1 runs through production commands and modules, not the spike assembler.

Watch mode, sophisticated incremental caching, an Xcode build plugin, and a public compare runner
can follow later. Pixel/buffer comparison remains a required test even without a `native compare` CLI.

## MI3 — Verify packing, bindings, and native composition

Run generated-code conformance against reflected WGSL semantics and existing WebGPU oracles:

- scalars, `vec3`, matrices, fixed arrays, explicit alignment/size, supported f16 values, and
  runtime-array prefixes; no copying Swift structs using their native memory layout;
- strict counts, ranges, alignment, access and device validation before mutating destination bytes
  or encoding a partially validated binding set;
- singular textures/samplers and fixed/runtime storage, including nonzero offsets, larger backing
  allocations, rebinding, and multiple program stages;
- correct effective immediate-data payloads, including stages without a size region and stages
  sharing ordinary internal roles and a sparse storage-size table in one slot; size words come from
  visible ranges, while other state-dependent roles take explicit caller inputs;
- disjoint application vertex streams and shader/internal buffers, including pipeline switches.

Use ordinary Metal consumers to exercise a procedural and a vertex-buffer draw, dense and sparse
MRT, compute-to-render ordering, and native code before and after a generated shader in a shared
submission. Compare pixels/bytes; compilation alone does not establish correct binding or output.

Add one bounded native indirect-command-buffer example using supported pipeline/resource settings
to verify the low-level escape path. It is not a port of TypeScript render-bundle semantics or a
promise that every generated convenience supports every ICB operation. Record the tested subset
and reject unsupported combinations without hiding compiler-private data requirements.

Exit: all cases in the declared profile pass against the production-generated package. The app
uses native resources directly, with no mandatory CPU readback between GPU stages. Generated
loading and binding errors are distinguished from application-owned Metal completion errors.
The samples document retention until GPU completion and safe CPU writes; arbitrary external aliases,
unretained command buffers, and cross-queue synchronization are not implicitly validated by vgpu.

## MI4 — Validate distribution and compatibility

Distribute build tooling through npm and a prebuilt vgpu-owned Tint worker. Consumers must not have
to build Dawn. Publish authenticated version/pin information, checksums and the actual dependency
license notices. Validate the final signed distribution, not only the unsigned experimental build.
Test the chosen signing/notarization and packaging route with normal macOS security settings.

The generated package contains Swift source and its compiled Metal resource. MI0 decides whether a
small shared Swift support package is needed; if so, provide a resolvable Git URL, version tags, and
a tested compatible dependency range. Do not publish the former rendering products just to satisfy
the old package graph. Define separate versions for generated API/metadata compatibility and tool
releases; test upgrades instead of requiring exact release-version equality everywhere.

Exit:

- cold installation from candidate npm tarballs and any candidate Swift tags needs no repository
  checkout, local path dependencies, preexisting compiler cache, or manual security bypass;
- record build-host minimum, Swift tools/language version, Xcode/Metal compiler versions, application
  deployment target, and physical GPU execution coverage as separate matrix entries;
- on the minimum and current supported toolchains, generate, compile, link, and execute real samples;
  also consume an artifact from the newest generator/toolchain on the minimum supported consumer;
- unsupported or corrupted formats/models fail before use, with actionable upgrade diagnostics;
- inspect the final app for unwanted renderer modules, WebGPU runtime, translator, WGSL/MSL, and
  developer paths; record package/download/binary sizes without inventing an unmeasured budget;
- launch the built sample on a clean supported machine without Node.js, Tint, or Xcode installed.

An `x86_64` cross-build can remain additional portability evidence, not Intel GPU support. CI must
not silently skip the real-Metal gates and still report the supported release as passing.

## MI5 — Rehearse and publish the supported release

Replace the public runtime-first quickstart and guides with the direct Metal API proven above.
Every Swift example intended to compile becomes a consumer fixture. Document installation,
regeneration, native MRT/compute examples, ownership, diagnostics, known limits, and upgrades.
Clearly separate historical runtime proposals from the product being released.

Install the exact release candidate as an external consumer. Generate a package, relocate it,
build a signed sample, and run it on the declared supported matrix. Re-run compiler, binding,
integrity, compatibility, and native-composition gates against those exact deliverables.

Exit: MI0–MI4 pass, the release rehearsal is repeatable, documentation matches the shipped API,
and no advertised feature depends on an experimental runtime or an unrun hardware gate. A prerelease
may gather feedback, but it is not a substitute for these production exit conditions. Publication
of npm packages, Git tags, and releases is a separate authorized action after the candidate passes.

## Work order and immediate next step

1. Finish MI0 examples, then build the smallest MI1 consumer. This is the next implementation task.
2. Once the seam is validated, run production compiler/tooling work (MI2) and Swift integration
   conformance (MI3) in parallel against the same versioned fixtures.
3. Prepare packaging and CI early; close MI4 only with the real MI2/MI3 deliverables.
4. Rewrite the full public guides and execute MI5 against the actual candidate.

Do not resume the old R1/R2/D1/L1 renderer roadmap as a prerequisite. Preserve its experiments and
run any relevant old oracle as a regression, but do not build new public runtime features in this plan.

## Distribution references

- [Apple: publishing a Swift package](https://developer.apple.com/documentation/xcode/publishing-a-swift-package-with-xcode)
- [Apple: notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple: CPU-encoded indirect command buffers](https://developer.apple.com/documentation/Metal/encoding-indirect-command-buffers-on-the-cpu)
