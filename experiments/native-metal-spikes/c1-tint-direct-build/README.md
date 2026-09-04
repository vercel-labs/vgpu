# C1 direct Tint build

This spike asks whether the real compiler worker can be built from Tint's direct CMake targets for
both macOS architectures, without linking Dawn's WebGPU implementation, runtime backends, or
monolithic release library.

## Result

Yes, for the pinned source and toolchain profile. The worker declares only `tint_api` as its link
root. CMake resolves that root to 54 static archives: 44 Tint archives, nine Abseil archives, and
`dawn_shared_utils`. The final executables load only `libc++` and `libSystem`; they contain no Metal
framework, Dawn backend, WebGPU, SPIR-V, GLSL, HLSL, command-tool, or monolithic-library dependency.

Four clean Release builds passed: A and B for `arm64`, then A and B for `x86_64`. The independent
builds were byte-identical within each architecture. Combining each pair with `lipo` also produced
byte-identical universal executables.

| Output    |      Bytes | SHA-256                                                            |
| --------- | ---------: | ------------------------------------------------------------------ |
| arm64     |  5,747,504 | `ec5206089bc08c602af46ae4d329559647c37e9f622359f86b97cefe2a0d9ef3` |
| x86_64    |  6,795,880 | `c3ca7647b9ae54e434365042c6d87ff3760cb76c5f50b6d40ca549488327af71` |
| universal | 12,563,248 | `78fd48a856bbb50b57fd0c16d421f999f78dfd6c364665bfa9b2db623ab72382` |

The gate does not treat one of the new builds as its own oracle. It first compiles the same worker
against the previously verified monolithic release archive, then requires `noop`, `runtime-array`,
`wgsl-error`, and `generate-failure` to match that reference byte for byte across eight direct
variants: both thin A/B builds, both universal A/B builds, and each applicable arm64-native or
x86_64-Rosetta execution mode. The last request retains a historical fixture name; the real worker
successfully translates it, and all variants agree on that success. The monolithic executable is
reference-only: it is neither copied into `.artifacts` nor a candidate for distribution.

Before loading that oracle helper, the gate authenticates the helper and its local protocol module,
both provenance manifests it consumes, and the exact four-request closure. Each oracle response
must also match its locked byte count, SHA-256, and success state before any direct worker can use
it as a reference.

## Build boundary

[`CMakeLists.txt`](./CMakeLists.txt) accepts three source roots:

- a Dawn checkout at the exact locked commit and tree;
- a JsonCpp checkout at the exact locked commit and tree; and
- the neighboring real worker sources from `c1-compiler-protocol`.

The MSL writer and WGSL reader are enabled, while Dawn's Metal backend is disabled. Those are
different layers: Tint emits MSL text without creating a Metal device or linking a Metal framework.
Every other writer, reader, runtime backend, test, benchmark, fuzzer, sample, command-line tool,
Node binding, install surface, and monolithic target is disabled.

The direct target must be compiled inside Dawn's source graph. Dawn does not install or export this
complete Tint target closure, so collecting loose `libtint_*.a` files would recreate dependency
ordering and transitive-link behavior outside its owner.

`TINT_ENABLE_IR_VALIDATION_ASSERTS` remains off in this distribution profile. The current worker
also leaves `Module.enable_validation_asserts` off when it lowers a program, so changing only the
build feature would not enable the intended checks. Enabling both belongs in a separate compiler
hardening experiment.

## Reproduce

The runner never downloads, installs, fetches, or mutates dependencies. Prepare the locked inputs
out of band, then pass their paths explicitly:

```bash
bash experiments/native-metal-spikes/c1-tint-direct-build/run.sh \
  --dawn-root .context/native-spikes/dawn-8f25-source \
  --jsoncpp-root .context/native-spikes/jsoncpp-1.9.8 \
  --release-root .context/native-spikes/c1-tint-standalone/extracted/Dawn-8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca-macos-latest-Release \
  --compat-include .context/native-spikes/c1-tint-standalone/wrapper-prototype/include \
  --sdk-root /Library/Developer/CommandLineTools/SDKs/MacOSX14.5.sdk \
  --cmake .context/native-spikes/c1-tint-direct-build/tools/bin/cmake \
  --ninja .context/native-spikes/c1-tint-direct-build/tools/bin/ninja \
  --python /usr/bin/python3 \
  --jobs 8
```

The accepted profile is CMake 3.31.6, Ninja 1.13.2, Python 3.9.6, Apple Clang 17.0.0 build
1700.6.3.2, C++20, the macOS 14.5 SDK, and a `14.0` deployment target. The direct workers therefore
target macOS 14 even though this complete gate currently requires an arm64 macOS 26 host: the
reference release itself has a macOS 26 minimum. The host must also run x86_64 code through Rosetta.
The runner checks the exact first version line for both Clang drivers and Python. Each CMake
invocation receives explicit SDK, compiler, Python, and deployment-target paths or values.

The gate verifies source commits and Git tree objects without running a broad `git status` that can
fetch missing blobs from a partial clone. Before executing CMake, it authenticates the checked-in
manifest and its exact 156-file configuration closure. The generated Ninja graph must then name
that same source set, the fixture `CMakeLists.txt`, and no external inputs outside the selected
CMake installation or build root. It also authenticates 920 compiled source/header files feeding
407 valid dependency objects. The compiled closure is 804 Dawn/Tint files, 97 Abseil files, 15
JsonCpp files, and four worker files. SPIRV-Headers contributes one `CMakeLists.txt` during
configuration and zero compiled headers or linked objects. The runner checks those closures again
after execution and before publication.

All source and build prefixes are normalized at compile time. The gate rejects a binary that
contains any of the physical Dawn, JsonCpp, worker, or build paths, so changing where the pinned
inputs are materialized neither changes the output nor discloses the local checkout location.

It also verifies the CMake cache, all compile commands, the five direct worker objects, the exact
order and hash of 54 static archives, Mach-O load commands, dynamic libraries, native/Rosetta
execution, rebuild hashes, and request/response bytes. It invalidates `.artifacts/` before beginning
a non-help invocation, so an interrupted or failed run cannot leave an older PASS visible. On
success it writes the three binaries, `observed.json`, and the Dawn/Tint, Abseil, and JsonCpp license
notices to a sibling staging directory, then publishes the whole directory with one rename. Use
`--keep-builds` to retain all four temporary build trees for inspection.

[`provenance/source-lock.json`](./provenance/source-lock.json) is the source-of-truth lock. Dawn's
Chromium Abseil checkout is part of the static link. SPIRV-Headers is required by Dawn's CMake
configuration but contributes no linked object to this profile. SPIRV-Tools is recorded only as an
excluded DEPS pin because SPIR-V validation, readers, writers, and built DXC are all disabled.
JsonCpp reuses the compiler-protocol spike's exact source-closure and license provenance.

## Scope

This proves a source-build and process-execution route, not a final distribution artifact or a
stable upstream ABI. The measured hashes establish repeatability only for the pinned source,
toolchain, SDK, and host. The executables are Release builds but are not size-optimized or stripped.

The monolithic release is deliberately retained only as a behavioral oracle. Its larger WebGPU and
framework closure says nothing about the dependency closure of the direct binaries that this spike
would distribute.

Rosetta validates the x86_64 compiler process and byte parity. It does not test an Intel or AMD GPU.
Likewise, the worker emits MSL text but does not ask Apple's offline compiler or a Metal device to
validate that text; those remain separate gates.
