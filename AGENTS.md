# Working on vgpu

Normal development targets `canary`. Read CONTRIBUTING.md before preparing a PR or release.

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
mode separately as described in CONTRIBUTING.md. The wrapper collects fragments before Changesets
consumes them, versions packages, updates the lockfile, and generates CLI/web docs. Review the full diff.

`docs/migrations/<version>.docs.md` is generated. `docs/migrations/records/<version>.json` archives its
changeset sources so stable history survives Changesets cleanup. Author in `.changeset/*.md`, not in
generated guides or records. RCs upsert by changeset ID into the same destination-version guide.
Do not rename or delete changesets already included in an RC. Stable records are finalized; new
fragments belong to the next release, not a regeneration of the previous stable guide.
Released npm packages and Git tags remain immutable; never rewrite/reuse a release tag.
