# C3 artifact and SwiftPM spike

This spike splits the C3 artifact gate into two independently falsifiable parts:

- **C3a** assembles a deterministic generated Swift package around an intentionally invalid
  `.metallib` sentinel. It proves the artifact, compatibility, package dependency, resource, and
  clean-consumer boundaries without pretending that Metal accepted the payload.
- **C3b** replaces the sentinel with a real library built from `fixtures/noop.metal`, when Apple's
  optional Metal toolchain is already installed. It loads the packaged resource, creates a compute
  pipeline, dispatches four threads, and requires an exact `[0, 1, 2, 3]` readback.

The spike does not install or download anything and does not invoke Tint. The semantic and Metal
projection records are synthetic contract fixtures; they are not translator-provenance evidence.
In particular, `noop.metal` is a handwritten C3b canary outside the artifact's normal WGSL input
graph. It cannot establish a relationship between the recorded WGSL and MSL. Translation remains
a separate C1 gate.

## Run

```sh
bash experiments/native-metal-spikes/c3-artifact-swiftpm/run.sh
```

All generated packages, SwiftPM scratch directories, AIR, and Metal libraries live under a
temporary directory that is removed on exit. C3a must pass on the current host. C3b reports a skip
when the separately downloadable Metal toolchain is absent.

To make C3b mandatory without installing anything:

```sh
C3_REQUIRE_OFFLINE_METAL=1 \
  bash experiments/native-metal-spikes/c3-artifact-swiftpm/run.sh
```

If `metallib` is unavailable, this form exits with a stable failure after C3a passes. If the tools
are present but compilation, loading, pipeline creation, dispatch, or readback fails, both forms
fail rather than converting that failure into a skip.

## C3a assertions

The runner:

1. assembles the same tree twice and compares every byte;
2. compiles all five native JSON Schemas in strict mode, resolves their external references, and
   validates `artifact.json`;
3. recomputes input, file, semantic, program, build, runtime-projection, manifest, and payload
   hashes and checks every cross-reference;
4. verifies Swift tools 6.0, Swift language mode 6, macOS 14, the single `VGPUABI` package
   dependency, and the `AppShaders` target's single ABI product dependency;
5. tests the generated package for the native architecture, builds the generated package and clean
   consumer for both `arm64` and `x86_64`, then runs the native consumer and the `x86_64` consumer
   through Rosetta when available;
6. puts failing `node`, `npx`, `pnpm`, Tint, `metal`, and `metallib` shims first on `PATH` for every
   post-generation SwiftPM command and requires that no shim was invoked;
7. resolves exactly one `.metallib` through `Bundle.module`, checks its SHA-256, and confirms its
   bytes begin with `VGPU-C3-STRUCTURAL-SENTINEL-NOT-A-METALLIB`;
8. rejects the mutation matrix before a pipeline-factory closure runs, including ABI, model,
   fingerprint, and payload-hash mismatches; and
9. checks the generated package and clean consumer contain no WGSL, MSL, Metal source, AIR,
   JavaScript, translator executable, build directory, or package-resolution residue, and proves
   the package allowlist rejects an injected `.env` file.

The `vgpu-native-program/v1` fingerprint preimage is domain-separated and contains the referenced
WGSL input IDs and hashes, `layoutModel`, the semantic program without its fingerprint, Swift
presentation names, source spans, or redundant source list, and only the transitive type/layout
closure reachable from that program's bindings and interfaces. Capabilities remain in the program.
Arrays declared as unordered unique sets by the schema are sorted before hashing; semantically
ordered arrays retain their order. Executable self-checks require referenced WGSL, layout-model,
language-feature, directly reachable layout, and transitively reachable elemental-layout changes
to change the fingerprint, while an unreachable type/layout addition must not change it.

The sentinel deliberately has a `.metallib` filename so the same SwiftPM resource path is tested
in C3a and C3b. Its content is ordinary UTF-8 text and is never passed to Metal in C3a.

## C3b assertions

When `xcrun --find metallib` succeeds, the runner invokes Apple's tools with an explicit
`air64-apple-macos14.0` target and `-std=macos-metal2.4`, records their observable versions in the
temporary artifact, packages the resulting library, revalidates the artifact, and executes the
generated C3 Metal probe. The probe loads the exact `Bundle.module` URL and recorded SHA before it
creates `c3_noop` and dispatches.

The target spelling is a fixture-local hypothesis until this gate runs on the supported Xcode
matrix. To keep the payload deployment target consistent with the projection and Swift package,
this fixture rejects a `C3_METAL_TARGET` other than `air64-apple-macos14.0` before compilation.

## Decisions intentionally left open

This fixture uses relative path dependencies because all three packages are assembled as siblings;
it deliberately does not simulate remote package resolution. The public generated-package choice
is `upToNextMinor` during `0.x`, which limits source-compatibility drift while allowing compatible
patch releases. Integer ABI compatibility still does not replace Swift package versioning.

The C3 Metal probe is not the proposed compare runner and does not appear in `projection.testing`.
It exists only to exercise the packaged no-op library when C3b can run. The future packaging
decision remains whether production generation should always emit a real compare runner or emit it
only when compare testing is enabled; this fixture does not choose between those options.

Likewise, the generated resource resolver is fixture-local. It proves `Bundle.module` behavior but
does not freeze a public `Bundle`, URL, or resolver-closure API.

## What remains open

Passing this spike does not close C3. The full gate still needs a real generated artifact connected
to C1, the production `VGPUABI` and runtime, the supported Xcode/macOS matrix, newest-generator to
oldest-runtime consumption, and execution on the declared hardware matrix. A real compare runner
must implement the request/response schemas, prove that protocol incompatibility blocks compare
without blocking application use, and define its build fingerprint inputs, including the Swift
runner target triple. This C3 probe claims none of those properties.
