# C1 follow-up: standalone Tint

This fixture evaluates the distribution boundary left open by
[`c1-translators`](../c1-translators): can Tint run as a build-time WGSL-to-MSL compiler and return
structured metadata without creating a WebGPU device?

## Result

Yes. The recommended boundary is one vgpu-owned, statically linked executable built from an
immutable Dawn/Tint commit. A single request should parse WGSL, inspect its semantic types, apply a
versioned vgpu binding ABI, generate one selected entry point, and return MSL plus JSON metadata.

A feasibility wrapper built against an official Dawn release archive demonstrated that this path
can:

- select an entry point and choose its emitted MSL name;
- report stage, effective workgroup size, threadgroup storage, and stage resource usage;
- return the exact WGSL binding-to-Metal slot projection used by the writer;
- reflect intrinsic struct and array layout from Tint;
- compile vgpu's compact uniform layout and FFT `ptr<workgroup>` shaders;
- produce byte-identical MSL and JSON across repeated invocations.

The proof archive is **not distributable as the production compiler**. It is arm64, has a macOS 26
deployment target, and the prototype links its monolithic `libwebgpu_dawn.a`. Production requires a
source build with a macOS 14 deployment target, arm64 and x86_64 slices, direct Tint targets, and a
vgpu-owned binding map.

Do not use these as the production API:

- `webgpu@0.4.0`'s addon: Tint is embedded behind N-API and no supported Tint API is exported;
- `dump_shaders`: it is runtime diagnostic output;
- stock `tint` plus `tint_info`: they do not jointly expose emitted names and post-lowering Metal
  slots, and nearby releases have incompatible failure behavior.

## Evidence

The normalized observation is in [`snapshots/observed.json`](./snapshots/observed.json). Official
asset URLs and hashes are in [`provenance/releases.json`](./provenance/releases.json).

| Official Dawn commit                       | Resolved modules | Compiler invocations | Expected result                                        |
| ------------------------------------------ | ---------------: | -------------------: | ------------------------------------------------------ |
| `7d5e33062472c8ab700d40ed485ce868c4a58151` |              224 |                  287 | 223 valid modules pass; one intentional negative fails |
| `8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca` |              224 |                  287 | 223 valid modules pass; one intentional negative fails |

Multi-entry modules were compiled once per entry point. Library-only modules were parsed and
re-emitted as WGSL. The earlier release's `tint_info --json` traps with `TINT_UNREACHABLE`; the later
release works. This is why the wrapper should call Tint APIs and own its JSON schema instead of
orchestrating two stock CLIs.

The official assets remain useful as verifiable semantic evidence. The release close to the
runtime pin targets macOS 15; the later release used for the wrapper proof targets macOS 26. Neither
meets the macOS 14 distribution baseline.

## Layout contract

`uniform_buffer_standard_layout` is an environment language feature in Tint, not a source-level
`enable` directive. It must be explicit in the compiler request, cache key, and response
provenance. The wrapper must start with an allowlist and add
`wgsl::LanguageFeature::kUniformBufferStandardLayout` only when requested; it must not retry
silently after a validation failure.

With the feature disabled, [`uniform-standard-layout.wgsl`](./canaries/uniform-standard-layout.wgsl)
is rejected because the uniform array has stride 4 instead of 16. With it enabled, Tint reports:

```text
Params align=4 size=12
values offset=0 align=4 size=12 stride=4
```

That intrinsic Tint layout is the shader-side source of truth. vgpu's TypeScript packer currently
uses a hybrid policy and is not an oracle for Metal layout. Native and TypeScript packers must be
checked against the semantic offsets, alignments, sizes, and strides returned by Tint.

The intrinsic type layout is address-space neutral in the response. A binding records whether that
type is used as `uniform` or `storage`; Tint then validates the use-site constraints, including the
explicit uniform-layout feature. `bufferLayouts` must not imply that the same type acquires a
different intrinsic shape merely because of its binding address space.

See the proposed process boundary in [`examples/request.json`](./examples/request.json) and
[`examples/response.json`](./examples/response.json). These are design examples, not a frozen public
schema.

## Prototype boundary

[`prototype/main.cc`](./prototype/main.cc) proves direct parser, Inspector, IR, and MSL-writer use.
It deliberately uses `GenerateBindings` to observe Tint's current projection. That function is an
oracle for the spike only: its algorithm is not the vgpu ABI and must not become a cache or runtime
contract. Production constructs `tint::Bindings` from a versioned vgpu mapping and serializes the
same mapping in its response.

[`prototype/feature-gate.cc`](./prototype/feature-gate.cc) isolates the explicit
`uniform_buffer_standard_layout` decision and semantic layout reflection.

The official archive used for this proof omits one internal header required by its installed Tint
headers. The missing header was fetched from the exact release commit for local verification; its
official URL and hash are recorded in the provenance manifest. It is intentionally not vendored
here. A production source build does not have this packaging mismatch.

## Reproduce the stock-compiler canaries

Download and extract one of the official archives listed in `provenance/releases.json`, then pass
the extracted release directory to the runner:

```sh
node run.mjs --release-root ../Dawn-<commit>-macos-latest-Release
```

Optionally verify the archive itself as well:

```sh
node run.mjs \
  --release-root ../Dawn-<commit>-macos-latest-Release \
  --archive ../Dawn-<commit>-macos-latest-Release.tar.gz
```

The runner uses only Node built-ins, writes to ignored `.artifacts/`, never downloads or installs
anything, and never writes to the home directory. It verifies the official `tint` hash and, when
provided, the archive hash. It runs each canary twice and checks deterministic output.

Exit codes are explicit:

- `0`: all expected outcomes reproduced;
- `1`: hash mismatch or behavioral failure;
- `2`: unsupported host or missing prerequisite, reported as a skip.
- `64`: invalid runner invocation.

This runner exercises stock WGSL-to-MSL translation only. It does not build the wrapper and does
not validate MSL with Apple's offline compiler.

## Production build outline

Build a downstream executable from a pinned Dawn checkout with only these direct Tint targets:

```cmake
target_link_libraries(vgpu-tint-compiler PRIVATE
  tint_api
  tint_lang_core_ir
  tint_lang_core_type
  tint_lang_msl_writer
  tint_lang_wgsl_inspector
  tint_lang_wgsl_reader
)
```

`tint_api_helpers` may be linked in tests for comparison with `GenerateBindings`, but should be
omitted from production. The Tint targets carry their transitive `common`, `printer`, `raise`,
resolver, and `program_to_ir` dependencies.

Configure the source build with a canonical output name and at least:

```text
CMAKE_BUILD_TYPE=Release
CMAKE_OSX_DEPLOYMENT_TARGET=14.0
DAWN_BUILD_MONOLITHIC_LIBRARY=OFF
DAWN_BUILD_SAMPLES=OFF
DAWN_BUILD_TESTS=OFF
DAWN_ENABLE_METAL=OFF
TINT_BUILD_CMD_TOOLS=OFF
TINT_BUILD_TESTS=OFF
TINT_BUILD_WGSL_READER=ON
TINT_BUILD_WGSL_WRITER=OFF
TINT_BUILD_MSL_WRITER=ON
TINT_RANDOMIZE_HASHES=OFF
```

Build arm64 and x86_64 separately, test the x86_64 slice under Rosetta, and combine or package the
slices deterministically. Record the commit, flags, compiler version, artifact hashes, licenses,
and notices.

Tint's `--msl-version 2.4` controls its Apple validation invocation; it does not parameterize the
MSL writer. The MSL 2.4 contract closes only after compiling generated source with
`metal -std=macos-metal2.4`, producing AIR, and linking a metallib.

## Remaining gates

- Build the direct-target wrapper from source at the macOS 14 baseline.
- Replace `GenerateBindings` with the versioned vgpu ABI mapping.
- Return structured diagnostics and remap generated-source ranges through vgpu's resolver map.
- Validate the complete corpus through offline `metal` and `metallib` at MSL 2.4.
- Verify clean-build artifact determinism, arm64 execution, Rosetta x86_64 execution, and signing.
- Include Dawn/Tint's BSD-3-Clause license and all required notices in the distributed artifact.

There is no Intel hardware result. Rosetta can cover the x86_64 executable path, leaving a small
documented residual risk for initial simple shaders.

The remaining pin choice has no clear winner. `c5d549e250b9225744929ae860b369cb4304a767`
maximizes continuity with the runtime evidence; `7d5e330...` is the closest official standalone
release but has broken stock metadata tooling; a later release has better tooling but a larger
semantic delta. The provisional choice is `c5d549...` until the source-built wrapper passes every
gate above.

## Official sources

- [Dawn build documentation](https://dawn.googlesource.com/dawn/+/HEAD/docs/building.md)
- [Pinned CMake configuration](https://dawn.googlesource.com/dawn/+/c5d549e250b9225744929ae860b369cb4304a767/CMakeLists.txt)
- [Tint Inspector](https://dawn.googlesource.com/dawn/+/c5d549e250b9225744929ae860b369cb4304a767/src/tint/lang/wgsl/inspector/inspector.h)
- [MSL writer options](https://dawn.googlesource.com/dawn/+/c5d549e250b9225744929ae860b369cb4304a767/src/tint/lang/msl/writer/common/options.h)
- [MSL writer output](https://dawn.googlesource.com/dawn/+/c5d549e250b9225744929ae860b369cb4304a767/src/tint/lang/msl/writer/common/output.h)
- [Uniform layout validation](https://dawn.googlesource.com/dawn/+/c5d549e250b9225744929ae860b369cb4304a767/src/tint/lang/wgsl/resolver/validator.cc)
- [MSL 2.4 validation invocation](https://dawn.googlesource.com/dawn/+/c5d549e250b9225744929ae860b369cb4304a767/src/tint/lang/msl/validate/validate.cc)
- [BSD-3-Clause license](https://dawn.googlesource.com/dawn/+/c5d549e250b9225744929ae860b369cb4304a767/LICENSE)
