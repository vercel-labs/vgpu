# Maintainer integration pull requests

## When to read

Read this before preparing, editing, reviewing, or merging a maintainer integration PR. Also read
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the applicable target and release rules. This guide
continues the selected adoption/original workflow; it does not authorize publishing or merging.

External proposals follow [external contributor](external-contributor.md) and the
[contribution policy rollout](../../CONTRIBUTING.md#contribution-policy-rollout). Do not relabel an
external PR as `development` to make it mergeable.

## 1. Confirm scope, origin, and target

Review the entire diff against the intended base. Normal development targets `canary`. Only the
documented stable promotion and web-only production lanes target `main`. Preserve the branch name
assigned to the workspace unless the user explicitly asks to change it.

Use the [PR template](../pull_request_template.md). Identify `maintainer-adoption` with source links
or `maintainer-original` with the internal request/issue. Record the confirmed need, triage outcome,
final plan, important decisions, validation, and any source credit. The description must be
reviewable without the conversation or `.context`; do not paste an activity log or abandoned plan.

## 2. Declare type and release impact

Include exactly one `## PR type` section containing exactly `development` or `release`. There is
no default and no inference from the branch/title.

| Change | PR type |
| --- | --- |
| Feature, fix, docs, tests, or internal refactor. | `development` |
| New RC/stable package version prepared on `canary`. | `release` |
| Stable promotion to `main`, or synchronization of versions already accounted for on the target. | `development`, subject to the production lane's policy. |

Type is independent of impact. A release-preparation PR normally declares impact `none`. New public
package versions on `canary` cannot be labeled `development`. Release preparation must advance the
current canary version, keep public package versions coherent, and include a substantive
`## Migration review`. Follow [releases](releases.md) before proceeding; finalize the guide before
opening that PR, not during publishing CI.

Include exactly one `## Release impact` section using one of these declarations:

- `none — <specific reason consumers are unaffected>` for tests, CI, repository/site docs with no
  published-package effect, behavior-preserving internal refactors, release preparation, or
  promotion/synchronization of changes already accounted for in their original PRs.
- `changeset — .changeset/<id>.md` for published behavior changes. Use a meaningful filename and
  comma-separated paths for multiple new changesets.

Review the declaration against the actual diff. Never choose `none` merely to satisfy a failing
check. Bundled CLI/MCP documentation affects the published package and needs a changeset. Read
[changesets and migrations](migrations.md) when deciding consumer impact or writing those notes.

## 3. Validate and prepare the PR

Run `pnpm migrations:check` and all applicable checks from the implementation/release workflow.
Record exact results and limitations. Review the final diff and description together. The trusted
`release-impact` check validates commits and description edits, including strict migration
readiness for releases; CI checks structure and cannot prove a compatibility claim is true.

When publication is authorized, create/update the PR against its verified target and follow CI on
the final pushed revision. Fix failures within scope and repeat checks affected by new changes.
Do not weaken checks, change a declaration dishonestly, or bypass protection to deliver the PR.

## 4. Merge and report when authorized

Verify the final head revision, target, required checks, and authorization. Use the merge strategy
required by the lane, preserve agreed attribution, and verify the resulting commit on the target.
For adoption, return to [delivery, attribution, and closure](maintainer-adoption.md#4-deliver-attribute-and-close).

Preparing or opening a PR does not itself authorize merge or release. If the task stops at a draft
or an open PR, return that result and its current checks. A merge into `canary` does not mean an npm
release or production deployment occurred.

## Examples

Repository policy documentation with no published-package effect:

```md
## PR type

development

## Release impact

none — Only repository contributor instructions and PR templates change.
```

A published compute behavior change (use the actual changeset path in the PR):

```md
## PR type

development

## Release impact

changeset — .changeset/compute-frame-passes.md
```

A release PR's impact explanation can name the earlier PRs/changesets accounting for its behavior;
it still uses type `release` and requires the full migration review evidence. These fragments cover
only the declarations, not the complete PR description.

## Required result

A reviewable PR or prepared description containing origin, triage/plan, exact type/impact, and
validation evidence. After an authorized merge, also report the verified commit/target and any
source closure required by the adoption workflow.
