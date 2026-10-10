# Scene math guidance comparison — September 29, 2026

This comparison does **not establish that the math guidance improves agent scene building**.
The guidance arm passed 4 of 6 complete cases versus 3 of 6 for baseline, but no final solution
used `math`, no agent opened the dedicated guide's examples, and the failures were dominated by
task-contract interpretation. Generation cost was slightly higher with guidance. These are twelve
observations from one model, not a statistically supported benefit or regression.

The dedicated guide was mostly not delivered: content-level exposure was 1/6 guidance sessions,
and worked-example exposure was 0/6. This run therefore mainly tests discovery, not the guide's effect.

The experiment measures a documentation change **with `math@0.1.0` installed in both arms**.
It does not measure the effect of installing the package versus leaving it unavailable.

## What ran

- Three unchanged `scene-evals-v1` tasks: robot arm, supplied shader bindings, and warehouse.
- Two fresh sessions per task per arm, two turns per session: **12 sessions, 24 turns**.
- One baseline-first and one guidance-first pair per task, executed serially on the same host.
- `anthropic/claude-sonnet-5`, Eve 0.29.5, and the pinned Docker image documented in
  [the experiment instructions](scene-evals.md#docs-guidance-experiment-opt-in).
- Six branch package archives at runtime commit `929b97f5`, source key `cf382b34cfa86d2d`.
  Baseline replaces only the bundled documentation manifest with `a8a9bc8a`'s bytes; guidance
  keeps `929b97f5`'s manifest. All other runtime files match. The corpus change also changes search
  results and ranking; it is not an isolated test of reading one paragraph.
- Project Vercel OIDC through AI Gateway for evaluated agents and Subharness specialists.
- Independent fresh-source execution with native WebGPU state/pixel checks. The sandbox used
  Mesa llvmpipe, so these are functional checks, not hardware-GPU performance measurements.

No task prompt, seed, grader, or threshold changed between arms. No failed attempt was retried or
discarded. There were no infrastructure-classified failures or timeouts. Native health probes
passed. Eve emitted listener and shutdown queue warnings; they remain in the logs and did not
replace the recorded application verdicts.

The preliminary controls used standalone containers, **not warmed Eve templates**. The actual six
task/arm templates subsequently had identical normalized lock and dependency-tree hashes, sandbox
Node v24.20.0, and `math@0.1.0`. All twelve runs matched the frozen tarball hashes, and all 24
post-turn corpus/package observations matched their assignments. No baseline contamination was
detected. External inputs were recorded but not controlled: these included example-catalog queries
through the CLI and web searches for the warehouse contract/schema in slots 11 and 12.

## Results

| Measure | Baseline | Guidance |
| --- | ---: | ---: |
| Cases passing both turns | 3/6 | 4/6 |
| Individual turns passing | 7/12 | 9/12 |
| Model steps | 349 | 352 |
| Reported generation cost | $10.2530 | $10.7808 |
| Final solutions using `math` | 0/6 | 0/6 |
| Clarification requests before first submitted renderer | 1 | 2 |

Total generation cost was **$21.0337**. This excludes launcher preflights, specialist work, and
infrastructure. Costs include failed cases and their debugging. Provider caching, routing, and
sampling remain uncontrolled; the roughly 5% cost difference is descriptive. Overall elapsed time
includes template creation and is not a model-efficiency measure.

There were **56 passing gates out of 64 emitted gates**. This denominator differs from the 80
gates a completely successful set would emit: source execution and protocol failures prevent later
matrix/state/pixel checks. Missing later checks are not passes.

| Slot | Task | Arm | Repeat | Both turns | Steps | Cost | Guidance exposure |
| ---: | --- | --- | ---: | --- | ---: | ---: | --- |
| 1 | Robot | Baseline | 1 | Pass | 74 | $2.1143 | None |
| 2 | Robot | Guidance | 1 | Pass | 59 | $1.5145 | None detected |
| 3 | Shader | Guidance | 1 | Pass | 57 | $1.6403 | Search result only |
| 4 | Shader | Baseline | 1 | Pass | 50 | $1.3898 | None |
| 5 | Warehouse | Baseline | 1 | Fail | 56 | $1.6471 | None |
| 6 | Warehouse | Guidance | 1 | Fail | 54 | $1.5781 | Scene guide scope paragraph |
| 7 | Robot | Guidance | 2 | Pass | 66 | $1.9709 | Scene guide scope paragraph |
| 8 | Robot | Baseline | 2 | Fail | 59 | $1.6317 | None |
| 9 | Shader | Baseline | 2 | Pass | 45 | $1.0854 | None |
| 10 | Shader | Guidance | 2 | Pass | 41 | $1.0997 | Search result only |
| 11 | Warehouse | Guidance | 2 | Fail | 75 | $2.9771 | Scattered `docs grep` lines |
| 12 | Warehouse | Baseline | 2 | Fail | 65 | $2.3847 | None |

Exposure was measured from returned tool content, then checked in the transcripts. Slots 6 and 7
received the new scope paragraph inside scene-composition. Slot 11 received several lines and a
heading from scene-math through `docs grep`; this counts as a content-marker hit, but it did not
deliver the guide's worked examples. None of the six guidance agents opened those examples.
Availability, a search result, delivered text, and understanding are different observations.

## Why cases failed

| Slot | First turn | Second turn |
| ---: | --- | --- |
| 5 | Requires an input-frame `index`; source exits before rendering | Same requirement still causes exit |
| 6 | Asks for the non-empty operation schema; no renderer submitted | Uses missing input indices for output indices and filenames; protocol fails |
| 8 | Uses missing input indices for output indices and filenames; protocol fails | Same protocol failure |
| 11 | Asks for the non-empty operation schema; no renderer submitted | Passes state and pixel checks |
| 12 | Asks for the non-empty operation schema; no renderer submitted | Passes state and pixel checks |

The contracts show `index` in the output and initial warehouse input frames as `{"operations":[]}`.
Their closing instruction that frame indices should match the input is easy to misread. Three
solutions assumed an input `index` rather than deriving the output index from array position.

Warehouse operations are intentionally introduced in turn two. Three agents requested that
schema before implementing turn one. Eve returned control at `input.requested`, and the existing
driver graded the absent source as an application failure before sending the scheduled follow-up.
These are clarification interruptions under this protocol, not renderer crashes. The strict
both-turn metric retains them, even when the agent subsequently builds a correct renderer.

The successful warehouse follow-ups in slots 11 and 12 each matched all **82,908** checked
color/ID samples. This demonstrates functioning stable identity, deletion, movement, recoloring,
and publication on the checked fixture operations. Untested edges such as duplicate or unknown
appIds and invalid inputs are not covered. These passes do not erase their first-turn failures.

## What source review showed

An independent Claude Opus 5.5 specialist read all twelve final solutions and every available
first-turn source snapshot. Three first-turn snapshots had no authored source. The reviewer saw
anonymous directories without arm labels or transcripts; classification was completed before
unblinding. The lead also inspected source, transcripts, hashes, and grading evidence.

- No solution used `math` or another external math package. The lead's transcript review found
  one agent investigated `wgpu-matrix`, then wrote local matrix helpers instead.
- Five solutions implemented matrix multiplication or projection helpers themselves. Simple
  translation literals are recorded separately from these kernels.
- All four supplied-shader solutions used `instances`, `setWorld`, and `instanceGeometry`, with
  explicit style and camera bindings. All passed both shader turns without changing the fixture.
- Both baseline robot solutions used vgpu's compose/multiply and camera helpers. Both guidance
  robot solutions wrote matrix kernels; one also built its own box geometry. This small pattern
  does not establish that the guide caused the choice.
- Robot hierarchies were manual parent-to-child chains. No solution adopted `SceneNode`/`group`
  or the external hierarchy evaluator. These small fixed tasks are weak evidence about large
  hierarchies or integration with an existing ECS/physics system.
- Complete-frame robot reset and absolute shader-camera replacement were already implemented
  in the first-turn source, by source reading. Slot 8's first turn failed the protocol, so its
  reset behavior was not graded. Follow-ups often added validation, comments, or support for
  partial poses. Two shader solutions were byte-identical across turns. Do not count those passes
  as evidence of new adaptation.

The lead's transcript review also found warehouse debugging around integer-ID varyings and
compatibility-mode interpolation. Slot 11 eventually used `@interpolate(flat, either)` and passed
the ID checks. Slot 12 also passed by encoding the appId to a color in the vertex stage and
passing a float varying with default interpolation, so flat interpolation was not the only
working approach in these fixtures.
This is a separate shader/documentation observation, not a matrix-library failure.

## Recommended next experiments

1. Clarify input versus output indices with complete JSON examples. Explicitly limit warehouse
   turn one to empty operations. Record clarification requests as their own outcome. Give revised
   contracts a new revision and rerun both arms; do not pool them with this experiment.
2. Improve discovery from the matrix, camera, and instancing pages agents actually opened, then
   measure delivery of the worked math examples separately from titles and grep hits.
3. Add an interop task that starts with an existing ECS/physics matrix buffer or external math
   object. Check data ownership, mutation, hierarchy propagation, and GPU publication independently.
   Keep the existing neutral tasks to measure spontaneous adoption; an explicitly guided interop
   task answers a different question.
4. Add a small native ID-picking example covering compatibility-mode interpolation. Retain the
   independent ID-pixel oracle to verify the example and agent output.

The current evidence supports these eval and discovery improvements. It does not justify expanding
the scene math API or claiming that the optional package improved agent performance.

## Evidence and validation

[Machine-readable results](scene-math-evals-results.json) retain the fixed schedule, model,
corpus/package/harness hashes, every session ID, source hashes, per-turn checks, exposure, costs,
and clarification counts. Raw evidence is retained locally under:

- `.context/work/scene-math-evals/`: frozen plan, all-attempt ledger, controls, analysis, and blinded
  source reviews.
- `apps/agent-evals/.eve/evals/<timestamp>/`: Eve summaries and full event transcripts.
- `apps/agent-evals/.work/snapshots/<sessionId>/turns/`: submitted source, fresh-run verdicts,
  input fixtures, state output, and PNGs.

Harness validation passed **46 local tests**, the eval application's TypeScript check, paired
archive/control checks, and seven scratch orchestration tests. Implementation and orchestration
each completed an independent review/fix/re-review cycle before the live run. The new tooling is
private to agent-evals; no published runtime API, task contract, or migration was changed.
After blinded source coding, the specialist independently audited the conclusions and approved
them with minor wording corrections, incorporated here. That audit checked recorded results;
it did not rerun rendering or local tests.
