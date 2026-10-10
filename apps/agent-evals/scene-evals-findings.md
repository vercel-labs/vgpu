# Scene evals: findings

Findings for the contract revision `scene-evals-v1`. Read [scene-evals.md](scene-evals.md) first.
Each entry below is an observation of one run on one branch. It is not a benchmark result.

**Status:**

- Native controls completed on the host and the pinned Linux/Mesa image. All 12 positive stage
  runs passed and all 22 deliberately broken runs were rejected by their intended checks.
- All three project-OIDC pilots completed: six turns, 20/20 gates passed.
- Correctness and scene-helper adoption are recorded separately.

## Native controls

A control run is valid only when `scene-controls.mjs` exits with `0`. Record each run with the
path to its `summary.json`.

| Task | Backend | Run directory | Exit | Positives | Negatives rejected by intended check | Closest positive margin | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `scene-robot-arm` | host | `2026-09-25T17-57-05.933Z-e1d891d5/scene-robot-arm` | 0 | 2/2 | 3/3 | containment +0.01 | matrix error 0; pixel/tip/containment ratios 1 |
| `scene-robot-arm` | docker (Mesa) | `2026-09-25T18-00-42.756Z-b9a9c627/scene-robot-arm` | 0 | 2/2 | 3/3 | containment +0.01 | same positive metrics as host |
| `scene-shader-bindings` | host | `2026-09-25T17-59-43.050Z-d3270c6b/scene-shader-bindings` | 0 | 2/2 | 3/3 | containment +0.01 | matrix error 0; color/containment ratios 1 |
| `scene-shader-bindings` | docker (Mesa) | `2026-09-25T18-02-25.052Z-e7494262/scene-shader-bindings` | 0 | 2/2 | 3/3 | containment +0.01 | same positive metrics as host |
| `scene-warehouse` | host | `2026-09-25T17-59-44.806Z-a4a2cfaf/scene-warehouse` | 0 | 2/2 | 5/5 | coverage 17 px below max | every ID covered 64 px; every center sample matched |
| `scene-warehouse` | docker (Mesa) | `2026-09-25T18-03-17.969Z-e392a5a1/scene-warehouse` | 0 | 2/2 | 5/5 | coverage 17 px below max | same positive metrics as host |

Run directories are below `apps/agent-evals/.work/scene-controls/`. Host results are also
summarized in `.context/work/scene-evals/runs/native-control-results.json`. Host controls used
Node 24.14.0 on Darwin arm64. Docker controls used Node 24.20.0 on Linux arm64 and image
`ghcr.io/vercel/eve@sha256:de79f9a495add7cd1691e3496afc1c3227b0846f9ae0b26126f120c91af3445c`.

The warehouse negatives rejected on the specified frames: cached count on frames 3 and 4, and
missed publication on frame 3 only. The stale-image robot and stale-binding shader controls kept
their numeric state checks passing while their pixel checks failed.

Two earlier infrastructure attempts are retained rather than folded into correctness results: a
worker-host context with no WebGPU adapter and a first Docker install that exceeded its original
180-second setup envelope while downloading `webgpu`. The normal host context and the bounded
600-second Docker retry both completed successfully; native probe and render deadlines were not
changed.

Environment commands, doctor results, runtimes and image identity are retained in each control
run's `environment.json`.

Both backends passed with margin and every fault was rejected by its intended check. No acceptance
threshold was weakened during calibration.

## Pilot results — 2026-09-25

One independent session per task, two sequential turns per session, using
`anthropic/claude-sonnet-5` through the `vgpu` project's Vercel OIDC route. No judge model was
used. Each task has a 20-minute budget. These are three observations, not a model ranking or an
estimate of success probability.

| Task | Initial batch | Second batch | Checks | Elapsed | Reported model cost |
| --- | --- | --- | --- | --- | --- |
| Robot arm | pass | pass | 6/6 | 9m 50s | $2.1612341 |
| Supplied shader | pass | pass | 8/8 | 5m 53s | $1.1032352 |
| Warehouse | pass | pass | 6/6 | 11m 9s | $2.3257465 |

Total reported pilot model cost: **$5.5902158**. Total elapsed across the three serial commands:
**26m 52s**. There were 171 model steps (robot 63, shader 42, warehouse 66).

Elapsed time includes sandbox setup and agent work. Costs sum unique `step.completed` usage
records; they exclude specialist development/review runs and the separate environment smoke.
Gateway generation IDs are retained in the raw event streams and local summaries.

### Robot: correct output, partial helper adoption

Both stages passed independent joint-matrix and image checks. The returned world matrices had
zero error against the scalar oracle; sampled colors and containment matched fully. The final
source uses real `vgpu/node` draws, target readback and PNG encoding. It uses `box`, `orthographic`
and `viewMatrices`, but writes its own translation, rotation, scale and multiplication helpers.
The source issues five draws per frame; no runtime draw-counter instrumentation was used.

The first turn used 21 shell commands containing documentation requests. A combined request for six scene
reference pages returned `[stdout truncated: showing last 1552 of 4249 lines]`. The returned
text omitted the dedicated group/hierarchy/transform sections, so it would be wrong to say the
agent read those APIs in full and rejected them. The delivered instances page still contained
`group`/`bindWorld` examples and a hierarchy pointer; the delivered draws guide also linked to
the scene-composition guide, which the robot agent did not open. It also tried a nonexistent `/vgpu/node.docs.md` path,
then inspected installed exports. The follow-up used no documentation commands and preserved
correct parent/joint edits and return-to-origin behavior.

This is evidence of incomplete helper adoption, not an API correctness failure. The explicit
transform formulas and matrix-output contract may also encourage handwritten math.

### Shader: explicit bindings and instance utilities worked

Both stages passed protocol, unchanged-fixture, camera-matrix and pixel checks. Maximum matrix
error was approximately `1.02e-8`; sampled colors and containment matched fully.

Semantic source review confirms that the renderer reads `integration.wgsl` at runtime and passes
that source to `draw`. It uses `composeMatrix`, `instances`, `instanceGeometry`, `orthographic`
and `viewMatrices`. It publishes the static three-object collection once and submits one
instanced draw per frame. The shader keeps `style` at group 0 and `viewState` at group 1; the
application explicitly sets `style` and uploads `viewState.viewProjection` for each frame.
The renderer uses actual GPU readback. The source stayed identical between turns: its initial
frame loop already supported camera changes and returning to the original camera.

The agent read the scene-composition guide in two bounded sections. That coincided with broader
helper adoption, but the task and supplied shader differ from the robot task; this comparison
cannot establish that the guide caused the difference. The supplied world-column/tint layout
also matches `instanceGeometry`, favoring that implementation.

### What the second turns establish

Native host reruns of the preserved robot and shader **first-turn source** against their
second-turn inputs both pass. The robot follow-up added omitted-field carry-forward behavior
that is unused by the fully specified graded inputs; the shader source did not change. These
runs establish correctness on additional batches, not adaptation to a previously unsupported
requirement. The controls are saved under
`.context/work/scene-evals/runs/turn-one-on-two/`, including health probes and fresh output.

### Warehouse

Both stages passed protocol, state and pixel checks. The initial frame matched all 20,736 center
samples; the four-frame second batch matched all 82,908 samples. Each visible ID covered exactly
64 pixels. Deletions, movement and recoloring remained consistent across the color and ID passes.

The source uses `orthographic` and `viewMatrices`, but builds cube vertices and interleaved
translation/tint/app-ID buffers itself. It keys persistent application state by `appId`, sorts
live items, and recreates geometry and two draw objects per frame. It renders through real
`vgpu/node` draws and reads both targets back. It uses neither `instances` nor `instanceGeometry`.
Two instanced draws per frame are visible in source; performance and allocation costs were not
benchmarked.

Its first-turn source fails the second-turn control at the first `recolor` operation, with a
healthy native probe. The final source implements the documented operation names and passes.
This demonstrates a narrow operation-schema adaptation: the renderer and buffer strategy did
not change. The initial source had already guessed several operation types, including move and
delete, so this is not evidence of inventing the whole editing architecture on turn 2.

The agent searched and pulled `instanced-rendering` from the live example catalog at revision
`6fa27bb458ffc3f498727090f09dce3fe5faabb43689fd669d633a2a23dc36bb` (aggregate SHA-256
`e44a6bc12074d03d1d73553224fd2203729935a078d033108c93e67da7b0f3bb`). That is a separate source
from the branch-packed docs. The transcript establishes its use, not that the example caused
any later bug or implementation choice.

A concrete diagnostic friction appeared before the first successful submission. Native pipeline
errors showed `VGPU-COMPILE-FAILED`, a generic fix, and `cause: GPUValidationError {}` in the
visible output. The agent used `npx vgpu check`, then several small renderer probes. A probe
with `@interpolate(flat)` logged invalid pipelines; changing it to `@interpolate(flat, either)`
removed those errors, and the final renderer uses that form. This observed recovery sequence is
a useful regression/eval candidate; it does not establish a universal WGSL rule or prove the
underlying library defect without an isolated reproduction.

## Evidence and reproducibility

All pilots install six branch-packed packages at version `0.5.0`; packed commit
`8cc5913d293a50495f9ace3361dc3b8f58e038dc`, package source key `717900ad1e0ea850`.
The same pinned Docker image used by the controls runs Linux arm64 with Mesa llvmpipe.
Each task receives only its contract, package seed and optional integration shader. No oracle or
reference renderer is included in the seed. The warehouse also consumed the live example
revision recorded above, an uncontrolled discovery input separate from the packed build.

| Task | Eve result directory under `.eve/evals/` | Session |
| --- | --- | --- |
| Robot | `2026-09-25T18-12-15` | `wrun_01M3CVQ715NAV0G7GXXRYMVHBG` |
| Shader | `2026-09-25T18-22-38` | `wrun_01M3CWHEC282BJMEX8BKN1E952` |
| Warehouse | `2026-09-25T18-37-52` | `wrun_01M3CX3PFKWGVE1DYRBEBG6SD6` |

Paths above are relative to `apps/agent-evals/`. Each result directory retains the eval JSON and
`.events.ndjson`. Under `.work/snapshots/<session>/`, `scene-run.json` indexes immutable
`turns/<turnId>/<eventId>/` archives with source, exact inputs, fresh outputs, verdicts and grades.
Local analysis summaries and source-review notes are under `.context/work/scene-evals/runs/`.
Raw artifacts are gitignored; the checked-in tasks and commands reproduce the experiment.
First-turn-source controls ran on the macOS host, while the paid pilots ran on pinned Linux.
The warehouse control failed on the explicit unsupported operation, after a healthy GPU probe;
repeat these controls on the pinned image before making broader cross-platform claims.
The older robot run did not record full per-run provenance; its package/image identity comes
from the shared `pilot-provenance.json` and launcher log. Later runs include these fields.

The robot pilot preceded integration-review fixes for checking sandbox command exits and
per-part/per-frame grading. Its saved outputs were regraded with the stricter grader, and both
turns still passed; all ten native robot control outputs also retained their expected outcomes.
Original grades remain intact. The shader pilot used the corrected exit handling. A later
manifest-pipeline fix concerns evidence integrity, not scene scoring; the warehouse ran after
that fix. A final regression also classifies a missing harness execution record as infrastructure
failure; none of the pilots hit that path. No acceptance threshold
was relaxed to make a pilot pass.

## Conclusions

1. **The tested rendering paths work.** One Sonnet 5 session per task produced correct GPU
   outputs, including explicit supplied-shader bindings and stable IDs for 2,304 objects.
2. **Correct output does not imply adoption of the new scene utilities.** All three used camera
   helpers, but only the supplied-shader task used the instance collection/bridge. No agent used
   the hierarchy utilities. Handwritten alternatives were valid and were not penalized.
3. **Investigate discovery and error feedback before drawing API-design conclusions.** The
   robot lost requested reference sections to truncation, and the warehouse recovered from
   generic pipeline errors through repeated probes. The contracts and shader fixture also favor
   different implementations, so these runs do not isolate the cause of helper adoption.
4. **The second-turn design needs strengthening for adaptation claims.** Robot and shader
   first-turn programs already pass the later inputs; warehouse needed only operation handling
   changes. Keep correctness checks and measure genuinely new capabilities separately.

## Limitations and next experiments

- This pilot tests flat-color, orthographic box scenes. It does not establish performance,
  photorealism, PBR composition, ECS/physics integration, or broad model reliability.
- Source inspection supports the reported GPU/API use; the harness does not attest GPU
  provenance against malicious submissions. Native controls validate the renderer/grader path;
  transport failure tests and live pilots cover different parts of the harness.
- Correct manual implementations can pass. Add a separate integration task that explicitly
  exercises hierarchy utilities if direct coverage of those APIs is required.
- Reserve a genuinely new capability for turn 2 in a future contract revision, and require a
  first-turn-source control to establish that a change was needed. Keep these v1 results intact.
- Test a short scene recipe against the existing discovery path in repeated, paired runs.
  Record whether relevant docs actually reach the agent, rather than counting commands alone.
- Prioritize a native reproduction and error-recovery task for the warehouse pipeline failure,
  then cover incorrect bindings and missed publication. Check that useful native error details
  reach the agent; the current suite does not isolate each error path.

## Validation and delivery

Subharness was upgraded from `0.0.4` to registry latest `0.0.5`, and the new `eval-designer`
specialist uses Claude Opus 5.5 with the repository's project-OIDC routing. The specialist
independently audited the design and pilot conclusions.

Validation: 31 standalone eval tests; app and repository TypeScript checks; build and branch
packing; fast suite 1,255 passed / 77 skipped; migration and filename checks; and all 34 native
control cases. Grader revisions were checked against retained native outputs. The separate
`view-image-smoke` environment test passed 4/4 gates and is not counted as a scene result.

Each successful Eve command emitted a queue HTTP 503/socket-hang-up warning during shutdown,
after its verdict and artifacts were saved; all three exited 0. Keep this runtime noise separate
from scene correctness. The initial npm-cache permission failure, worker GPU-adapter failure,
and Docker dependency-install timeout are retained as infrastructure attempts.

No published scene API was changed by the eval work. Release impact is none: this is private
eval tooling and repository documentation. Source implementation commit: `1105cc24`.
