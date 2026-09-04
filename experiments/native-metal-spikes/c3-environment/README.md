# C3 environment and toolchain spike

This spike checks whether a macOS host can exercise the candidate Swift package baseline before
the generated package and native runtime exist. It covers Swift tools 6.0, Swift language mode 6,
a macOS 14 deployment target, `arm64` and `x86_64` compilation, and the concurrency signatures
needed by the proposed runtime.

It also checks the real Metal compiler/linker path. Finding the `metal` launcher is insufficient on
recent Xcode releases because the separately downloadable Metal toolchain may still be absent.

## Run

```sh
bash experiments/native-metal-spikes/c3-environment/run.sh
```

The script creates all build products in a temporary directory and removes them on exit. It does
not download or install anything. When the Metal toolchain is unavailable, the Swift checks still
run and the Metal compile/link canary is reported as skipped.

The negative isolation fixture is expected to fail compilation specifically because an
`@Sendable` error handler captures a non-`Sendable` mutable reference. The runner treats that
diagnostic as a passing assertion.

## Machine-specific snapshot

Observed on 2026-09-04. These values describe one machine and do not define the supported release
matrix:

| Property                     | Observed value                 |
| ---------------------------- | ------------------------------ |
| Host                         | Apple M4 Pro, `arm64`          |
| macOS                        | 26.6, build 25G72              |
| Xcode                        | 26.2, build 17C52              |
| Swift                        | 6.2.3 (`swiftlang-6.2.3.3.21`) |
| SwiftPM                      | 6.2.3                          |
| macOS SDK                    | 26.2, build 25C57              |
| Default Metal device         | Apple M4 Pro                   |
| Downloadable Metal toolchain | Build 17C7003j, installed      |
| Metal compiler               | 32023.864                      |

Only one Xcode installation was present. `xcodebuild -checkFirstLaunchStatus` exited successfully.

## Observed results

- The package manifest resolves Swift tools 6.0 and macOS 14.
- Release builds succeed for both `arm64-apple-macosx` and `x86_64-apple-macosx`.
- Both linked executables contain `LC_BUILD_VERSION` with `minos 14.0` and SDK 26.2.
- The native `arm64` executable runs and finds the Apple M4 Pro Metal device.
- The runner also executes the `x86_64` build when Rosetta is available. It passed on this host
  during the recorded probe. This demonstrates only
  process-architecture portability on Apple silicon; it does not validate an Intel CPU or an Intel
  or AMD GPU.
- Positive `@isolated(any) @Sendable`, actor-method-handler, `Sendable` submission, and
  `#isolation` fixtures type-check for `arm64` and `x86_64`.
- The negative non-`Sendable` capture is rejected as intended.
- A minimal submission token crosses into an actor, suspends, and resumes before actor-isolated
  state is updated.
- `xcodebuild -showComponent MetalToolchain -json` reported build 17C7003j as installed, and
  `xcrun metal --version` reported 32023.864.
- The Metal canary compiled for `air64-apple-macos14.0` with MSL 2.4 and linked into a nonempty
  `.metallib`.

## What this establishes

The proposed source-level baseline can be built by the observed current Swift toolchain for both
CPU architectures and can emit binaries whose minimum OS is macOS 14. It also validates the
intended Swift concurrency API shape and the offline Metal compile/link path on that toolchain.

The `x86_64` result is a useful cross-build gate, not evidence of Intel or AMD runtime support.
Likewise, recording `minos 14.0` proves linker intent, not successful execution on macOS 14.

## What remains for C3

This fixture does not yet establish:

- a minimum supported Xcode patch or compatibility across multiple Xcode releases;
- execution on a macOS 14 host;
- a generated package that builds and tests without Node.js after generation;
- `Bundle.module` loading of the generated `.metallib`;
- the real target/effect/bindings, offscreen submission, and readback path;
- ABI incompatibility failures before pipeline creation; or
- newest-generated-artifact compatibility with the oldest supported runtime.

Those assertions require the first generated runtime slice, additional Xcode installations, or
separate CI hosts. They should remain independent release gates rather than being inferred from
this machine snapshot.
