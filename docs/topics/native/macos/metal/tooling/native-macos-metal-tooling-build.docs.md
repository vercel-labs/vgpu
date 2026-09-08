---
title: Build and verify a Metal package
summary: Check the native toolchain, validate shaders, regenerate an owned Swift package, and detect stale or modified output.
websitePath: /native/macos/metal/tooling/build
keywords: native, macos, metal, swift, doctor, check, build, verify, output, integrity
---

# Build and verify a Metal package

Native tooling runs on the machine that generates the shaders. The Swift application consumes the
resulting package without running Node.js or translating WGSL at launch.

> Warning: This is a docs-first workflow contract. The four-command grammar, help, and lazy companion
> dispatch are implemented, but the operational companion and complete installed workflow are not
> published yet. Native consumers currently test the internal compiler adapter and generated package
> directly; that evidence does not establish command installation, output publication, or release support.

## Prepare the build machine

The intended installation keeps build tooling in development dependencies:

```sh
npm install --save-dev vgpu @vgpu/native
npx vgpu native doctor
```

`doctor` checks the supported Node version, selected Xcode/SDK and Swift tools, the authenticated
vgpu-owned Tint worker, and Apple's Metal compiler. It compiles and links a small Metal probe;
finding `xcrun` is not enough to prove that the downloadable Metal compiler component works.

The command needs no project configuration and writes no project output. It may use temporary
files for its probe, which it cleans up. It does not install components, change the selected Xcode,
download an unpinned compiler, or bypass macOS security settings. Missing prerequisites produce
a failing exit status with an actionable diagnostic.

A successful toolchain probe is not GPU execution coverage. Real shader tests and the release's
physical-device matrix remain separate checks.

See [Check the native toolchain](/native/macos/metal/tooling/doctor) for the findings, selected-Xcode
behavior, and diagnostic boundaries.

## Validate before generating

After [configuring a package](/native/macos/metal/tooling/configuration), run:

```sh
npx vgpu native check
```

`check` reads the configuration and resolved WGSL inputs, validates selected stages and supported
resource layouts, and runs the pinned semantic and Metal-translation boundary. It stops before
Apple's offline compiler and does not write the configured output.

Each invocation captures the configuration and complete imported source graph once. Validation
uses that captured input even if an editor changes a file while the compiler is running. A check
does not inspect, create, or repair the output directory; checking a project with no generated
package is valid.

The check uses the same supported compiler profile as `build`. It does not retry a rejected shader
with extra language features or infer missing application state. Reported locations distinguish
resolved WGSL from authored source; the tool does not invent an original line number when no mapping
is available.

## Generate the package

```sh
npx vgpu native build
```

The build validates the inputs, translates every selected stage, compiles and links the Metal
library, and generates the Swift package. It completes a sibling staging directory before
publishing it to the configured output.

The library, generated Swift, and ownership record come from the same captured project. Editing
a shader during compilation does not splice newer source into part of that package. A later
verification can report the captured generation as stale against those edits.

The build captures its selected tool environment before awaiting project work. Relative
`DEVELOPER_DIR` and `TMPDIR` selections keep their meaning from that invocation's working directory;
changing the process environment later does not switch the Apple compiler halfway through the build.
These host settings are not copied into the generated package or its logical input fingerprint.

A failed program, cancelled build before publication, or rejected output boundary leaves the last
valid package unchanged. Publishing replaces the directory as one operation: the output path names
a complete old or new package, never a partially written package. If the destination filesystem
cannot provide the required operation, the build fails without replacing the package.

Finish generation before starting a Swift build, and do not edit generated output concurrently.
Cancellation after the commit point may leave the complete new package in place. The diagnostic
must retain that publication outcome, including when cleanup fails or an interrupted helper leaves
the outcome unknown.

See [Publish generated packages](/native/macos/metal/tooling/publication) for safe parent creation,
physical-directory locking, atomic replacement, and recovery. These operations do not silently
discard unrelated files or interrupted transactions.

Add the generated package to your Swift project and use its functions, packers, and bindings.
The application still creates its pipelines, buffers, textures, encoders, and submissions. A build
does not launch the application or prove that its native pipeline state is compatible.

## Verify an existing package

```sh
npx vgpu native verify
```

`verify` checks the ownership record, supported artifact format, generated file set and hashes,
and whether the current configuration and resolved source inputs match the recorded logical build
inputs. It does not regenerate output or invoke Tint, `metal`, or `metallib`.

Verification first captures the current project inputs, then checks the existing package's owner
and integrity, and finally compares its recorded fingerprint with the captured inputs. A package
can be intact and owned by the project but still stale. That result is a failure with a request to
build again, not permission to modify the record or a claim that verification generated anything.

Before inspecting the package, verification checks the original output path components as described
in [Configure a Metal package](/native/macos/metal/tooling/configuration). A symlink hidden by `..`
is an invalid destination, even when a package at the simplified path would be intact. This path
check does not reopen captured shader inputs; freshness still uses the one captured graph.

The hidden `.vgpu-native-output.json` record belongs to the tool. It identifies the artifact format,
owning configuration relative to the package, logical input fingerprint, and exact generated file
hashes. Ownership does not change when you edit a shader: an unchanged old package can be replaced
by its owning configuration even when its input fingerprint is stale. Do not edit the record to
bypass a conflict. It is integrity metadata, not a signature or an application runtime dependency.
The record is versioned UTF-8 JSON no larger than 64 KiB; unsupported or malformed records fail
validation before their file list is used.

Changing an imported helper makes the output stale even if its entry file did not change. Editing
generated Swift, replacing the library, removing a generated file, or adding an unexpected file
also fails verification. The initial policy treats this directory as an immutable generated
package: build it as a dependency of your consuming Swift project, whose build products live
outside this directory. A `.build` directory created by building the generated package directly
is still an unexpected addition; the tool reports it instead of deleting it.

The package must contain ordinary directories and regular, unlinked files. Symbolic links,
hard-linked files, special files, and unexpected empty directories fail verification too. The
verifier reads the limited ownership record before using its file list, then hashes payloads in
small chunks. Cancelling stops the inspection without changing the package. Verification is a
read-only observation, not a lock or permission to replace the directory: builds must repeat the
ownership checks inside their publication boundary.

Hash checks detect mismatches. They are not a signature proving who authored a package, and a
library hash does not promise byte-identical Apple compiler output across toolchain versions.
Verification also does not execute shaders or validate the application's resource contents.

Commit the generated package when another build machine must consume it without Node.js or the
Metal compiler. Regenerate it intentionally when changing shaders or compiler versions, and review
the generated diff together with the source change.

## Use the commands in automation

Run `vgpu native` or `vgpu native --help` to list the four commands. Each command accepts `--help`
or `-h`. Help does not load the native companion package, inspect a project, or require a working
Metal toolchain.

The `vgpu` command loads the optional `@vgpu/native` companion only for a valid native operation.
An absent or incompatible companion fails with an installation or compatibility diagnostic.
Other vgpu commands do not load it. Native execution uses the supported Node 22 build-host profile;
displaying help does not enforce that toolchain profile.

Project commands accept one `--config <file>`; use the same file for `check`, `build`, and `verify`.
Relative config arguments are resolved from the invocation's working directory. Omitting the
option selects `vgpu.native.json` in that directory, without searching ancestors. `doctor` does
not accept `--config`.

Unknown commands or options, repeated `--config`, missing values, and positional arguments are
usage errors, including when combined with `--help`. The initial commands have no `--target`,
`--json`, `--force`, or custom-worker option.

A successful command exits `0`. Usage errors exit `2`; missing prerequisites, unsupported shaders,
stale output, and verification failures exit `1`. An interrupted invocation waits for its cleanup
and exits `130` for SIGINT or `143` for SIGTERM. A post-publication interruption still reports that
the new package was published; it does not imply that the old package remains in place.

The initial command surface is deliberately four operations. Watching files, scaffold generation,
pixel-comparison commands, editor plugins, and automated publication are separate integrations.
The native test suite still compares real GPU results even without a public comparison command.
