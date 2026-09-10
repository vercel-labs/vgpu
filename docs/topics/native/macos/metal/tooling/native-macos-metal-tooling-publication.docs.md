---
title: Publish generated packages
summary: Understand output ownership, atomic replacement, cancellation, and recovery when a Metal package is generated.
websitePath: /native/macos/metal/tooling/publication
keywords: native, macos, metal, generated package, publication, atomic, staging, ownership, recovery
---

# Publish generated packages

A generated package contains Swift code and a compiled library that must agree. The build prepares
them together, then replaces the output directory as one operation.

> Warning: This is the docs-first publication contract. Staging, missing and empty-destination
> publication, their bounded read-only reconciliation, and same-owner package exchanges with identical
> bytes or a changed module name have native test coverage, as does rejection of an old generated
> subtree on another filesystem device. Owned exchanges also have read-only recovery coverage after
> helper death, both after success and before exchange with both original generations intact.
> Broader owned-replacement fault handling still needs coverage and implementation.
> The local installed build companion publishes to an initially absent destination and checks the
> resulting package in an offline local-tarball test with dependency install scripts disabled.
> The same installed workflow replaces an ordinary empty directory in a separate project, rebuilds
> its intact owned package with unchanged inputs, and then changes the module name and shader contents
> while keeping the same owner and output path. It checks each new generation's own hashes and record,
> the new module's exact file set, removal of the previous files without changing their bytes, and
> current verification. These normal rebuilds do not qualify installed interruption or cleanup failures.
> Installed integrity-conflict coverage also rejects a modified `Package.swift` without changing the
> conflicting bytes or original ownership record, or creating staging or a recovery record.
> That installed workflow also covers an unrecognized recovery record: its conflict report retains
> the supplied paths while preserving the existing package and recovery files. A separate,
> explicitly fault-instrumented invocation of the same candidate observes a successful real rename
> followed by helper death before acknowledgment. Its report includes `Confirmation: reconciled`,
> retains the original failure, and preserves the published package and journal. This instrumentation
> does not qualify ordinary loader behavior, signing, or quarantine. A subsequent ordinary build
> recognizes that same retained transaction, reports its original output and journal, and leaves the
> evidence intact. Broader installed interruption and unknown-outcome diagnostics remain unqualified;
> this is not a released end-to-end build workflow.

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

Before creating transaction state for an owned replacement, every generated directory and all four
old package files must be on the same filesystem device as the retained package root and physical
output parent. A generated subtree mounted from another device is a conflict, even when its file
names, bytes, and ownership record otherwise match. It is not adopted for replacement or cleanup.
This device boundary applies to generated contents, not the owning configuration: an accepted
configuration alias may resolve to another device. Matching device identities do not by themselves
prove the absence of every possible mount or alias topology.

### Bound one transaction

Publication accepts exactly the four generated files described in
[Build and verify a Metal package](/native/macos/metal/tooling/build). Their combined raw byte size
must not exceed 128 MiB. This is a tooling safety boundary, not a promise that every package below
that size will compile or load on every device. For an owned replacement, this limit applies
separately to each generation.

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

### Repeat a build

Use the same `vgpu native build` command for the first generation and later rebuilds. An ordinary
empty output directory can receive the first package; it does not need an ownership record yet.
A nonempty output must instead be an intact generated package owned by the selected configuration.
Both a current package and an intact package made stale by shader changes can be rebuilt.

A successful rebuild reports `Native package: published`. The new output contains only its new
generation's files, even when the generated module name changed. Cleanup uses the old generation's
recorded paths; it does not keep obsolete generated files or remove unrelated files from the parent.
Run `vgpu native verify` with the same configuration to check that the resulting package is current.
Verification does not establish whether a directory exchange occurred or clean recovery files.

Modified generated files, additional handwritten files, or a different owning configuration prevent
ordinary replacement. Rejection preserves the conflicting file bytes and original ownership record;
the build does not repair them or rewrite the record to accept the edit. There is no force option
that discards those conflicts. A retained transaction also prevents an ordinary retry:
follow [Recover without guessing](#recover-without-guessing) before
deciding what to do with that evidence.

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

If the live invocation loses publication confirmation, it makes one bounded, read-only
reconciliation attempt after the original helper exits. It reacquires the physical parent lock
and compares the recorded transaction,
original destination classification, expected directory identities, and complete package contents
with the generation it prepared. It does not send another commit request, recreate a missing
parent, or remove recovery state.

The complete new package at the destination must retain the prepared directory's identity to
prove publication. For a transaction that originally targeted a missing destination, that same
intact directory still at staging with the destination absent can instead establish that publication
did not happen. For an empty-directory replacement, proving non-publication requires both the
intact prepared directory still at staging and the original destination directory still present
and exactly empty. A missing destination or a different empty directory does not provide that proof.

For an owned exchange, reconciliation establishes that publication happened when
the complete new package is at the destination with its original prepared directory identity,
exact file set, lengths, and hashes. Its generated directories and files must remain on the physical
parent's filesystem device. The recorded plan must match the original live transaction, including
the old module, file manifest, integrity record, and configuration identity accepted before exchange.
This is historical publication evidence, not a fresh ownership or input-freshness check.

Proving that an owned exchange did not happen requires both original generations: the complete old
package must remain at the destination with its original directory identity, and the complete new
package must remain at staging with its prepared identity. Each package is checked against its own
module, exact file set, lengths, and hashes; both retained directory trees and all generated files
must stay on the physical parent's filesystem device. A missing destination, a substituted root,
or an incomplete or modified generation leaves the outcome unknown, even when the other package
appears intact. Equal content hashes alone do not establish either directory's identity.
An in-place edit to an old payload prevents this negative proof even when its directory and file
identities and its byte length have not changed.
The two module names may differ. An intact old package can provide this historical evidence even
though it no longer matches the current project's module or input fingerprint.

An old package left at staging is recovery evidence, not permission to delete it. Its contents are
not required to prove publication of the complete new generation at the destination. Reconciliation
does not downgrade that proof because old staging bytes have changed. It does not clean either
generation or the journal, reopen the current configuration, or authorize
another exchange. The original failure is still reported after a proved non-publication, without
a publication receipt.

A conclusive reconciliation refines the reported outcome; it does not turn the failed invocation
into a successful build. The diagnostic preserves the original error and distinguishes reconciled
publication from an acknowledged commit. If the lock, identities, record, or contents cannot be
verified, the outcome remains unknown. An already requested cancellation does not skip this
bounded evidence check.

When a failed invocation carries a checked publication receipt, its command report prints
`Confirmation: acknowledged` or `Confirmation: reconciled` immediately after the publication
outcome. The value comes from that receipt: `acknowledged` means the live helper's response was
checked; `reconciled` means the later read-only evidence check established publication. No
confirmation line is added without a receipt, and the command does not infer one from a directory
name or matching hashes.

For example, losing the helper response after a real publication can produce this failure report:

```text
Native publication: published
Confirmation: reconciled
[error] helper-failed: Metal publication published: Invalid publication staging helper response
Inspect retained paths (not cleanup authority):
  /absolute/output/parent/.vgpu-native-publication.json
  /absolute/output/parent/AppShaders
```

This remains a failed invocation with empty standard output, not a successful build report or
permission to remove the retained files. The original error and paths remain in the report;
the additional confirmation describes the evidence behind the publication outcome. Ordinary
failure exits `1`, while cancellation retains the documented signal exit status.

## Recover without guessing

A new build encountering an interrupted transaction reports the recorded output and recovery
paths. The initial workflow does not silently discard an earlier transaction. Preserve its files
until their relationship to the recorded generation has been established; an unknown or modified
directory is not eligible for cleanup.

A recognized record must be well-formed and match the locked physical parent. Its diagnostic
identifies the earlier transaction and recorded output, even when the current configuration names
a different sibling output. Recognizing the record does not establish package integrity or the
outcome of publication. Unrecognized or inconsistent records remain conflicts and are left intact.

For example, an ordinary later build can encounter the prepared journal retained after a previous
invocation published but lost its helper acknowledgment. If staging and the journal-update file
are absent, the recognized-transaction report lists only the remaining journal:

```text
Native publication: not-published
[error] interrupted-transaction: Metal publication not-published: Interrupted publication <transaction-id> for /absolute/output/parent/AppShaders
Inspect retained paths (not cleanup authority):
  /absolute/output/parent/.vgpu-native-publication.json
```

The transaction and output in this message come from the recognized earlier record. `not-published`
describes this new invocation: it does not contradict an earlier `published` / `reconciled` report.
This invocation has no publication receipt and adds no confirmation line. It exits `1` with empty
standard output and leaves the earlier package and recovery evidence intact; recognizing the
transaction does not authorize another publication, cleanup, or reconstruction of its outcome.

When an unrecognized recovery record prevents this invocation from publishing, the command reports
`not-published`, its error code and original message, and the retained paths on standard error.
For an unrecognized record beside a retained staging directory, the report has this shape:

```text
Native publication: not-published
[error] conflict: Metal publication not-published: Unrecognized publication recovery record
Inspect retained paths (not cleanup authority):
  /absolute/output/parent/.vgpu-native-stage
  /absolute/output/parent/.vgpu-native-publication.json
```

This failure exits `1` with empty standard output. The outcome describes the current invocation;
it does not establish what an earlier transaction did or imply that no output package exists.
The report preserves the retained paths supplied by the publisher in their original order, rather
than deriving them from the current configuration or guessing a missing transaction. Inspect these
locations before deciding how to recover. The command does not delete or repair them, retry the
build, or print a successful publication report. Signal exit statuses remain as described in
[Build and verify a Metal package](/native/macos/metal/tooling/build).

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
