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

## PR checklist

- [ ] Code changes to a published package include a `.changeset/*.md` file.
- [ ] Docs-only and CI-only PRs may skip a changeset.
- [ ] `pnpm typecheck` passes locally.
- [ ] `pnpm test:fast` passes locally.

## Releasing (automated)

Releases are automated from `main`.

1. A PR with package changes merges to `main`.
2. The Release workflow runs and opens or updates a `chore(release): version packages` PR.
3. Merging that release PR runs the same workflow again.
4. `changesets/action` publishes any queued packages to npm with Trusted Publishing (OIDC), then creates tags and GitHub releases.

This PR does not publish anything by itself. Publishing only happens after a version-packages PR is merged on `main` and npm Trusted Publishing has been configured.

## Initial setup (one-time, after this PR merges)

### 1. Bootstrap publish v0.0.1 manually

Trusted Publishing requires each package to already exist on npm. Publish the current `0.0.1` packages manually once, in dependency order:

1. `@vgpu/wgsl`
2. `@vgpu/core`
3. `@vgpu/render`
4. `@vgpu/adapter-mock`
5. `@vgpu/adapter-node`

From each package directory, run:

```bash
pnpm publish --access public --otp=<code>
```

### 2. Configure Trusted Publishers on npm

For each package, open its npm settings and add a Trusted Publisher with:

- Provider: GitHub Actions
- Owner: `vercel-labs`
- Repository: `vgpu`
- Workflow filename: `release.yml`
- Environment: leave blank

Package settings pages:

- `https://www.npmjs.com/package/@vgpu/wgsl`
- `https://www.npmjs.com/package/@vgpu/core`
- `https://www.npmjs.com/package/@vgpu/render`
- `https://www.npmjs.com/package/@vgpu/adapter-mock`
- `https://www.npmjs.com/package/@vgpu/adapter-node`

### 3. Verify

Merge the next `chore(release): version packages` PR after Trusted Publishers are configured. The Release workflow should publish automatically, and the npm package pages should show provenance for the published version.

### 4. Cleanup

If an `NPM_TOKEN` repository secret was ever added during earlier experiments, delete it. It is not used by this workflow.

## Prereleases (future)

If you need a prerelease cycle later:

```bash
pnpm changeset pre enter beta
```

Work on a dedicated prerelease branch such as `next`, then exit prerelease mode when you are ready to return to stable releases:

```bash
pnpm changeset pre exit
```
