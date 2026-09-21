# External contributor workflow

## When this applies

Follow this guide when acting for a person outside the maintainer workflow who wants to submit or
revise an issue or PR, or when the [workflow context](workflow-context.md#resolve-an-unknown-role-with-gh)
permission lookup selects this path. An unverified role uses this guide by default; state that
fallback and continue within the requested scope. Credentials or a working implementation alone
do not change the role. Use workflow context's precedence rules if new role evidence appears.

An external contribution provides a problem, evidence, and optionally a proposed solution.
Maintainers triage it, choose a plan, and implement accepted work from scratch in a separate PR.
External PRs are not merged into `canary` or `main`. Explain this model before investing in a
production-ready patch. A useful issue is a complete contribution; code is optional.

## Required steps

1. Search existing issues, PRs, and documentation for the same problem. Link relevant work and
   explain what new evidence the contribution adds.
2. Describe the problem or use case, expected outcome, actual behavior, and affected version/API.
   For bugs, provide a minimal reproduction and the relevant runtime, OS, GPU, and device limits.
   For features, provide a concrete example of the desired behavior and current limitation.
3. Separate observed results from hypotheses. Record commands and outputs when available, and
   identify missing evidence. Do not claim a test passed if it was not run.
4. Explain a proposed approach, alternatives, and likely compatibility effects when known. A
   prototype or suggested regression test may help, but maintainers own the final design and code.
5. Prepare an issue by default. If the user requests a PR, follow the
   [contribution policy rollout](../../CONTRIBUTING.md#contribution-policy-rollout). Submit only
   when publication is within the user's request; otherwise return the prepared text and files.
6. Respond to requests for clarification by updating the reproduction, evidence, or proposal.
   Maintainer acceptance means the problem will be addressed through the adoption workflow; it
   does not turn this PR into the implementation PR.

The submission must contain a problem/use case, expected outcome, evidence or reproduction,
relevant environment, related work, and any proposed approach. Mark genuinely unknown fields
explicitly rather than inventing them. No package version, changeset, or release preparation is
required for a proposal. Maintainers prepare release impact and migration notes in their own PR.

## Choose the submission format

| Situation | Prepare |
| --- | --- |
| A bug can be demonstrated with a short script or sequence. | An issue with the minimal reproduction, expected/actual results, and environment. |
| A feature is needed but the implementation is unclear. | An issue with the use case, desired API/behavior, and alternatives. |
| A prototype or failing test helps explain the proposal and the user requests a PR. | A draft proposal PR following the rollout instructions, with the evidence in its description. |
| An existing issue already covers the problem. | Additional evidence for that issue; publish it only when authorized. |

For example, a report that an invalid compute shader leaves a buffer unchanged should include the
shader, dispatch/read sequence, expected failure path, observed output, and granted device limits.
The contributor can stop with that reproduction; they do not need to redesign pipeline lifecycle.

A report can use this structure, replacing each prompt with the actual evidence:

```md
## Problem

What fails, or which use case is currently unsupported?

## Expected and actual behavior

What should happen, and what was observed?

## Reproduction or use case

Minimal script/steps, command, and relevant output.

## Environment

Package version, runtime, platform, and relevant device capabilities.

## Related work and proposal

Existing issues/PRs, possible approach, alternatives, and remaining unknowns.
```

A draft proposal PR additionally declares `## PR type` as `contribution` under the current rollout
instructions. Its purpose is to support triage, not to produce a mergeable patch. Do not read or
perform the maintainer implementation/release workflows merely to complete an external submission.

## Completion

Return the prepared submission or its published URL, validation performed, and remaining unknowns.
Never label an external proposal `development` or `release` to make checks pass, enable auto-merge,
or merge it directly. Do not close a contribution as implemented until the replacement has merged.
