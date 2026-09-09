---
title: "Check the native toolchain"
description: "Diagnose the build host, selected Apple tools, pinned WGSL compiler, and offline Metal compilation without a shader project."
---

Before investigating a project shader, check that the machine can run the native build tools:

```sh
npx vgpu native doctor
```

> Warning: `vgpu native doctor` is implemented and exercised from real local package tarballs,
> installed offline with dependency install scripts disabled. It uses the packaged pinned worker
> and Apple's offline compiler. The companion remains private and unpublished; the project commands
> and complete installed build workflow remain unfinished. This does not qualify empty-cache
> installation, normal dependency install scripts, or a release compatibility matrix.

The command needs no `vgpu.native.json`, does not read project shaders, and writes no generated
package. It reports evidence and a suggested next action for each failed prerequisite.
The pinned compiler is a private asset of the optional native companion. Diagnosis does not search
the current directory or developer checkout for a worker, download one, or accept a worker override.

## Read the findings

The initial checks run in a fixed order:

| Check | What it establishes |
| --- | --- |
| Node | A stable Node.js 22 release is running, matching the current build-tooling profile. |
| Host | The build host is macOS; the report records the operating system and process architecture. |
| Xcode | A selected developer directory provides usable Xcode command-line tools. |
| SDK | The selected tools can identify the macOS SDK and its version. |
| Swift | The selected toolchain provides Swift 6 or newer, as required by the generated package manifest. |
| Tint | The authenticated pinned worker validates and translates a fixed WGSL probe. |
| Metal | Apple's compiler compiles and links a fixed kernel with the same Metal and deployment settings as package builds. |

Finding a tool's executable is not enough for the last two checks. Tint must answer the checked
compiler protocol, and Metal must produce a nonempty compiled library. These probes do not create
a render or compute pipeline, acquire a GPU, or run the application.

Each finding is successful, failed, or skipped because a prerequisite is unavailable. The overall
result is healthy only when every required check succeeds. A skipped check is not evidence of
support. A healthy result does not establish the release's build-host, Swift-consumer, or physical
GPU compatibility matrix; those require separate tests.

The human-readable report begins with `Native toolchain: healthy` or `Native toolchain: unhealthy`,
followed by one finding for each check in the order above. For example, its shape on a healthy host
is shown below; the actual evidence contains the detected versions, paths, and probe results:

```text
Native toolchain: healthy
[ok] node: ...
[ok] host: ...
[ok] xcode: ...
[ok] sdk: ...
[ok] swift: ...
[ok] tint: ...
[ok] metal: ...
```

Unsuccessful findings use `[fail]` or `[skip]`. Multiline evidence is indented beneath its finding;
a suggested remedy, when available, appears on an indented `Next:` line. The report goes to standard
output, including failed findings. Exit status is `0` only for a healthy report and `1` for an
unhealthy report or a failure that prevents diagnosis. Failures that prevent a report go to standard
error. Cancellation still waits for owned cleanup; the CLI preserves its signal exit statuses.

## Use the selected Apple tools

The diagnostic honors `DEVELOPER_DIR` when it is set; otherwise it uses the selected Xcode developer
directory. It keeps that selection consistent for the run without changing the machine's default.
See Apple's [command-line tools settings](https://developer.apple.com/documentation/xcode/configuring-command-line-tools-settings)
for selecting the intended Xcode installation.

An installed Xcode may still need its optional Metal Toolchain. The diagnostic reports that failure
and suggests installing the component yourself. Apple's
[component installation guide](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
describes the Xcode settings and command-line options.

The diagnostic never installs components, switches Xcode, accepts licenses, runs privileged repair
commands, downloads a different compiler, or bypasses macOS security settings.

## Keep probes bounded

Discovery commands have short deadlines and bounded output. Compiler probes also have deadlines;
a hung subprocess cannot leave the diagnostic waiting indefinitely. Cancelling stops further
probes and cleans up the temporary files owned by the run.

The diagnostic captures its temporary-directory selection when the invocation starts; a relative
`TMPDIR` belongs to that invocation's working directory. Both Tint and Apple probes keep that
captured context even if the process environment changes while diagnosis is running.

Temporary-file or cleanup failures are reported as failures, not a healthy result. The diagnostic
does not remove unrelated files or clean interrupted project builds. After the toolchain passes,
continue with [Build and verify a Metal package](/native/macos/metal/tooling/build).
