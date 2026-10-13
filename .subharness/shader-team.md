# Shader pilot team

This opt-in lane implements bounded, private rendering prototypes. The lead follows AGENTS.md
and the repository's maintainer workflow. Public API work still follows the API design,
implementation and release guides; these agents do not bypass those gates.

| Role | Agent | Ownership |
| --- | --- | --- |
| Lead | Current coordinating agent | Scope, shared contracts, assignments, execution receipts, integration and acceptance |
| Scaffold | `repo:shader-scaffold` / Sonnet 5.5 | Explicitly specified fixtures, controls, build/capture tools and mechanical validation |
| Shader developer | `repo:shader-developer` / Opus 5.5 | Shading mathematics, numerical correctness, render passes and visual corrections |
| Specialist critic | `repo:asset-critic` / Opus 5.5 | Read-only review of actual reference/current captures at a designated milestone |

The two workers have no child agents and no model fallbacks. The lead chooses when to request
review. Use established project OIDC access and `pnpm exec subharness check repo:<agent>` before
starting a session; readiness does not prove provider quota or a completed inference.

## Task contract

Before launch, write `.context/work/<topic>/brief.md`, `decisions.md`, `plan/index.md` and one task
file per worker. Include reference and baseline identity, owned files, coordinate and color
conventions, resource and shader interfaces, an observable outcome, checks, and a correction
budget. Each worker receives relevant paths rather than the entire conversation. Assign one
writer to every shared artifact. Freeze interfaces before independent parallel implementation.

```sh
pnpm exec subharness run repo:shader-scaffold --detach --prompt-file .context/work/<topic>/plan/tasks/t01-scaffold.md
pnpm exec subharness run repo:shader-developer --detach --prompt-file .context/work/<topic>/plan/tasks/t02-shader.md
```

Record returned session/task IDs immediately. Admission is not completion: collect terminal
responses and inspect the evidence. Use the repository handoff contract. Follow up in the same
session for bounded fixes; Claude `steer` interrupts, so prefer queued delivery. Do not leave
dependent review running against an unfinished build.

## Validation and corrections

Scripts first check compilation, actual WebGPU startup, asynchronous GPU errors, resource
behavior and reproducible capture. The lead checks matched cameras, whole frames and selected
crops. Effects involving time require short sequences, not only stills. Use feature-off witnesses
to verify that a pass contributes the intended result. A reference image cannot be a runtime
background or evidence of implemented rendering.

For the kick pilot, use an initial implementation plus at most two consolidated correction
rounds and one independent milestone review. Other tasks set their own explicit budget. Each
correction identifies the revision, visible or measured defect, affected files, invariants and
acceptance check. Recheck affected behavior and necessary regressions, not the entire project
without a reason. An exhausted budget with defects is REVISE, not PASS.

Group related mechanical work into a meaningful batch. Escalate unresolved math, architecture
and resource-lifetime questions instead of repeatedly retrying them with the scaffold worker.
Do not optimize geometry or change the art direction to conceal a shader failure.

## Cost evidence

Keep a task ledger containing requested model, selected harness, session/task IDs, dispatch and
completion times, outcomes, correction count and capture/build receipts. Record input/output
tokens, cache usage and monetary cost only when the provider or harness supplies an attributable
measurement. Missing values are `null`, not zero. Subharness 0.0.7's public execution/status API
does not expose a usage/cost report, so task counts and elapsed time alone cannot establish dollar
savings. Never inspect or print credentials to obtain accounting data.

Separate model execution cost from render time and GPU performance. Compare cost per accepted
feature on comparable tasks before making a savings claim. Iteration limits constrain workflow;
they are not a provider-enforced spending cap.
