# Contributing

## Prerequisites

- Node.js 22 (the workspace engine is `>=22 <23`)
- pnpm

## Making changes

If your PR changes published package behavior, add a changeset before opening it:

```bash
pnpm changeset
```

Choose each affected `@vgpu/*` package, select the appropriate semver bump (`patch`, `minor`, or `major`), and write a short summary. That summary becomes the changelog entry for the release.

## Branches and release channels

- `canary` is the default development branch and the normal target for feature, fix, docs,
  dependency, and release-preparation PRs. Release candidates from this branch publish to
  npm under `next`.
- `main` contains stable releases. Only stable promotion PRs from `canary` and exceptional
  hotfix PRs should target it. Stable releases from this branch publish to npm under `latest`.

Changesets compares work with `canary` by default, and CI runs on pushes to both long-lived
branches. A change intended for a normal release must land in `canary` first; do not merge it
directly to `main` to make the stable docs move sooner.

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

- [ ] Code changes to a published package include a `.changeset/*.md` file.
- [ ] Docs-only and CI-only PRs may skip a changeset.
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
| `vX.Y.Z`      | Not marked as a pre-release | `main`          | `latest`     |

Before installing dependencies, the workflow verifies that the release event, tag, and checked-out
commit resolve to the same SHA; that the release is the current tip of `canary` (RC) or `main`
(stable); and that the tag version matches every publishable workspace package. A tag
with another prerelease identifier, a checkbox mismatch, the wrong commit, or an unversioned
public package fails without publishing.

All published packages (`vgpu`, `@vgpu/core`, `@vgpu/wgsl`, `@vgpu/wgsl-std`,
`@vgpu/adapter-node`, `@vgpu/adapter-mock`, `@vgpu/render`) version together via the
`fixed` group in `.changeset/config.json`; private packages (`@vgpu/cli`, the docs app)
keep independent lineages outside that group.

### Release candidates from `canary`

For the first release candidate in a cycle, create a release branch from an up-to-date
`canary` and enter Changesets prerelease mode:

```bash
pnpm changeset status   # what will be bumped, and why
pnpm changeset pre enter rc
pnpm changeset version  # applies the bumps, writes CHANGELOGs, consumes .changeset/*.md
pnpm install            # refresh the lockfile with the new internal versions
```

Commit `.changeset/pre.json` along with the generated versions and changelogs. Review the
diff—the changelog text is the public release note—then open a PR such as
`chore(release): 0.5.0-rc.0` targeting `canary`. For later candidates in the same cycle,
leave prerelease mode active and run `pnpm changeset version` again after new changesets land;
Changesets increments the `-rc.N` suffix.

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
never update `latest`.

### Promote a stable release to `main`

After the final release candidate is accepted, create one more release branch from `canary`
and exit prerelease mode:

```bash
pnpm changeset pre exit
pnpm changeset version
pnpm install
```

The resulting package versions must be the stable `X.Y.Z` with no suffix. Merge that release
preparation PR into `canary`, then open the stable promotion PR from `canary` to `main`. Prefer
a merge commit so the two long-lived branches retain shared history. Do not add unrelated code
while the promotion PR is open.

Once the promotion PR is on `main`, create a **GitHub Release** on the `main` merge commit with
tag `vX.Y.Z` matching the new `vgpu` version. Do not mark it as a pre-release. Publishing it
triggers `release.yml`, which checks out the tag, builds, runs the release gates (typecheck,
the test suites that run on a plain runner, and `pnpm bundle-check`) and then runs
`pnpm -r publish --access public --tag latest` with npm Trusted Publishing (OIDC).
After the publish job succeeds, a separate job reports
`Vercel - vgpu: npm stable published` on that exact commit. Vercel keeps the matching production
deployment off `vgpu.sh` until that status succeeds, then assigns the production domains.

Only tags starting with `v` publish. Binary-asset releases such as `dawn-*` are ignored by
the workflow's `if:` gate. If a pre-publish gate fails, fix the source branch, delete and
recreate the release/tag, and try again.

After a successful stable publish and production deployment, immediately merge `main` back
into `canary`. This records the stable merge commit on the development branch and keeps the
next promotion diff clean.

### Stable hotfixes

For an urgent stable-only fix, branch from `main` and target the hotfix PR back to `main`.
Add a changeset and use `pnpm changeset status --since main` when inspecting the bump, then
run the normal `pnpm changeset version` and `pnpm install` steps. Publish a stable
`vX.Y.Z` release from the merged `main` commit.

Immediately merge `main` back into `canary` after the hotfix. If `canary` is already in an RC
cycle for a later version, preserve its later package versions and `.changeset/pre.json` while
resolving conflicts, but retain the hotfix code and changelog entry. Do not leave the hotfix
only on `main`, or the next stable promotion can regress it.

### Repository migration and external rollout

This repository change does not create branches, change repository settings, or configure
Vercel. Roll it out in this order:

1. Before merging, seed the `Vercel - vgpu: npm stable published` commit status on the current
   stable `main` commit. In Vercel, keep the production branch set to `main`, keep automatic
   production domain assignment enabled, and add that exact GitHub status as a required
   Production Deployment Check. Do not select the generic `publish` job: non-npm releases can
   produce skipped checks with that name.
2. Freeze merges to `main`, then create `canary` from that exact stable `main` commit. Apply
   required checks and branch protection to both branches, require branches to be current before
   merging, and change the repository's default GitHub Actions token permission to read-only. The
   release reporter keeps its explicit `statuses: write` permission. Allow normal PRs into
   `canary`, restrict `main` to promotion and hotfix PRs, and protect `v*` tags/releases for
   maintainers.
3. Merge the repository-side migration into `canary`, confirm its push CI succeeds, and then change
   GitHub's default branch to `canary`. Update automation that targets the default branch and
   retarget open feature/fix PRs from `main` to `canary`.
4. Validate the migration with an RC from `canary` under npm's `next` dist-tag.
5. Promote that accepted release from `canary` to `main`. Confirm the new production deployment is
   ready at its generated URL while `vgpu.sh` remains on the previous stable deployment, then moves
   only after npm and the stable status succeed. If a dedicated canary hostname is added, update
   the MCP browser-origin policy in `apps/docs/app/api/mcp/route.ts` as part of that hostname
   rollout.

The Deployment Check is the production cutover gate. A merge to `main` yields a production build,
but Vercel must leave `vgpu.sh` on the previous deployment while the unique status is absent. Only
after `release.yml` publishes every stable npm package successfully does it set that status on the
same commit; Vercel can then assign the production domains. RC and binary-asset releases never set
the status. Keep the context name stable and unique, and keep automatic production domain
assignment enabled—Vercel's Deployment Checks intercept that assignment until their requirements
pass. Do not add `github.autoAlias: false`; that opts into a different manual-promotion workflow
and is incompatible with this check-based rollout.

Freeze `main` from the moment a stable tag is created until the release reporter succeeds. The
workflow checks the live `main` tip again before reporting success, so a concurrent merge after npm
publication would intentionally leave the newer deployment staged for manual reconciliation.

If a stable publish fails or partially completes, do not force-promote the deployment. Leave the
status absent, reconcile and verify every package and the `latest` dist-tag, and only then
deliberately mark the commit status successful. A Vercel Force Promote bypasses the npm gate and
is an emergency operation, not the normal release path.

### npm Trusted Publishing

Publishing uses OIDC, not a token — there is no `NPM_TOKEN` secret. Each published package
has a Trusted Publisher configured on npm (provider GitHub Actions, owner `vercel-labs`,
repository `vgpu`, workflow `release.yml`, no environment). A **new** package has to be
published manually once before Trusted Publishing can be configured for it.
