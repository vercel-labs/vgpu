# Working on vgpu

This file is the workflow index. Before planning, editing files, or acting on an issue/PR, read
[workflow context](.github/guides/workflow-context.md), then select the matching path below.
If the directing person's role is unknown, follow its mandatory
[GitHub permission lookup and routing rules](.github/guides/workflow-context.md#resolve-an-unknown-role-with-gh).
Read required guides in full before the relevant stage. Read additional guides only when their
conditions apply; the linked steps are mandatory, not optional reference material.

## Select the task workflow

| When | Read |
| --- | --- |
| Acting for an external contributor submitting or revising an issue, proposal, reproduction, or prototype PR. | [External contributor](.github/guides/external-contributor.md) |
| Acting for a maintainer on work originating from an external issue or PR, including review, triage, implementation, or a request to merge it. | [Maintainer adoption](.github/guides/maintainer-adoption.md) |
| Acting for a maintainer on an internal task with no external contribution as its origin. | [Maintainer original](.github/guides/maintainer-original.md) |
| Continuing an existing maintainer PR. | Read its recorded workflow above and resume the current stage; use [workflow context](.github/guides/workflow-context.md) if role/origin is unclear. |

## Read the sub-workflow for the current stage

| When | Read before proceeding |
| --- | --- |
| Starting authorized maintainer implementation, including documentation or policy edits. | [Implementation](.github/guides/implementation.md) |
| Changing published behavior, writing a changeset, or deciding whether consumers need migration. | [Changesets and migrations](.github/guides/migrations.md) |
| Preparing, editing, reviewing, or merging a maintainer integration PR. | [Pull requests](.github/guides/pull-requests.md) and [CONTRIBUTING.md](CONTRIBUTING.md) |
| Preparing/reviewing an RC or stable release, changing package versions for release, or publishing packages. | [Releases](.github/guides/releases.md) |
| Promoting a published stable release to `main`, or synchronizing it back to `canary`. | [Stable promotion and back-merge](CONTRIBUTING.md#publish-stable-from-canary-then-promote-it-to-main) |
| Preparing a web-only production change. | [Web-only production updates](CONTRIBUTING.md#web-only-production-updates) |
| Submitting an external PR or changing its type/checks/merge policy. | [Contribution policy rollout](CONTRIBUTING.md#contribution-policy-rollout) |

Normal development targets `canary`. The linked production/release workflows define the exceptions.
