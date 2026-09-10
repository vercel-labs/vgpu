# Contributing

## Prerequisites

- Node.js 22 (the workspace engine is `>=22 <23`)
- pnpm

## Making changes

Every PR description must contain exactly one `## PR type` section with exactly `development` or
`release` (no default). Use `release` only to prepare a new RC/stable package version on `canary`.
Use `development` for other work, including stable promotions to `main` and branch synchronization
whose versions are already accounted for on the target. Titles and branch names do not determine type.

Type is independent of `Release impact`: a release-preparation PR normally has impact `none` because
its changes were accounted for in earlier PRs. The trusted `release-impact` check rejects new public
package version changes labeled `development` on `canary`. Release PRs must advance the current
canary version, have coherent public package versions, contain a substantive `## Migration review`
section and pass the same `migrations:check --release` validation used at publication. These checks
run before merge and rerun on description edits, without executing candidate code with write access.
Private tooling version changes or new package creation alone do not constitute release preparation.
Promotions to `main` remain subject to their separate main-policy, not the new-version preparation gate.

If your PR changes published package behavior, add a changeset before opening it:

```bash
pnpm changeset
```

Choose each affected `@vgpu/*` package, select the appropriate semver bump (`patch`, `minor`, or `major`), and write a short summary. That summary becomes the changelog entry for the release.

Every PR description must contain exactly one `## Release impact` section. Use either
`none — <specific justification>` or `changeset — .changeset/<id>.md` (comma-separated for multiple
new files). Tests, CI, repository/site docs with no published-package effect, release preparation and behavior-preserving internal
refactors do not need a changeset. Stable promotions and branch synchronization may also use `none`
when their changes were already accounted for in the original PRs. Changes affecting published behavior do. Review the declaration
against the diff: automation cannot prove that a change has no consumer impact.
Documentation bundled in the published CLI/MCP corpus does need a changeset, even without an API change.

Every changeset must use this body structure after its normal package/bump frontmatter:

```md
## Summary

Describe the observable change for the changelog.

## Migration

None: explain specifically why existing consumers need no adaptation.
```

If adaptation is required, replace the `None:` line with `### Affected usage`, `### Steps`, and
`### Verification`. Identify applicable source versions or API usage, include before/after examples
under level-four headings where useful, and explain how to validate the result. Migration can involve
deployment requirements or defaults, not only removed APIs. Do not infer it from the semver bump.
Historical or partial code samples may use a `ts illustrative` fence; complete current-API examples
use `ts` and participate in `pnpm docs:verify-snippets`.
Older destination guides retain the examples checked for their own release. The current guide is
checked once its archive targets the exact package version and contains every pending changeset
unchanged; development with new or edited uncollected changesets defers that guide until release
preparation. Future guides and regular API/topic documentation remain checked.

Run `pnpm migrations:check` before opening the PR. The `release-impact` check validates the PR
description and new changesets, including on description edits. It executes trusted policy code
and reads candidate Git blobs as data, never running candidate code with write permissions.

The required `release-impact` check is the Actions job itself. Do not replace it with a check
created through the Checks API using `GITHUB_TOKEN`: after multiple executions on the same commit,
GitHub can attach that check to an older workflow suite and leave the merge requirement `Expected`
despite a successful evaluation. The job reports checkout, validation, cancellation and timeout
outcomes directly, without `checks: write` permission. Description edits must still trigger it.

GitHub attaches checks to commits, so the check validates every open PR targeting `canary` or `main`
with the same head SHA. An invalid declaration in any of those PRs blocks the shared commit. Correct
the declaration or close the duplicate PR to refresh the result. If a duplicate moves to a different
head SHA, edit the remaining PR's description to refresh the old commit's result.
When first deploying this workflow, merge it to `canary` and configure `release-impact` as a required
check on both `canary` and `main`; configure `release-migrations` as required on `canary` too.
Existing open PRs need both type and impact declarations and an edit/synchronize event after rollout. Branch protection
is a separate GitHub setting; adding workflow YAML alone does not make a check merge-blocking.

## Visual tests

Run `pnpm test` locally. Exact image comparisons use one pinned native Linux x64 Vulkan environment
in CI, so local ARM64/Metal rounding differences do not fail the visual reference tests.

```sh
pnpm snapshots:check   # Verify the committed and pushed revision in CI; download the diff report.
pnpm snapshots:update  # Generate unapproved candidates in CI; never overwrite references locally.
```

Both commands require GitHub CLI authentication and a clean, pushed branch. Review before/actual/diff
images before applying any candidate PNGs. See [the visual snapshot workflow](docs/visual-snapshots.md)
for bootstrap, artifacts and intentional updates. Functional GPU tests remain separate.

## Branches and release channels

- `canary` is the default development branch and the normal target for feature, fix, docs,
  dependency, and release-preparation PRs. Both release candidates and stable npm releases are
  cut from this branch: RCs publish under `next`, while accepted stable releases publish under
  `latest`.
- `main` is the exact history that may be served at `vgpu.sh`. Every commit on it must be safe to
  deploy immediately. It accepts only a verified stable promotion from `promote/vX.Y.Z` or a
  web-only update from `site/<name>`.

Changesets compares work with `canary` by default, and CI runs on pushes to both long-lived
branches. Package/API work always lands in `canary` first. A web-only update instead starts from
the current `main`, changes only `apps/docs/**`, and is merged back into `canary` after it reaches
production. This keeps unreleased APIs out of the public site without coupling every site update
to an npm release.

Because GitHub loads `pull_request_target`, `workflow_run`, and release workflows from the default
branch, `canary` is also the release control-plane trust boundary. Treat changes to `release.yml`,
`production-authorization.yml`, and their policy scripts as privileged security changes: inspect
them explicitly, keep merge access narrow, and never merge generated or unreviewed variants.
An unrelated canary commit may land between a main-policy check and production CI: authorization
accepts the earlier policy revision only when it is an ancestor of the current canary revision and
all critical main-policy files are byte-identical. If those files change, rerun main-policy before
merging a PR to `main`.

## Bundle budgets

`pnpm bundle-check` enforces gzip budgets stored in each package's `package.json`. Budgets are tiered by audience:

- `"client"` (default when unclassified) — browser-facing entries. **Hard gate**: one byte over budget fails.
- `"tooling"` — loaders, the Node runtime, the CLI and package tarballs. **Soft gate**: over budget warns, and only fails past `vgpuBundleBudgetGrowthThreshold` (default 5%).

Classify with `vgpuBundleAudience` (package-wide) or `vgpuExportBundleAudiences` (per export subpath). Tarball budgets measure published dist bytes: `*.docs.md` files, sourcemap `sourcesContent` and the budget metadata itself are excluded, so documenting the API never competes with the size gate.

When growth is intentional, re-baseline instead of hand-editing numbers:

```bash
pnpm bundle-check --update   # budget = next 512 B multiple at least 512 B above measured
```

Run `pnpm build` first, since budgets are measured from `dist`.

## PR checklist

- [ ] Normal work targets `canary`; only `site/*` and `promote/vX.Y.Z` target `main`.
- [ ] The PR explicitly declares `development` or `release`; release preparation passes the strict readiness checks before merge.
- [ ] Code changes to a published package include a `.changeset/*.md` file.
- [ ] The PR declares release impact; changesets declare a migration or a justified `None`.
- [ ] `pnpm migrations:check` passes.
- [ ] Repository/site docs without published-package impact and CI-only PRs may skip a changeset; bundled CLI/MCP documentation may not.
- [ ] `pnpm typecheck` passes locally.
- [ ] `pnpm test:fast` passes locally.

## Releasing

Releases are cut by hand and published by CI. There is no bot and no automatic
version-packages PR: `.github/workflows/release.yml` runs on a **published GitHub
Release** whose tag starts with `v`, and that is the only thing that publishes to npm.

The workflow accepts exactly two release channels:

| Git tag       | GitHub Release              | Required branch | npm dist-tag |
| ------------- | --------------------------- | --------------- | ------------ |
| `vX.Y.Z-rc.N` | Marked as a pre-release     | `canary`        | `next`       |
| `vX.Y.Z`      | Not marked as a pre-release | `canary`        | `latest`     |

Before installing dependencies, the workflow verifies that the release event, tag, and checked-out
commit resolve to the same SHA; that the release is the current tip of `canary`; and that the tag
version matches every publishable workspace package. A tag
with another prerelease identifier, a checkbox mismatch, the wrong commit, or an unversioned
public package fails without publishing. It requires the canonical push `CI` run and all required
jobs to have succeeded on that exact commit. For a stable release, the current `main` tip must also
be an ancestor of the release commit, which catches a missing or incorrectly squashed back-merge
before npm changes. Every release re-reads its remote refs immediately before the first npm call;
a stable release rechecks them again before recording its audit status.

All published packages (`vgpu`, `@vgpu/core`, `@vgpu/wgsl`, `@vgpu/wgsl-std`,
`@vgpu/adapter-node`, `@vgpu/adapter-mock`, `@vgpu/render`) version together via the
`fixed` group in `.changeset/config.json`; private packages (`@vgpu/cli`, the docs app)
keep independent lineages outside that group.

### Release candidates from `canary`

For the first release candidate in a cycle, create a release branch from an up-to-date
`canary` and enter Changesets prerelease mode:

Before versioning, make sure internal peer ranges explicitly accept the intended RC line.
Stable ranges such as `>=0.1.6 <1.0.0` exclude prereleases; Changesets can interpret the
out-of-range peer as a major bump and propagate it to the entire fixed group. Preserve the
stable range and add the specific RC line (for example, `>=0.1.6 <1.0.0 || ^0.5.0-rc.0`)
in `packages/wgsl/package.json` and `packages/vgpu/package.json`. Review the generated
versions before committing; do not publish an unexpected major or hand-edit generated versions.

```bash
pnpm changeset status   # what will be bumped, and why
pnpm changeset pre enter rc
pnpm release:version    # versions, migration inputs and lockfile; not finalized yet
pnpm migrations:review # read ALL inputs; follow docs/release-migrations.md and edit the guide
pnpm release:finalize   # only after editorial review; attest and generate CLI/web docs
```

Commit `.changeset/pre.json` along with the generated versions and changelogs. Review the
diff—the changelog text is the public release note—then open a PR such as
`chore(release): 0.5.0-rc.0` targeting `canary`, explicitly declaring `## PR type` as `release`.
Its trusted PR check validates finalized migrations and package versions before merge.
For later candidates in the same cycle,
leave prerelease mode active and run `pnpm release:version` again after new changesets land;
Changesets increments the `-rc.N` suffix.

`release:version` reads the Changesets plan and captures fragments before versioning can consume
them. Summary sections become changelogs with immutable release-tag links to required migrations.
Source snapshots are archived under `docs/migrations/records/`; collection upserts by changeset ID
and preserves the existing guide. A new cycle starts with a draft, not concatenated release prose.

For **every RC and stable release**, the preparing agent must read and follow
[the editorial migration checklist](docs/release-migrations.md). Read all cycle changesets (not just
new ones), the previous guide and the final affected API. Write the consolidated
`docs/migrations/<stable-destination>.docs.md`: deduplicate related changes, resolve reversals,
order net changes by dependency, and separate previous-stable from RC-origin upgrade paths.
This file is editorial, not generated. Records, the index and CLI/web copies remain generated.
Even if a change is reverted for stable users, earlier RC adopters may still need repair instructions.

Run `pnpm release:finalize` only after that review. It records the exact version/input/guide fingerprint,
generates CLI/web docs and checks release readiness. Read with, for example,
`pnpm exec vgpu docs cat /migrations/0.5.0.docs.md`. Include a `## Migration review` section in the
release PR with per-changeset coverage and verification evidence, as specified in the checklist.
Use `pnpm migrations:sync <exact-current-version>` to recollect corrected sources without bumping
versions or overwriting the guide; review and finalize again afterward. Commit the record, guide
and regenerated docs. The release workflow runs `pnpm migrations:check --release` and rejects missing,
stale or wrong-version collections and absent/outdated review attestations. CI cannot prove the
editorial quality of the guide. Do not call `changeset version` directly or hand-edit records/fingerprints.
The current prepared guide can be corrected and re-finalized during its PR, including stable
preparation. Finalization is not publication. After stable versioning has consumed changesets,
make editorial corrections in the guide, not by restoring consumed files as new pending changesets.

Private packages (`@vgpu/cli`, the docs app) are versioned so they get changelog entries,
but they are never published. `@vgpu/cli` ships _inside_ the `vgpu` tarball: `copy-cli.mjs`
writes a synthetic `package.json` stamped with `vgpu`'s version, so its own version field
is internal bookkeeping only — nothing at runtime reads it. Running the CLI **from a
checkout** (`node packages/vgpu/bin/vgpu.js ...`) ignores it too: `bin/vgpu.js` detects it is
in-repo and resolves its version from `packages/vgpu-api/package.json`, so the in-repo binary
reports (and negotiates with `https://vgpu.sh`) the same version the published package would.
Never hand-edit `packages/vgpu/package.json`'s version to work around a version-gate error —
it has no effect.

Once the release-preparation PR is on `canary`, create a GitHub Release on that commit with
tag `vX.Y.Z-rc.N` and **Set as a pre-release** selected. The workflow publishes the fixed
packages under `next`; testers opt in with `npm install vgpu@next`. A release candidate must
never update `latest`. Keep `canary` frozen from tag creation until the publish job finishes,
because the workflow rechecks that the tag is still the live canary tip immediately before npm.

### Publish stable from `canary`, then promote it to `main`

After the final release candidate is accepted, create one more release branch from `canary`
and exit prerelease mode:

```bash
pnpm changeset pre exit
pnpm release:version
pnpm migrations:review # follow the editorial checklist and revise stable/RC upgrade paths
pnpm release:finalize
```

The resulting package versions must be the stable `X.Y.Z` with no suffix. Merge that release
preparation PR into `canary`, then freeze both `main` and `canary`; keep them frozen until the
promotion is authorized and merged back. This also pins the trusted authorization policy while it
evaluates the release. Create a **GitHub Release** on that exact canary tip with tag `vX.Y.Z`
matching the new `vgpu` version. Do not mark it as a pre-release. Publishing it triggers
`release.yml`. Its unprivileged job checks out the tag, builds, runs the release gates (typecheck,
the test suites that run on a plain runner, and `pnpm bundle-check`), packs exactly seven packages,
and uploads their checksummed tarballs as an immutable workflow artifact. A separate minimal job is
the only one with npm's OIDC permission: it does not check out or execute repository code, verifies
the artifact and refs again, and publishes only those seven tarballs under `latest`. Extra public
workspaces are never implicitly added to the publish set.

After the publish job succeeds, a separate job rechecks that both the stable tag and canary still
resolve to the published commit and records `vgpu: stable npm published` on it. This is an audit
status, not permission to deploy. If either ref moved before the status was recorded, leave the
branches frozen and reconcile the release instead of manufacturing a promotion.

Once the audit status is successful:

1. Create `promote/vX.Y.Z` at the tagged commit. The branch must not contain a merge, rebase, or
   follow-up fix after the tag.
2. Open a PR from that branch to `main`. It is also valid to create this as a draft before
   publication and mark it ready afterwards.
3. Keep `main` frozen and merge the PR with **Create a merge commit**. Squash and rebase are not
   valid for a stable promotion: the production policy proves that the merge commit's second
   parent is the tagged, published commit and that both trees are identical.
4. Wait for CI and `Vercel - vgpu: production authorized`. Vercel builds the new main commit but
   keeps the current production aliases until that status succeeds.
5. Merge the new `main` back into `canary` immediately with **Create a merge commit** (or an exact
   fast-forward performed under the same branch protections). Never squash or rebase this
   synchronization: the next stable release must contain the previously authorized main commit.
   This preserves web-only updates and keeps the next promotion ancestry clean.

Do not publish a newer stable version until this promotion completes: the policy verifies that
every package's current npm `latest` still equals `X.Y.Z`.

The promotion checks the immutable release tag, the published GitHub Release, the successful
release workflow and its `publish` job, all fixed package versions, the npm `latest` dist-tag for
every public package, and the exact tree entering `main`. It cannot authorize merely because a
status name exists.

Only tags starting with `v` publish. Binary-asset releases such as `dawn-*` are ignored by
the workflow's `if:` gate. A `v*` tag is permanent even when a gate fails: never move, delete, or
reuse it. Fix `canary`, prepare a new package version (`rc.N+1` or a new stable patch), and publish
a new tag and GitHub Release.

### Web-only production updates

A documentation or gallery change that does not need a new npm package may deploy independently:

1. Create `site/<name>` from the **current `main`**, not from canary.
2. Change only files under `apps/docs/**`. The complete branch diff must be nonempty and remain
   inside that directory; renaming a file into it from elsewhere is rejected.
3. Open a PR to `main`, run the full required CI, and use **Create a merge commit**. The production
   policy must be able to prove the resulting commit's immediate parent is the PR's reviewed
   `main` base. It also requires that parent to have a successful production-authorization status,
   so authorization forms an unbroken chain rather than blessing an arbitrary accumulated
   deployment.
4. After production is authorized, merge `main` back into `canary` immediately with a merge commit
   (or exact fast-forward), never squash or rebase. Otherwise the next release tag will not contain
   the previously authorized main commit and stable publication will stop.

If a docs example relies on an unreleased API, it is not web-only: keep it in canary and ship it
with the package release that introduces the API. Files outside `apps/docs/**`—including package
documentation bundled into the CLI—always use the normal canary and npm release path.

There is no direct stable hotfix lane. An urgent package fix still goes to `canary`, is published
as a new stable version, and enters `main` through `promote/vX.Y.Z`. This prevents production from
containing package code that npm users cannot install.

### Production authorization and one-time rollout

The Deployment Check is the production cutover gate. A merge to `main` creates a production build,
but Vercel leaves `vgpu.sh` on the previous deployment until the exact commit receives
`Vercel - vgpu: production authorized`. The privileged authorization workflow runs only after the
full `CI` push workflow succeeds on the live main tip. It executes policy code pinned to the
trusted default-branch control plane; the separate main candidate checkout is never executed. A
first evaluation publishes `pending`; a rerun fully revalidates the evidence without replacing an
existing success with a transient failure.

For both lanes, the previous main commit must already have a successful authorization status. This
forms a continuous production chain. The current tip is read once before evaluation and again
immediately before success; a concurrent main merge makes the run fail closed. Keep automatic
production domain assignment enabled, and do not add `github.autoAlias: false`: Deployment Checks
intercept alias assignment without changing the deployment model.

Roll out this policy in the following order:

1. Freeze `main` and retarget or replace any open PR that does not fit `site/*` or
   `promote/vX.Y.Z`. Before the new `workflow_dispatch` becomes live, create the
   `examples-api-parity` Environment, restrict its allowed deployment branch to exactly `canary`,
   and add `VERCEL_AUTOMATION_BYPASS_SECRET` there. After confirming it works, remove any
   repository- or organization-level copy accessible to this repository.
2. Open the repository-side policy PR into `canary` and let its real CI jobs finish. Before merging,
   add `examples-windows-online` to the required checks on both `canary` and `main`; keep the
   separate `ort-init-device-node` pull-request check required. Require PRs for both long-lived
   branches, disallow force pushes/deletion, and configure the `main` ruleset to allow only merge
   commits. Then merge the policy and confirm its `canary` push CI succeeds. Add the new
   `main-policy` check from the GitHub Actions app to `main`'s required checks; it is served from
   the default `canary` control plane and must gate the first promotion too.
3. Freeze both long-lived branches. Seed `Vercel - vgpu: production authorized` as successful on
   the current stable main commit `e1661e3385ac63dc88535c1a0e819e52702f02f8`, with an auditable
   target URL.
4. Replace the old Vercel Production Deployment Check
   `Vercel - vgpu: npm stable published` with the new exact authorization context. Keep the
   production branch set to `main`.
5. Create a repository-level tag ruleset for `refs/tags/v*` with update, deletion, and signature
   rules, then activate it before the next RC. Do not rely on an inherited ruleset whose include
   list is empty; it protects no tags. Keep all normal work targeting `canary`.
6. Confirm all seven npm packages trust `release.yml` as their GitHub Actions publisher, with no
   environment and direct `npm publish` enabled under **Allowed actions**. Publish and verify an RC
   from canary; this proves OIDC works without using the stale `NPM_TOKEN`.
7. Remove the repository-level `NPM_TOKEN` after that successful RC; no workflow references it.
   Then publish the first stable npm version from a frozen canary tip and promote that exact tagged
   commit with a merge commit. The first promotion is a deliberate bootstrap: its old main base
   does not yet contain `main-policy`, so that one PR runs the full check from the trusted canary
   copy. Production authorization additionally requires the candidate's policy files to match that
   trusted copy byte for byte and its first parent to be the exact seeded SHA above.
8. Confirm the new deployment remains staged until the neutral context succeeds, then merge main
   back into canary without squashing or rebasing. From this point onward, use only the two
   documented lanes.

If npm accepted only some packages, that version is abandoned and must never be rerun or promoted:
restore the previous complete release's `latest` tags if necessary, fix `canary`, and publish every
package under a fresh stable patch version. If npm publication itself completed and only the
separate audit-status job failed transiently, rerun that failed job while both refs remain frozen.
Never forge either status. A Vercel Force Promote bypasses the repository policy and is an
emergency operation, never the normal release path.

### npm Trusted Publishing

Publishing uses OIDC, not a token — the repository must not retain an `NPM_TOKEN` secret. Each published package
has a Trusted Publisher configured on npm (provider GitHub Actions, owner `vercel-labs`,
repository `vgpu`, workflow `release.yml`, no environment). Under **Allowed actions**, explicitly
enable direct `npm publish`; a stage-only trust relationship cannot authorize this repository's
release workflow. Do not rely on npm's preselected action. A **new** package has to be published
manually once before Trusted Publishing can be configured for it.
