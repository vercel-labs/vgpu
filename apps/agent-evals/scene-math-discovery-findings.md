# Optional math skill: quaternion discovery pilot

On 2026-09-30, two fresh Sonnet 5 sessions completed `scene-quaternion-keyframes`, with two turns
each. Both produced correct outputs. Neither loaded the available vgpu skill, installed `math`,
or used a numerical dependency for interpolation. Both wrote their own spherical quaternion
interpolation and used vgpu's scene transform/camera helpers and explicit draw uniforms.

This is a small, single-arm observation of **package choice with the skill available**, not an
A/B estimate of the recommendation's effectiveness. Package choice was never
a correctness gate. The [portable results](scene-math-discovery-results.json) contain hashes,
per-turn checks, dependency evidence, costs and the excluded infrastructure attempt.

## Change and question

At pilot revision `b6ec97a3`, the public vgpu skill presented pmndrs/math as an optional
application dependency for quaternion interpolation, spatial queries, springs, easing, noise and
inverse kinematics. It prefers a suitable existing dependency, points to the installed CLI's
interoperability guide, and keeps transform ownership and GPU publication explicit. No vgpu
runtime or peer dependency was added. This guidance now lives in the linked
[scene reference](../../skills/vgpu/scene.md).

The new [eval contract](scene-evals.md#scene-quaternion-keyframes) asks for a rotating body with
three colored markers, constant-angular-speed interpolation and equivalent quaternion signs.
Turn 2 adds times outside the keyframe range, which must hold the boundary orientation. Neither
prompt nor seed names a math library or its APIs. `math` is absent from the initial template;
`wgpu-matrix@3.4.2` remains available through vgpu. Correct handwritten and library solutions are
accepted equally.

## Eligible results

| Submission | Correct stages | Skill loaded | math installed/used | Numerical source | Docs calls | Generation cost |
| --- | --- | --- | --- | --- | --- | --- |
| `code-99110379` | 2/2 | No | No / No | Handwritten slerp | 16 | $1.6014286 |
| `code-14549360` | 2/2 | No | No / No | Handwritten slerp | 20 | $1.6881941 |

All four stages passed all four gates: **16/16 assertions over 40 frames**. Each gate used a
fresh copy of submitted source, independently calculated world matrices and decoded PNG output.
All four reviewed source snapshots match the executed manifests and correlated turn receipts.
Neither session requested clarification or issued an observed package-install command. `math`
remained absent after both turns in both sessions.

The skill was materialized outside the graded workspace with the exact public-file hash in both
sessions. Neither invoked `load_skill`; transcript review also found no alternative reading of
the skill through `read_file` or shell commands. The first session had no observed math-guide
exposure. In the second, `/guides/scene-math.docs.md` appeared in a `docs find "geometry attributes"`
result at step 21, but the agent did not open the guide. Surfacing its path is not reading its body.

A specialist read both stage snapshots of each eligible submission with scores and transcripts
withheld. Both reviews used the same specialist session. Both submissions use application-owned
interpolation plus `composeMatrix`,
`multiplyMatrices`, `orthographic` and `viewMatrices` from `vgpu/scene`. Both explicitly upload model
and camera uniforms and render three draws; neither uses `instances` or imports `wgpu-matrix`.
For only three markers, separate draws are a valid choice, not a scalability result. Both already
clamped times in stage 1; their stage-2 changes are comments only. Passing turn 2 therefore does
not demonstrate implementation adaptation.

## Infrastructure attempt, retained separately

An earlier attempt, `wrun_01M3STJX2MVBJ4RFVJTZEDH6KZ`, passed both raw correctness stages and loaded
the skill in turn 1. The runner nevertheless stopped before its second planned session because
`initialDependencySnapshot` was null: the eval copied that field before Eve lazily built the cold
sandbox template. The correlated template receipt itself contained the evidence.

We retained the original plan, ledger, transcript and source, fixed the receipt timing, added a
cold-template regression test, and ran two new sessions under revision
`scene-math-discovery-pilot-v2`. The earlier attempt is **excluded from the cohort and its semantic
source review**, irrespective of its passing output. It is a harness bookkeeping failure, not an
agent failure. Its $2.0526306 generation cost remains in the record: **$3.2896227 for the eligible
cohort; $5.3422533 across all three attempts**. These figures exclude implementation/review agents
and compute.

## Conclusions and next experiments

1. The scenario exercises numerical work beyond vgpu's scene conveniences, and correct solutions
   can keep that work outside vgpu without requiring a new runtime dependency.
2. This pilot did **not** produce task-driven installation of math. The eligible agents did not
   consume the skill recommendation, so these runs cannot test whether reading it changes their
   dependency choice. In these two sessions, neither the optional skill nor the CLI interoperability
   guide was read, even though both were available and one search surfaced the guide's path.
3. Slerp is a small, familiar kernel that both agents implemented correctly on the measured
   inputs. That is a valid outcome, not evidence that they needed to install a library.
4. A next experiment should separate skill consumption from package choice: explicitly ask the
   agent to follow the vgpu skill, without naming math, and compare the same task with the
   skill-available condition. A separate spring, spatial-query or IK task could make a numerical
   package's value larger. Those are follow-up hypotheses, not results of this pilot.

Do not infer a general adoption rate, model ranking, skill effect, or performance improvement from
two sessions. The math and wgpu-matrix native positive controls establish that the grader accepts
those implementations; they are not agent adoption observations. No generated submission was
patched or retried to obtain a passing result.

## Validation and reproducibility

- 68 Node 24 eval tests and app TypeScript passed; 10 pilot-runner tests passed.
- All 28 native control assessments passed: four correct variants across both turns plus the
  specified numerical and rendering faults rejected at their intended gates.
- Eve 0.29.5 skill-isolation checks preserve old task prompts/tools, verify the actual
  frontmatter-stripped body and reject mutated content. Live sessions separately verify actual
  sandbox materialization.
- Runtime packages: Git `b6ec97a379e238cb37f492e30a73cdcad03e908d`, source key
  `6122d243c06747f2`; skill commit is the same. Uncommitted eval harness files are identified by
  per-file hashes in the results; that Git SHA alone does not identify the harness.
- Model: `anthropic/claude-sonnet-5`, through Vercel project OIDC. Docker image:
  `ghcr.io/vercel/eve@sha256:de79f9a495add7cd1691e3496afc1c3227b0846f9ae0b26126f120c91af3445c`.
- Both fresh sandbox sessions reused the template built at `2026-09-30T18:52:49.410Z`. Initial
  absence is evidence from that template build, not a new per-session package scan. Per-turn
  dependency snapshots are separate.
- Local raw artifacts/reviews are gitignored under `.context/work/scene-math-discovery{,-r2}/`
  and `.work/snapshots/` beneath this app. Session IDs and source hashes are preserved in the
  portable JSON. The numerical/pixel gates do not attest exact marker shape, GPU execution
  provenance, or hardware performance.

Re-run the scenario on the current checkout with Node 24:

```bash
pnpm agent-evals --task scene-quaternion-keyframes --max-concurrency 1
```

Use the documented project OIDC setup and archive new results separately; a new model run is not
expected to reproduce the same generated source.
