# Working on vgpu

Normal development targets `canary`. Read CONTRIBUTING.md before preparing a PR or release.

## Every PR declares its type

Include exactly one `## PR type` section with exactly `development` or `release`, never a default
or inference from the title/branch. `release` prepares a new RC/stable package version on `canary`;
all other work uses `development`, including promotions to `main` (governed by main-policy) and
synchronization of versions already accounted for on the target branch. This is independent of impact:
a release-preparation PR normally declares impact `none`.

The trusted `release-impact` check validates this decision on commits AND description edits. New public
package version changes on `canary` cannot be labeled `development`. A `release` PR must advance the
current canary version, have coherent public package versions, include a substantive `## Migration review`
section and pass the same strict migration readiness check used at publication. Finalize the guide
before opening the release PR; do not wait for publishing CI to discover an unfinished review.

## Every PR declares release impact

Include exactly one `## Release impact` section in the PR description:

- `none — <specific reason consumers are unaffected>` for tests, CI, docs-only work, release preparation, behavior-preserving internal refactors, or promotion/synchronization of changes already accounted for in their original PRs.
- `changeset — .changeset/<id>.md` for changes to published behavior. List multiple new changesets with commas.

Use a meaningful filename, not the placeholders above. The `release-impact` check runs again when
the PR description changes. Review the declaration against the diff: CI checks structure, not the
truth of a compatibility claim. Never declare `none` merely to satisfy a failing check.

## Write migration notes while changing code

Every changeset has package bumps in its normal YAML frontmatter and exactly two level-two sections:
`## Summary` (release notes) and `## Migration` (consumer adaptation).

For no adaptation, write `None: <specific justification>` under Migration. Otherwise include
`### Affected usage`, `### Steps`, and `### Verification`. Include before/after examples where useful;
put their headings at level four under Steps. Environment and default changes count, not just API removals.
Do not infer migration requirements from patch/minor/major alone. Run `pnpm migrations:check`.

## Release documentation

Use `pnpm release:version` instead of calling `changeset version` directly. Enter/exit Changesets RC
mode separately as described in CONTRIBUTING.md. This only prepares versions, the lockfile and inputs;
it does NOT finish the release. Before EVERY RC and stable release, read **docs/release-migrations.md**
completely and follow its editorial checklist. Run `pnpm migrations:review` and read its ENTIRE output,
including changesets already shipped in earlier RCs and every `None` justification. If output is
truncated, continue reading until all sources and the guide have been read. Never delegate or skip this
review merely because CI is green or the previous RC had a guide.

Write the final `docs/migrations/<version>.docs.md` yourself: compare the final API, consolidate related
changes, resolve reversals, order steps by dependency, and separate stable-origin from RC-origin paths.
Do not concatenate changesets or instruct users to apply a change and then undo it. A reversal may mean
no work for stable users but still require a migration for RC adopters. Retain relevant RC instructions
in the stable guide. Explicitly justify paths requiring no migration.

Only after that review, run `pnpm release:finalize` to record the reviewed inputs/guide and generate
CLI/web docs. Include per-changeset coverage and verification evidence in the release PR as described
in the checklist. Finalization is your attestation, not an automated proof of correct prose. Changes to
the inputs, target version or guide require another review; never hand-edit a review fingerprint.

`docs/migrations/records/<version>.json` archives changeset sources so stable history survives Changesets
cleanup. Records, the index and CLI/web copies are generated; individual version guides are editorial.
Author progressive notes in `.changeset/*.md`; edit the consolidated guide during release preparation.
RCs upsert sources by ID and preserve the guide for revision, rather than overwriting it.
Do not rename or delete changesets already included in an RC. Stable records are finalized; new
fragments belong to the next release, not a rewrite of the previous finalized stable guide.
Released npm packages and Git tags remain immutable; never rewrite/reuse a release tag.
