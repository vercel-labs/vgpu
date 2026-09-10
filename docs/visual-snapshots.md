# Visual snapshots for contributors

We keep one collection of approved PNGs. Geometry-image comparisons run on native Linux x64
in CI using the pinned Vulkan/lavapipe environment in `infra/snapshots/Dockerfile`. ARM64, Metal and
other local renderers remain useful for development, but their images are not the reference oracle.
`pnpm test` runs local tests without opting into architecture-sensitive visual comparisons;
`VGPU_DOCKER_TEST=1` still enables functional GPU tests, independently of the visual suite.

## Everyday commands

```sh
pnpm test
pnpm snapshots:check
pnpm snapshots:update
```

The two snapshot commands require authenticated GitHub CLI access, a clean checkout, and the current
branch HEAD already pushed to `origin`. They dispatch CI for that exact revision, wait, and download
the `visual-snapshots` artifact under `artifacts/snapshots-<run-id>/`, even when comparison fails.
They never commit, push, approve changes, or upload your uncommitted files. Fork contributors without
workflow-dispatch permission can use the normal PR check and ask a maintainer to generate candidates.

Open the downloaded `index.html` to compare **before / actual / diff**. `environment.json` records the
source revision, Node, Mesa/LLVM packages, CPU capabilities and the Vulkan adapter. `results.json` records hashes and
the result for each rendered image. Missing baselines fail check mode; they are not created silently.
The production CI gate requires the verification job, not the separately named candidate-generation job.

Every pixel is checked, including antialiased pixels: each RGB channel may differ by at most **1/255**,
while alpha must match exactly. One RGB channel differing by 2, or alpha differing by 1, fails the image.
There is no percentage-of-pixels allowance. This intentionally cannot detect an RGB change of only one
level, even across the entire image. Reports retain raw changed-pixel counts, hashes, maximum deltas
and the count outside tolerance; a tolerated match is not claimed to be byte-identical. Tolerated
rounding differences do not create replacement candidates or modify references.

## Intentional visual changes

1. Commit and push the intended code change, then run `pnpm snapshots:update`.
2. Review the report. Update mode generates **unapproved candidates**, not new accepted baselines.
   Semantic assertions (such as distinct camera views) still run and must pass.
3. Copy only the reviewed PNGs from `candidates/` to their matching repository-relative paths.
   Confirm the report's source revision is the one you intended before applying anything. For example:

   ```sh
   cp artifacts/snapshots-123/candidates/packages/vgpu-api/tests/scene/primitives/__snapshots__/capsule-pbr-front.png packages/vgpu-api/tests/scene/primitives/__snapshots__/capsule-pbr-front.png
   ```

4. Review the git diff, commit and push the selected references, then run `pnpm snapshots:check`.
   A successful update job means rendering succeeded, **not** that the references were approved.

The artifact includes candidates only for changed/missing images. No architecture-specific duplicate
collection is committed. Never fix a backend change by broadly raising the comparison tolerance.

## Environment maintenance and bootstrap

The canonical Dockerfile pins the amd64 Node image by digest and the Debian package archive by date,
including Mesa and LLVM. The workspace lockfile pins Dawn and other JS dependencies. CI runs on native
`ubuntu-24.04` x64 and does not pass through a hardware GPU. Docs proofs, thumbnail checks and the CLI
probe also use this pinned image; their existing comparison policies are unchanged.

Pinning the OS and packages alone has not yet established byte-identical images across native x64
runners. CPU-capability overrides were tested and rejected: they did not remove cross-host variation.
CPU identity is recorded in artifacts to help diagnose this. The narrowly bounded RGB rounding policy
above was explicitly accepted after native captures differed by one RGB level with identical alpha.
Larger changes still require review; a new environment is not permission to increase these limits.

Docker alone is not a promise of cross-architecture pixel equality. Emulated x64 on a Mac is useful
for testing the harness, but its captures are not automatically promoted to canonical references.
Changing the environment pins is a deliberate change that requires native CI rendering and review.

When first introducing this workflow, push the branch and inspect its automatic PR check. Manual
dispatch depends on GitHub recognizing the workflow on the default branch; if unavailable during
bootstrap, download the automatic check's artifact instead. Check mode also captures all changed PNGs
as unapproved candidates, while still failing comparison. Review those native x64 candidates, commit
the selected references and rerun CI. No preliminary merge or bypass of a failed gate is necessary.

The retired `VGPU_WRITE_SNAPSHOTS=1` shortcut now fails with guidance instead of overwriting PNGs.
`VGPU_SNAPSHOT_MODE` is an internal CI setting (`check` or `update`), not a local developer toggle.
