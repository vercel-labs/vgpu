# Release preparation and documentation

## When to read

Read this before preparing/reviewing an RC or stable release, changing versions for a release, or
publishing packages. This extends the selected maintainer workflow. Read
[CONTRIBUTING.md](../../CONTRIBUTING.md) for channels, versioning, publishing, branch rules, and
recovery. Before every RC and stable release, read
[docs/release-migrations.md](../../docs/release-migrations.md) completely and follow its checklist.

## 1. Prepare version inputs

Use `pnpm release:version`, never `changeset version` directly. Enter or exit Changesets RC mode
separately as described in CONTRIBUTING.md. Versioning only prepares package versions, the lockfile,
and migration inputs; it does not finish the release. Check the selected channel, version,
package coherence, and applicable peer ranges before proceeding.

## 2. Read every migration input

Run `pnpm migrations:review` and read its entire output, including changesets already shipped in
earlier RCs and every `None` justification. Continue reading if output is truncated until all
sources and the guide have been read. Never delegate or skip this editorial review because CI is
green or a previous RC already had a guide.

Inspect the final affected API and behavior and compare previous-stable and published-RC origins.
Keep per-changeset coverage notes as required by the editorial checklist.

## 3. Write the consolidated guide

Write `docs/migrations/<version>.docs.md` yourself. Compare the final API, consolidate related
changes, resolve reversals, order steps by dependency, and separate stable-origin from RC-origin
paths. Do not concatenate changesets or tell users to apply a change and then undo it. A reversal
can mean no work for stable users while RC adopters still need repair instructions. Retain relevant
RC instructions in the stable guide and explicitly justify paths requiring no migration.

`docs/migrations/records/<version>.json` archives changeset sources so history survives cleanup.
Records, the index, and CLI/web copies are generated; individual version guides are editorial.
Progressive notes belong in `.changeset/*.md`; consolidated guides are edited during preparation.
RCs upsert sources by ID and preserve the guide for revision rather than replacing it.

## 4. Verify and finalize

Complete the editorial checklist and its relevant tests/snippet verification. Only then run
`pnpm release:finalize` to record reviewed inputs/the guide and generate CLI/site documentation.
This is your attestation, not an automated proof of correct prose. Any change to inputs, target
version, or guide requires another review and finalization. Never hand-edit a review fingerprint.

Prepare the [integration PR](pull-requests.md) with type `release`, coherent public versions, and a
substantive `## Migration review` containing exact target, origins considered, per-changeset
coverage, overlap/reversal decisions, guide link, and verification evidence. Finalize before
opening the release PR; do not wait for publishing CI to discover an unfinished review.

## 5. Publish only within the requested scope

Preparing versions, finalizing docs, opening the PR, merging it, publishing npm packages, and
promoting production are distinct stages. Continue only through stages authorized by the user.
Follow CONTRIBUTING.md's exact release/promotion workflow and verify its live refs and checks.
Never report a finalized guide or merged release-preparation PR as a published package.

## Corrections and immutable history

Do not rename/delete changesets already included in an RC. Stable source collections are frozen;
new fragments belong to the next release. The current prepared guide can receive editorial
corrections during its release PR: edit it and run the editorial review and `release:finalize`
again. Do not restore consumed stable changesets for prose corrections; that queues another release.
Use the documented recollection/recovery process when inputs themselves change. Released npm
packages and Git tags are immutable; never rewrite or reuse a release tag.

## Examples

| Situation | Required next step |
| --- | --- |
| A new RC adds no migration text compared with the preceding RC. | Still read all sources and the guide, check the final API/origins, and finalize for the new target. |
| A later RC restores an old API name. | Explain the net stable-origin path and retain repair steps for users of the intermediate RC. |
| A prepared guide has a prose error during PR review. | Correct the guide, review it, and finalize again; do not restore consumed stable changesets. |
| The task is only to promote an already published stable version. | Follow the stable promotion/back-merge lane; its PR type is `development`, and it does not create a new package version. |

## Required result

For preparation: coherent versioned inputs, the editorial guide, generated outputs, completed
review evidence, and a reviewable release PR when requested. For publication or promotion: also
report verified package/tag/branch results for the stages actually completed.
