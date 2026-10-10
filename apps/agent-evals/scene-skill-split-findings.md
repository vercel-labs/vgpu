# Scene skill split: discovery pilot

Two fresh Sonnet 5 sessions passed all four stages, but neither loaded the public vgpu skill or
read its new `scene.md` reference. Both implemented quaternion interpolation themselves. One
session read the CLI's separate math interoperability guide; neither installed or used `math`.
The split reference was delivered correctly, but this pilot did not exercise its discovery path.

## Setup and evidence

Run on 2026-10-01 after the skill split, using `scene-quaternion-keyframes-v1`, two serial fresh
sessions and two turns per session. The task still says `Use npx vgpu`; it does not name `math`,
`scene.md`, or require skill loading. Library choice is observational, never a grading gate.

The model was `anthropic/claude-sonnet-5`, authenticated through the vgpu project's Vercel OIDC.
Eve was 0.29.5, with the same Docker image digest as the earlier pilot. Packages came from the
current working tree at HEAD `c5837388` plus the uncommitted skill split, identified by source key
`d3c1b503511e66dc` and frozen file/tarball hashes. HEAD alone does not identify this tested change.
The [results JSON](scene-skill-split-results.json) records those identities, session IDs, receipts,
source hashes, tool evidence and limitations.

PR preparation later removed one trailing blank line from `scene.md`, made host evidence paths
repository-relative, and edited reporting/packaging checks. Evaluation hashes retain the exact
frozen inputs; they do not identify the final PR tree. The report records the published reference
hash separately. No paid cohort was rerun for these editorial changes.

The 28 native control cases passed their expected assessments. Both production sessions then
verified exact `SKILL.md` and `scene.md` materialization outside the graded workspace, plus
`math` absence before execution. All four authored-source snapshots matched the bytes actually
executed by the verifier. There were no discarded or retried sessions in this cohort.

## Observations

| Observation | Session 1 (`code-b60d9155`) | Session 2 (`code-54f95982`) |
| --- | --- | --- |
| Stage results | Both pass | Both pass |
| Skill/reference delivery | Exact bytes, both stages | Exact bytes, both stages |
| Loaded `vgpu` skill | No | No |
| Observable read of `scene.md` | No | No |
| Read CLI math guide | Yes, turn 1 / step 8 | No |
| Installed or used `math` | No | No |
| Numerical implementation | Handwritten slerp | Handwritten slerp and point transform |
| Agent steps | 61 | 54 |
| Reported generation cost | $1.9517108 | $2.0689432 |

Total: **4/4 stages, 16/16 checks and 40 frames passed**. Reported model generation cost was
**$4.020654**, excluding the source reviewer, native controls, Docker/compute and storage.
`wgpu-matrix@3.4.2` was available transitively in both environments but neither program imported
it. No npm/pnpm/yarn installation attempts were observed; this statement does not classify
unrelated system/Python package commands.

Session 1 discovered the CLI guide through `docs find "quaternion"` (in a command also searching
for `orthographic`), then opened `/guides/scene-math.docs.md` without truncation. That route
exposed its ownership, interoperability and camera sections. It did not go through the skill.
Session 2 had no observed CLI math-guide exposure. Direct file-read and shell-call inspection
found no alternative read of either skill file in either session; delivery alone is not a read.

## Independent source review

The Subharness `repo:reviewer` specialist read both stage snapshots of both programs, identified
only by anonymous code IDs, against the public contract. Scores, transcripts and images were
withheld. The same specialist session performed both reviews. It found no in-contract defects.

Both programs use `vgpu/scene` geometry, matrix and camera helpers, with explicit WGSL uniforms
and three draws. Session 1 composes rotation and marker translation with `multiplyMatrices`;
session 2 rotates each marker's position and rebuilds its model matrix with `composeMatrix`.
Neither introduces a material abstraction or dependency on an external math class.

Both stage-one programs already clamp out-of-range times according to static review. Session 1
makes endpoint handling explicit in stage 2; session 2 only changes comments. No carry-forward
replay was run, so this is not evidence of a measured adaptation improvement. Session 2 uses a
near-parallel normalized-linear fallback: it approximates constant angular speed within the
evaluation's tolerance. The reviewer treated a tighter threshold as optional numerical polish.

## What follows from this pilot

- Delivery works: the reference exists beside the entrypoint with the expected content.
- Skill discovery remains unexercised in these two sessions. Their success cannot establish
  whether the `SKILL.md` → `scene.md` instructions are effective once read.
- The existing CLI can surface the math recommendation from a capability query. Seeing that
  recommendation did not cause session 1 to install the package.
- Correct handwritten interpolation is an accepted solution. Installation counts alone do not
  measure implementation quality or whether an extra dependency was justified.

The [earlier pilot](scene-math-discovery-findings.md) also had two passing sessions with no skill
loads or math usage. This is historical context, not a concurrent control or evidence that the
split improved or harmed agent behavior. Two sessions cannot support a reliable adoption rate.
This task covers one rotating body, not large scene hierarchies or ECS integration.

The next useful experiment is a **separate condition** that asks the agent to follow the vgpu
skill, without naming `math` or `scene.md`. That would exercise the index-to-reference journey.
Keep the spontaneous-discovery condition unchanged so the two questions remain distinguishable.

## Operational notes

Eve emitted listener warnings, and after session 2 printed its passing summary it logged a queue
HTTP 503 / `socket hang up`. Both processes exited zero; complete turn receipts, source identity,
materialization evidence and exports were present, with no retained session/turn/step failure
events. The warning is retained in the run log; it was not a basis for dropping or retrying a sample.

During session 2 the user requested workspace-only cleanup. About 3.8 GiB of disposable historical
control installations, old Eve runtime snapshots and an inactive Next build were removed. Frozen
run inputs and all current evaluation evidence were preserved, and the final integrity checks
passed. No other workspace or its processes were modified.

Detailed scratch evidence is under `.context/work/scene-skill-split-eval/`: `plan.json`,
`ledger.json`, `analysis.json`, `source-review/review-1.log`, `source-review/review-2.log`, and
`cleanup.json`. Native controls are under
`apps/agent-evals/.work/scene-controls/2026-10-01T19-48-10.369Z-cae3a62a/`.
