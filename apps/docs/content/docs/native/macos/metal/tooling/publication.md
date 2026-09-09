---
title: "Publish generated packages"
description: "Understand output ownership, atomic replacement, cancellation, and recovery when a Metal package is generated."
---

A generated package contains Swift code and a compiled library that must agree. The build prepares
them together, then replaces the output directory as one operation.

> Warning: This is the docs-first publication contract. Staging, missing and empty-destination
> publication, and bounded read-only reconciliation have native test coverage. The complete replacement
> workflow and operational build companion are not implemented yet. The command shim exists; this is not a
> released end-to-end build workflow.

## Reserve the destination

Keep handwritten files outside the configured output. The first build accepts a missing or empty
directory. Replacing a nonempty directory requires the owning configuration's unchanged package,
including its exact file set and integrity record. A stale input fingerprint does not remove that
ownership; modified or unexpected output does.

The package records a relative path back to its owning configuration. Ownership compares the
current configuration files, not their path spelling or contents. An accepted alias to the same
configuration, an earlier atomic save, or moving the project and package together does not by
itself transfer ownership. A different configuration with identical contents is still a different
owner. The old generated module name and fingerprint need not match the new generation.

The build checks the original output path and every captured source path before preparing to
publish. It must not overwrite its configuration, shaders, or their physical ancestors. See
[Configure a Metal package](/native/macos/metal/tooling/configuration) for path restrictions and
[Build and verify a Metal package](/native/macos/metal/tooling/build) for integrity checks.

After compilation succeeds, the build can create missing container directories such as `Generated`
in `Generated/AppShaders`. It checks components without following symbolic links. New container
directories are not generated package contents and remain in place if a later operation fails;
the build does not recursively remove their ancestors during cleanup.

## Prepare one generation

On macOS, publication uses a small filesystem helper compiled locally from the installed tool's
source with the selected Xcode C compiler. This helper is a build-time component, not part of the
generated Swift package or application. It needs no separate binary download or persistent cache.
Its compilation and execution can fail without replacing the package.

The helper holds a lock on the physical output parent while the build checks ownership, stages
the generation, publishes, and cleans up. Sibling outputs in the same parent also conflict.
Alternate spellings of that physical directory do not provide independent locks. A second build
reports the conflict instead of interleaving writes.

Output-adjacent writes stay relative to the opened directory, including staging, the recovery
record, and cleanup. Checking a path once and later reopening it by name would not provide that
boundary. If the parent changes, the tool does not follow its replacement to publish elsewhere.

A hidden parent-scoped recovery record identifies the transaction before staging is created.
Before replacement, it records the expected old and new directory identities and package records.
The staged generation must contain the complete checked file set; a directory name alone is not
proof that its contents are tool-owned.

The recovery record is separate from `.vgpu-native-output.json`, which remains inside each
generated package. Neither is an application runtime dependency or an author signature. An
unrecognized file occupying a reserved recovery name is a conflict, not a file to overwrite.

For an owned replacement, the helper opens the old package under the same physical parent lock
and reads its bounded integrity record before creating transaction state. The tool validates that
record and its configuration ownership, then the helper checks the old package's complete tree
and actual bytes through the retained directories. The new generation does not supply the old
module's paths, lengths, or hashes. Ownership and integrity are rechecked before exchange; old
package cleanup uses its own verified file set, with the recovery record removed last.

### Bound one transaction

Publication accepts exactly the four generated files described in
[Build and verify a Metal package](/native/macos/metal/tooling/build). Their combined raw byte size
must not exceed 128 MiB. This is a tooling safety boundary, not a promise that every package below
that size will compile or load on every device.

The helper receives file contents in chunks no larger than 64 KiB and writes each chunk relative
to the retained staging directory. It does not place the complete library in a JSON or base64
message. The generated ownership record and the separate transaction recovery record are each
bounded to 64 KiB of UTF-8 data.

Output, module, staging, and recovery names must be single valid filesystem components: no slash,
NUL, control characters, `.` or `..`. Their UTF-8 bytes must fit the opened parent filesystem's
reported name limit. The build does not truncate, normalize, case-fold, or silently choose another
name when a value is invalid or reserved.

Before a generation is called prepared, the helper reopens every staged file through retained
directory descriptors. It requires ordinary single-link files, the exact four-file tree, declared
lengths, and matching SHA-256 hashes after reading the bytes back. The intent record exists before
the staging directory, and the staging directory's actual identity is recorded before payload
transfer begins.

## Replace the directory

The helper classifies the destination under the physical parent lock before staging starts.
That choice remains fixed for the transaction: a missing destination is not reclassified as empty
if another directory appears while publication is in progress.

The operation depends on that observed destination:

| Destination | Publication behavior |
| --- | --- |
| Missing | Publish exclusively; a destination that appears meanwhile causes a conflict. |
| Empty directory | Replace only if it is still an ordinary empty directory. |
| Unchanged owned package | Exchange the complete directories, leaving the old package at the staging name for checked cleanup. |

The tool verifies the expected directory identities before replacement. The destination filesystem
must provide the required atomic operation; unsupported filesystems fail without a copy-and-delete
fallback. There is no force flag that bypasses ownership or identity checks.

The output path names a complete old or new package, never a partially written package. Finish
generation before a Swift build or another consumer that opens several package files. Atomic
directory replacement is not a snapshot across separate file opens: a reader spanning the exchange
could otherwise read one file from each version.

Do not edit generated output or move its parent concurrently with the build. The ownership checks
do not guarantee safety against a process deliberately changing files between validation and
replacement. Atomic namespace replacement also does not by itself promise persistence after
power loss.

## Interpret an interruption

Successful replacement is the commit point. Diagnostics distinguish three outcomes:

- **Not published:** the tool knows replacement did not happen. A previously valid output remains
  unchanged, although newly created container directories or recovery state may remain.
- **Published:** replacement succeeded. A cancellation or cleanup problem cannot turn that result
  into a claim that the old package is unchanged. A later parent change is reported separately;
  successful replacement does not assert that the original path still names that directory.
- **Outcome unknown:** a replacement request may have reached the helper, but its result was not
  confirmed. The recorded transaction and actual directory identities need inspection before retry.

Cancellation stops work before the commit request when possible. After that request, the build
must preserve publication evidence while it finishes or reports recovery. It never automatically
rolls a published package back because a later cleanup step failed.

If the live invocation loses confirmation while publishing to a missing destination or replacing
an empty directory, it makes one bounded, read-only reconciliation attempt after the original
helper exits. It reacquires the physical parent lock and compares the recorded transaction,
original destination classification, expected directory identities, and complete package contents
with the generation it prepared. It does not send another commit request, recreate a missing
parent, or remove recovery state.

The complete new package at the destination must retain the prepared directory's identity to
prove publication. For a transaction that originally targeted a missing destination, that same
intact directory still at staging with the destination absent can instead establish that publication
did not happen. For an empty-directory replacement, proving non-publication requires both the
intact prepared directory still at staging and the original destination directory still present
and exactly empty. A missing destination or a different empty directory does not provide that proof.

A conclusive reconciliation refines the reported outcome; it does not turn the failed invocation
into a successful build. The diagnostic preserves the original error and distinguishes reconciled
publication from an acknowledged commit. If the lock, identities, record, or contents cannot be
verified, the outcome remains unknown. An already requested cancellation does not skip this
bounded evidence check.

## Recover without guessing

A new build encountering an interrupted transaction reports the recorded output and recovery
paths. The initial workflow does not silently discard an earlier transaction. Preserve its files
until their relationship to the recorded generation has been established; an unknown or modified
directory is not eligible for cleanup.

A recognized record must be well-formed and match the locked physical parent. Its diagnostic
identifies the earlier transaction and recorded output, even when the current configuration names
a different sibling output. Recognizing the record does not establish package integrity or the
outcome of publication. Unrecognized or inconsistent records remain conflicts and are left intact.

Matching content hashes are not enough to identify which directory was exchanged: rebuilding
unchanged inputs can produce identical records. Recovery also checks the expected directory
identities. Names, modification times, and a staging-name prefix do not authorize deletion.

Normal cleanup removes only the unchanged, transaction-owned staging and recovery state. If
cleanup fails, the diagnostic retains the original failure and identifies the exact remaining
path. It must not remove unrelated files in the parent.

If a transfer ends partway through a file, the live helper can clean it only after verifying the
file's identity and the bytes actually written. The planned complete-file hash does not describe
that partial file. Changed or unknown contents remain with the recovery record; a later build
does not inherit the interrupted process's permission to clean them.

`check` and `doctor` are not recovery commands. `verify` can inspect an existing package's integrity
and input freshness, but a successful verification does not authorize deleting recovery state or
establish the outcome of an interrupted publication. None of these read-only operations repairs
or removes files.
