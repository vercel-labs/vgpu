# Texture refactor verification — 2026-09-09

## Completed checks

- Workspace typecheck and build, docs TypeScript and production build.
- 620 documentation snippets; generated-doc drift and filename checks.
- Docs content schemas and internal links; example import boundary checks; all 333 examples API artifacts traced into all four routes.
- Atmosphere card and hero are byte-identical to the existing baselines. No thumbnail rebaseline.
- Local full suite on macOS/Node 24: 2822 passed, 174 skipped, 13 failures in the same four adapter/filesystem/API suites as before this refactor (`.context/texture-block3-tests-final.log`).
- Linux/Node 22.23.2 checks run in an isolated Docker container using the existing `vgpu-test:s2` runtime, with cached project source removed before copying the current checkout and installing the frozen lockfile. Host source/snapshots were not mounted writable. The 13 Mac-only failures pass there.
- Final identical focused suite: **193 passed on macOS/Metal**, **190 passed and 3 failed on Linux/OpenGL**. The three failures are exclusively the restricted-view sequence documented below. Logs: `.context/texture-block3-metal-final.log` and `.context/texture-block3-docker-focused-final.log`.

## Open gates

### Bundle budgets — approved and recalibrated

User explicitly approved recalibrating only affected budgets on 2026-09-09. Fresh package measurements
use the repository's `nextBudgetBytes` rounding helper (the same 512-byte convention as `--update`).
Only failing ceilings changed; passing budgets, tooling warning allowances, audience tiers and checks
are untouched. Preview baselines come from a fresh Node 22.23.2 / Next 16.3.2 production build.

| Budget / baseline | Previous bytes | Measured bytes | New bytes |
| --- | ---: | ---: | ---: |
| Core package | 35328 | 41481 | 41984 |
| Public entry | 39936 | 40322 | 40448 |
| effect-only fixture | 26624 | 26680 | 27136 |
| triangle-low-level fixture | 29696 | 29838 | 30208 |
| draw-recipe-box fixture | 30720 | 30972 | 31232 |
| full-root fixture | 39936 | 40427 | 40448 |
| glass-fractal preview baseline | 78160 | 83587 | 83587 |
| atmosphere preview baseline | 99230 | 106391 | 106391 |

`pnpm bundle-check` passes. Node/mock entry warnings remain within their existing 5% tooling allowance;
their ceilings were not raised. All 27 preview budget/isolation checks pass; the existing greater-of-2%-or-5-KiB
growth allowance and shared-host baseline are unchanged. No image baseline changes.
Evidence: `.context/texture-approved-budgets-after.log`, `.context/texture-approved-example-budgets-node22-after.log`,
`.context/texture-approved-docs-node22-build.log`.

### Dawn OpenGL restricted-view state

Linux GPU verification uses Dawn's compatibility/OpenGL software backend. Single-layer array sampling
initially failed because WebGPU inferred a 2D binding dimension. Native creation now explicitly sets
`textureBindingViewDimension: "2d-array"` for semantic arrays, and that test passes on this backend.
This follows the [WebGPU compatibility binding-dimension rule](https://github.com/gpuweb/gpuweb/blob/main/proposals/compatibility-mode.md#1-texture-view-dimension-may-be-specified).

A separate failure remains: after sampling a view restricted to mip 0, compute writes to another mip
return zeros on readback, without native validation errors. Reproduction bypasses vgpu entirely after
device initialization: raw texture, pipeline, bind group, compute/render passes and texture-to-buffer copy.

The native diagnostic writes half-float constants 1, 2, 3 at mips 0, 1, 2:

| Sequence | First component bits at mips 0 / 1 / 2 | Validation |
| --- | --- | --- |
| Compute/write/read, no intervening sample | 15360 / 16384 / 16896 | clean |
| Sample restricted mip view between writes | 15360 / 0 / 0 | clean |
| Sample full-chain view with explicit LOD between writes | 15360 / 16384 / 16896 | clean |

Repro: `.context/native-mip-diagnostic.mjs`; results: `.context/texture-native-mip-diagnostic.log`.
The regression remains enabled in `texture-read-selection-gpu.test.ts`; it is not skipped or weakened.
Positive upload/read tests and full-chain-sampling variants independently cover actual mip readback.
Metal passes the restricted-view sequence. No backend-specific behavior or silent workaround was added
to the public API. Resolving or accepting this backend limitation is a release decision, not a missing read-selection signature.

Further investigation found Dawn's own `ReadMipLevel0WriteMipLevel1` regression describing the same
state leak and linking Chromium bug 392121637, with OpenGL/GLES suppressed in the inspected revision:
[upstream regression](https://dawn.googlesource.com/dawn/+/a71d9dcd947b1e00d41b2b3df318d4e206d32a91/src/dawn/tests/end2end/StorageTextureTests.cpp).
This confirms the defect is known upstream; it is not evidence that a currently available prebuild fixes it.

#### Path 1: newer official upstream release — investigated, not adopted

On 2026-09-09, fresh npm registry and GitHub release queries identified official `webgpu@0.6.0`
(published August 28) as latest, newer than our pinned `0.4.0`. Downloaded the npm tarball without
running install scripts, outside the dependency tree. No package, lockfile, loader, release pin or
production binary changed.

- node-webgpu release commit: `d92a1a3542352221c0d00f76e6962ff9b6a7f452`.
- Its Dawn submodule: `55c03af2b97acd886d6d65bd345c214c4408ed40`.
- Candidate Linux ARM64 binary SHA-256: `48252ad19c5b7fefde123646fc777d728e15a09d9d6a42b741b0829ab0172225`.
- Tested in an isolated `vgpu-test:s2` container with Node 22.23.2, Debian glibc 2.41 and
  an explicitly selected OpenGL compatibility adapter. This tests behavior, not glibc 2.31 portability.
- A standalone raw-WebGPU probe loads the exact native module from `VGPU_DAWN_BINARY`, bypassing
  vgpu initialization and cached binary resolution. Both stock `0.4.0` and candidate `0.6.0` produce
  the same three rows in the diagnostic table above: restricted views still yield `15360 / 0 / 0`,
  with no validation error; both controls yield `15360 / 16384 / 16896`.

The upstream regression is still suppressed for OpenGL/GLES in both the release's Dawn revision and
the inspected September 9 main revision `02c346740b84072a1749488b5917b1b3a986b8f4`.
Inspection of the current OpenGL binding code and recent file history found no candidate fix to rebuild;
commit search for `392121637` found the original regression-test commit, not a fix.
This is source inspection of main, not a successful runtime test of a newly built main binary.

Sources: [official release](https://github.com/dawn-gpu/node-webgpu/releases/tag/v0.6.0),
[current upstream regression](https://github.com/google/dawn/blob/02c346740b84072a1749488b5917b1b3a986b8f4/src/dawn/tests/end2end/StorageTextureTests.cpp),
[current OpenGL bindings](https://github.com/google/dawn/blob/02c346740b84072a1749488b5917b1b3a986b8f4/src/dawn/native/opengl/CommandBufferGL.cpp).
Local evidence: `.context/dawn-upstream-arViBx/probe.mjs`, `baseline-0.4.0.log`, `candidate-0.6.0.log`.

After copying the current checkout into that container and installing the frozen lockfile, workspace
typecheck passed. The same focused project suite was run separately with explicit stock `0.4.0` and
candidate `0.6.0` native paths: **21 passed, 3 failed for each binary**. All 16 WGSL execution/guard/self-check
tests pass on both; the only failures are the three existing restricted-view GPU regressions (2D, array,
3D). Evidence: `setup.log`, `focused-0.4.0.log`, `focused-0.6.0.log` in the same local evidence directory.

Conclusion: upgrading to the latest official release does not resolve this gate. No custom Dawn patch,
test suppression or API workaround was introduced. A custom native fix remains an option, but the
subsequently authorized Vulkan trial below provides another route without patching Dawn.

#### Vulkan/Lavapipe trial — mip regression passes without a Dawn patch

User authorized an isolated Linux/Docker Vulkan trial on 2026-09-09. No default backend, dependency,
CI workflow, image baseline, tolerance or public API was changed.

Environment: existing `vgpu-test:s2` image, Linux ARM64, Node 22.23.2, Debian glibc 2.41.
Installed Debian `mesa-vulkan-drivers` 25.0.7-2+deb13u1 and `vulkan-tools` in the disposable container.
Explicitly selected `/usr/share/vulkan/icd.d/lvp_icd.json` through both `VK_ICD_FILENAMES` and
`VK_DRIVER_FILES`. The Vulkan driver reports a CPU device, llvmpipe / Mesa 25.0.7 / LLVM 19.1.7.
No host GPU passthrough, X11 or Wayland was needed for the Vulkan runs.

The raw diagnostic explicitly selects `backend=vulkan` and requests compatibility mode, matching the
feature level of the previous OpenGL test. It checks expected half-float values and validation errors,
and exits nonzero on a mismatch. All three sequences (including restricted views) return
`15360 / 16384 / 16896` with clean validation, using **both**:

- Stock npm `webgpu@0.4.0` Linux ARM64 binary, SHA-256
  `e9707e61234511ad2529d2a16ae4a6f74d608b8cdb2fb2b556361624326320a2`.
- Our published `dawn-v0.4.0-vgpu.1` portable binary, downloaded into `.context` and verified against
  the installer's pinned SHA-256 `1d78020a40e1d5291c1bf8349155487ccbef7e123753fd4a5bbb3fe19a9e4277`.

Workspace typecheck passes. Results:

| Run | Result |
| --- | --- |
| Focused texture/readback/lifecycle/WGSL suite, stock 0.4.0, explicit Vulkan flag | 109 passed |
| Full suite, stock 0.4.0, explicit Vulkan flag | 3000 passed, 6 skipped, 8 failed |
| Full suite, published portable 0.4.0, display-free automatic discovery | 3003 passed, 6 skipped, 5 failed |
| Exact CI Dawn GPU validation test selection, portable 0.4.0, `VGPU_VALIDATE=require` | 103 passed, 1 skipped |
| OpenGL control for the four failing snapshot files, same portable binary/container | 12 passed |

Three failures in the first full run were mock backend-selection tests observing the globally injected
`VGPU_DAWN_FLAGS=backend=vulkan`. Unsetting this override, as well as DISPLAY/WAYLAND_DISPLAY, lets
the existing adapter discover Vulkan and those tests pass without source changes.

The remaining five failures are existing snapshot comparisons: wireframe iso and side (60 and 14
mismatched pixels), and capsule, icosphere and torus batteries (first failing comparison: 1, 3 and 1
pixels). These are comparator counts, not a complete visual assessment of all frames in the batteries.
All are 256x256 comparisons against current references. They pass in the OpenGL control. No baselines
were regenerated, no tolerance loosened, and these differences have not yet been visually reviewed.

For a prepared Linux environment with the ICD path above and a verified binary at `/tmp/dawn-portable.node`,
the full-suite invocation was:

```sh
unset DISPLAY WAYLAND_DISPLAY VGPU_DAWN_FLAGS
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json
export VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json
export VGPU_DAWN_BINARY=/tmp/dawn-portable.node
export VGPU_DOCKER_TEST=1
pnpm exec vitest run
```

Evidence under `.context`: `native-vulkan-mip-probe.mjs`, `vulkan-info.log`, `vulkan-install.log`,
`vulkan-setup.log`, `vulkan-native-mip.log`, `vulkan-native-mip-portable.log`, `vulkan-focused.log`,
`vulkan-full.log`, `vulkan-full-portable.log`, `vulkan-ci-gpu.log`, `vulkan-snapshot-opengl-control.log`.
The disposable container has no host mounts; source and snapshots were copied, not mounted writable.

Conclusion: Vulkan is a verified way to run the new mip contract in this Linux ARM64 software environment
without updating or patching Dawn. It does not repair OpenGL for users who select that backend.
This is not a blanket portability/performance claim, nor a completed CI migration: CI runs x64, and its
separate snapshot CLI, docs render proofs and thumbnail-comparison steps were not migrated/tested here.
Next: choose CI backend coverage (for example Vulkan semantic tests alongside retained OpenGL image
references). Follow-up visual review and x64 execution evidence are recorded below.

#### Follow-up: visual assessment and Linux x64

Captured all 21 frames from the four affected snapshot files in another disposable ARM64 container.
`VGPU_WRITE_SNAPSHOTS=1` was used **only inside that unmounted container**, to collect complete batteries
instead of stopping on the first mismatch. Its successful capture run is not a passing comparison against
the repository's references. Copied captures to `.context/vulkan-visuals/`; host reference images are unchanged.

Compared decoded RGBA pixels against the original references using
`.context/compare-vulkan-visuals.mjs`; complete results are in `.context/vulkan-visual-metrics.jsonl`:

- 15 of the 21 frames have identical decoded pixels.
- Four primitive frames differ at six pixels total: capsule PBR iso (1), icosphere PBR side (3), torus
  normal-debug side (1), torus PBR iso (1). Every changed pixel differs by exactly one byte value in one
  RGB channel; alpha is unchanged. The last of these is ignored by the existing pixelmatch antialias
  classification, explaining why the earlier failing-test counts did not include it.
- Wireframe iso differs at 60 pixels, side at 14. All differences exchange background with a white line
  pixel, and every changed line pixel has a corresponding white pixel within one pixel (Chebyshev
  distance) in the other image. This is not small color-rounding noise; it is consistent with a difference
  in line coverage/rasterization. Visual inspection of both wireframe pairs shows the same box geometry.
- Also visually inspected the original/captured icosphere side pair. No visible shading/geometry change
  was apparent at native size; the three measured channel differences are one level out of 255.

This supports retaining the current exact OpenGL image comparisons during a Vulkan semantic-test rollout,
rather than broadly increasing a mismatch allowance. No reference updates or tolerance changes were made.

For x64, pulled the `linux/amd64` variant of `node:22-trixie-slim` (manifest digest
`sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284`) into a separate disposable
container, installed Mesa Vulkan 25.0.7 and copied the current checkout without host mounts. Fresh frozen
dependency install and workspace typecheck passed on Node 22.23.2. This is **x86_64 userspace under
emulation on the ARM Mac**, not a native GitHub runner, and its timings are not CI performance measurements.

- Used stock npm `webgpu@0.4.0`'s `linux-x64.dawn.node`, SHA-256
  `fbfe599055b469963e4c9bfc900a702843db962dcaba0799b3c81ae33fa43db1`.
- Vulkan adapter: Mesa software / llvmpipe LLVM 19.1.7, reported 256-bit SIMD. ICD pinned to
  `/usr/share/vulkan/icd.d/lvp_icd.json`, no display server or host GPU passthrough.
- Raw mip diagnostic: all three sequences pass, including restricted views, with clean validation.
- Same 25-file CI GPU validation selection as the ARM64 trial, with `VGPU_VALIDATE=require`:
  **103 passed, 1 skipped**. No test changes, timeout increases, reference updates or new skips.
- Logs: `.context/vulkan-x64-pull.log`, `vulkan-x64-install.log`, `vulkan-x64-setup.log`,
  `vulkan-x64-info.log`, `vulkan-x64-native-mip.log`, `vulkan-x64-ci-gpu.log`.

Recommendation (not yet applied): run semantic GPU validation with Vulkan/Lavapipe while retaining
OpenGL for existing pixel-reference jobs. Migrating all visual jobs/references to Vulkan is a separate
choice; the larger docs proof/thumbnail workflow still requires its own verification. The upstream
OpenGL limitation remains for users selecting that backend. CI configuration and production defaults
are unchanged, and a native x64 CI run remains necessary after any workflow change.

#### Adoption approved: Vulkan default and Docker/CI migration

After the preceding trials the user explicitly chose option B (Vulkan throughout Docker/CI), and also
requested Vulkan as the default for Node/Linux users. This supersedes the earlier recommendation to
keep OpenGL visual jobs. Implementation is now in the worktree:

- Linux defaults to explicit `backend=vulkan`, independent of display variables. Compatibility feature
  level, macOS/Windows defaults, browser behavior and explicit overrides are preserved.
- The installed CPU-renderer fallback explicitly stays on Vulkan on Linux. Missing Vulkan produces
  the existing actionable error, not an implicit OpenGL retry or driver download.
- Both test Dockerfiles install Vulkan/lavapipe and pin the ICD; Xvfb was removed from the regular
  Docker/CI commands. The dedicated OpenGL doctor fixture now opts in explicitly.
- Six reviewed 256x256 reference PNGs were regenerated on Vulkan ARM64. They are byte-identical to
  the earlier inspected trial captures. No comparison tolerances changed.
- CLI `snapshot` and the real `doctor` probe exposed two missed texture-refactor call sites, still using
  `Target.read()`. Both now use `target.color.read({ mipLevel: 0, region: "all" })`, with three new mock
  contract/cleanup tests plus real command verification. CI now executes both real CLI commands.
- Documentation, migration notes, doctor display diagnostics and a minor adapter changeset were added.
  Dawn remains 0.4.0. No commit, push, remote workflow dispatch or release was performed.

Verification so far:

- Built the actual modified dev Dockerfile for ARM64 and x64; frozen installs/build/typecheck passed.
- ARM64 full suite after reference migration: **3013 passed, 7 skipped** (before the three newly added
  CLI readback tests). Final focused adapter/doctor/tooling suite: **30 passed, 1 skipped**, including
  the final env-isolation changes and all three CLI readback tests.
- Real `snapshot --ci` matches on both architectures; real `doctor` reports healthy CPU rendering on both.
- Final x64 functional GPU/adapter selection with one worker: **122 passed, 2 skipped** across 26
  files (`.context/vulkan-adopt-functional-x64.log`). This excludes the architecture-sensitive visual
  batteries; it is not a replacement for a green full suite.
- A real missing-ICD run with DISPLAY set reports `VGPU-NODE-NO-ADAPTER` with `backend=vulkan` and
  installation instructions. No OpenGL retry occurs.
- All **27 docs proofs** and **54 card/hero thumbnail comparisons** pass on Vulkan ARM64 using existing
  tolerances. No docs thumbnails were rebaselined by this migration; atmosphere differs by about 0.109%
  / 0.108%, within the existing 2% allowance.
- Host Node 22 static checks, 620 snippets and bundle budgets pass (unchanged existing tooling warnings).
  CI workflow passes actionlint 1.7.12. That older checker rejects the pre-existing `queue: max` key in
  release.yml; only its explanatory Xvfb comment changed here, not that concurrency configuration.

Logs: `.context/vulkan-adopt-build-arm64.log`, `vulkan-adopt-build-x64.log`, `vulkan-adopt-setup-arm64.log`,
`vulkan-adopt-setup-x64.log`, `vulkan-adopt-full-arm64-after.log`, `vulkan-adopt-final-focused-arm64.log`,
`vulkan-adopt-proofs-arm64.log`, `vulkan-adopt-thumbs-arm64.log`, `vulkan-adopt-snapshot-cli-*-after.log`,
`vulkan-adopt-doctor-*.json`, `vulkan-adopt-no-driver.log`, `vulkan-adopt-docs-check.log`,
`vulkan-adopt-host-build-budgets.log`, `vulkan-adopt-ci-actionlint.log`.

**Architecture-reference investigation (decision subsequently resolved below):** the full emulated x64 run against the original shared references
reports eight snapshot test failures, three timeouts and two worker RPC timeout errors under load.
These are not a green x64 full-suite result. After collecting complete x64 batteries in a disposable
container (not publishing them), 34 frames differ from the current shared references, all by at most
one byte value per channel: 30 primitive frames and four merge-by-distance frames. Metrics:
`.context/vulkan-adopt-x64-pixel-metrics.jsonl`; captures: `.context/vulkan-adopt-snapshots-x64/`.
The x64 capture run succeeds for all 55 tests, but it runs in write mode and is **not** a validation of
the committed references. Initially proposed architecture-specific references or a canonical ARM64
visual job. The user instead selected one canonical native x64 CI environment, as recorded below.
No tolerances or test timeouts were increased.

Focused serial retries under x64 emulation still time out in the pure-JavaScript simplex crack detector
(20 passed, 1 timed out, 1 worker RPC timeout) and the prism DPR rollback test (the other retried prism
test passed). Logs: `.context/vulkan-adopt-x64-simplex-recheck.log` and
`.context/vulkan-adopt-x64-timeout-recheck.log`. These remain unresolved checks pending native x64
verification; they were not skipped or assigned larger timeouts.

An isolated `LP_NATIVE_VECTOR_WIDTH=128` x64 experiment crashed with a native heap error under emulation;
it was discarded and is not present in any Dockerfile, runtime default or CI setting. Native x64 GitHub
CI is still needed to validate the selected image-reference policy. Do not treat emulation timings as benchmarks.

#### Canonical native x64 visual workflow — implementation

User approved one shared baseline collection generated and compared in CI, not architecture variants.
Implemented a reusable/manual `snapshots.yml` workflow on native `ubuntu-24.04` x64. Its Dockerfile pins
the amd64 Node 22.23.2 manifest and the Debian archive at `20260901T000000Z`, including Mesa
`25.0.7-2+deb13u1` and LLVM 19.1.7. The existing Docker GPU/docs job uses the same pinned image.

- `pnpm snapshots:check` / `pnpm snapshots:update` require clean, committed and pushed code. They
  dispatch the dedicated workflow, correlate by request ID and exact HEAD SHA, wait, and download
  reports even after comparison failure. They never commit, push or apply references.
- Primitive, inspect and edit snapshot batteries are separate from `VGPU_DOCKER_TEST` functional
  coverage. Ordinary local tests do not compare architecture-sensitive images. Explicit visual mode
  rejects noncanonical platform/backend/ICD settings; the old write shortcut fails with guidance.
- A shared oracle compares decoded RGBA bytes exactly (including antialiased pixels). Earlier
  primitive/inspect comparators used pixelmatch's antialias exclusion; the new oracle does not loosen
  thresholds. It publishes before/actual/diff, source/environment metadata, hashes and unapproved
  candidates, never overwriting committed PNGs. Soft assertions collect the entire battery but still
  make check mode fail. Update mode must still pass all semantic/render assertions.
- Automatic PR checks also publish candidates on mismatch, allowing bootstrap review before manual
  dispatch is available on the default branch. Candidate generation has a distinct job name and does
  not impersonate a successful visual-verification check. The regular CI trigger/gates remain intact.
- Contributor workflow: `docs/visual-snapshots.md`; decision: `texture-api-decisions.md`.

Local verification: 13 new harness/dispatch tests plus the production-authorization suite pass
(56 tests total), with mocked GitHub commands (no remote run). The production gate explicitly requires
`visual-snapshots / Verify visual snapshots`, with a regression test rejecting candidate-generation
success as a substitute. Confirm the composed job name on the first native CI run.
Workspace typecheck, generated-doc drift, filename checks and actionlint for both workflows pass.
The actual pinned amd64 Dockerfile builds; frozen installation and workspace build pass under local
x64 emulation. All 620 documentation snippets compile. No additional PNG baselines have been adopted;
native x64 CI regeneration remains necessary.

End-to-end harness verification in an isolated container with **no host mounts**, under x64 emulation:

- Check collected 237 image reports, including all 34 differing frames, and correctly failed six
  batteries (52 tests passed, 6 failed, 2 existing headline-fixture skips). Differences remain at most
  one channel level. Report: `.context/snapshots-harness-check/index.html`.
- Update passed 58 tests with the same two existing skips, generated exactly 34 candidates and kept
  every original baseline hash unchanged. Report: `.context/snapshots-harness-update/index.html`.
- After applying those candidates **only inside the disposable container**, check passed 58 tests
  with the same two skips and all 237 images matched. Report: `.context/snapshots-harness-recheck/index.html`;
  log: `.context/snapshots-harness-recheck.log`. No container-generated PNGs were copied to repository
  baseline paths. The final report identifies local execution as not native CI evidence.
- Functional GPU selection without visual mode passed 12 tests and skipped only the capsule image
  comparison, demonstrating that the mip/readback and lifecycle GPU tests remain enabled separately.
- The real `pnpm snapshots:check` preflight rejected this dirty checkout without dispatching anything.

Logs: `.context/snapshots-canonical-check.log`, `snapshots-canonical-update.log`,
`snapshots-functional-separation.log`, `snapshots-dirty-preflight.log`, `snapshots-final-checks.log`,
`snapshots-docs-final.log`. These are harness tests, not native CI acceptance of the references.

Logs: `.context/snapshots-canonical-build.log`, `snapshots-canonical-setup.log`,
`snapshots-local-tests.log`, `snapshots-unit-final.log`, `snapshots-static-tests.log`,
`snapshots-typecheck.log`, `snapshots-actionlint.log`.

### Existing WGSL test — stale expectation corrected

`identifier-minify.ts` deliberately preserves same-named shadowed declarations as a safety guard for
issue #251; `minify-local-guard.test.ts` explicitly tests that contract. The GPU execution test contradicted
it by requiring `long_value` to disappear. Its assertion now requires all four preserved occurrences,
while retaining GPU comparison of baseline/minified execution against `[13, 43]` and shortening assertions
for unambiguous locals/helpers. No minifier behavior was changed, no test skipped, and the assertion was
not simply removed. The six GPU execution tests plus ten safety-guard/self-check tests pass on Metal.
Evidence: `.context/texture-wgsl-gate.log`. The same 16 tests now also pass on Linux/OpenGL with both
stock Dawn 0.4.0 and candidate 0.6.0 (path-1 logs above). A final full Linux rerun is still needed with
the backend resolution.

### PR integration

PR #413 targets `canary`. The approved implementation was committed as `588a94e7`; current canary
(`99f26342`) was integrated in `5c483987` and pushed without rewriting history or renaming the branch.
Resolved the example-budget conflict by retaining both Atmosphere and upstream TypeGPU Liquid Glass,
and regenerated the conflicting docs manifest from the merged source. Migrated upstream's new prism
readback test rather than dropping it. No release or merge of the PR was performed.

#### Native reference review

[CI run 34384558238](https://github.com/vercel-labs/vgpu/actions/runs/34384558238) rendered the
237-image suite on native Ubuntu x64. Artifact revision `4d5907b18d99077a8a65b09fc108b9162e952dbb`
is GitHub's merge commit; its tree `ec2266cf3e9be87b905657ba5c429b531c224aa5` exactly matches
branch revision `5c483987`. Dockerfile/lockfile hashes and every baseline hash match the checkout.
The actual job name is `visual-snapshots / Verify visual snapshots`, confirming the production gate.

- 32 primitive images differ, all by at most **one channel level**, independently rechecked from
  decoded PNG bytes. Inspect and edit images match. This is not the same set as the 34 emulated frames.
- Visually inspected native before/after pairs for icosahedron PBR side (the largest changed patch),
  capsule PBR iso and torus normal-debug side; no apparent shape, coverage or lighting regression.
- Only those 32 hash-verified native candidates were adopted. No tolerance changes, architecture
  duplicates or emulated references were added.
- The first native run also exposed two integration omissions: the new upstream ray-footprint test
  used `Target.readFloats()` and the example corpus count remained 27 after combining two new examples.
  Migrated the test to explicit attachment reads and enabled it in native GPU CI; count is now 28.
  Existing native fast-suite tests otherwise passed (2861 passed, one catalog assertion failed),
  including the tests that timed out under emulation.

Native artifacts/logs: `.context/native-snapshots-34384558238/`,
`.context/native-snapshots-34384558238.log`, `.context/native-test-fast.log`,
`.context/native-docs-build.log`, `.context/native-docs-parity.log`.

Final gate: all required checks must pass on the latest PR revision after the native references and
integration fixes. The live PR checks are authoritative for merge readiness; candidate generation or
old green runs are not substitutes. Vulkan adoption and Linux defaults are done.

The second native run (`34385008080`) exposed CPU-dependent visual output despite identical pinned
packages: 36 images differed by at most one channel level, and all 237 captures matched the earlier
emulated run. The first reference adoption therefore did not establish a stable oracle. The visual
job now disables Mesa's CPU-specific SIMD paths (`nosse`) and fixes its vector width to 128; this does not affect library
defaults or functional GPU jobs. Native repeated-capture verification and reference review remain
required before calling the snapshot migration complete. CPU identity is now included in artifacts.
The same run found one lost documentation anchor, restored with an explicit replacement explanation.
An intermediate SSE2-only cap still produced host-dependent output (native run `34385630231`);
Mesa's explicit approximate SIMD math paths must also be disabled. Local `nosse` rendering succeeds.
