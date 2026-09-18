# Maintainer original workflow

## When this applies

Follow this guide when acting for a maintainer on an internal task that did not originate from an
external contribution: a feature, fix, refactor, documentation/policy change, or maintenance work.
Use the role rules in [workflow context](workflow-context.md). An external-origin task follows
[maintainer adoption](maintainer-adoption.md), even when a maintainer asks for it directly.

## Required steps

1. Triage the need before proposing a solution. Inspect the relevant implementation, documentation,
   prior work, and tests. Identify the problem or opportunity, who is affected, and evidence that
   work is needed. A small documentation correction can have a short triage record.
2. Record the disposition and scope. If no change is needed, explain why; an investigation-only
   request does not imply permission to implement or publish.
3. Before implementation, record the plan, intended behavior, constraints, validation strategy,
   and likely release/migration impact in the conversation or task document. Scale detail to the
   change. An existing, still-valid user plan satisfies this step; do not ask for approval again
   unless the task explicitly requires it or a new decision needs user input.
4. Follow [shared implementation](implementation.md). For normal development, start from an
   up-to-date `canary` baseline. Preserve workspace branch names unless instructed to rename them.
   A release, promotion, or web-only task must also satisfy CONTRIBUTING.md's specific lane.
5. Before preparing a PR, read [pull requests](pull-requests.md). Identify the workflow as
   `maintainer-original` and the origin as the internal request or linked internal issue. Include
   the triage, final plan, release impact, and validation evidence.
   Do not create an unnecessary issue merely to populate a source field.
6. Complete the delivery actions the user authorized and report the resulting files, PR, checks,
   and merge state as appropriate. Preparing a PR does not itself authorize merging or releasing.

If investigation reveals that an external contribution is the task's source, switch to adoption
before continuing and preserve the source and credit. Routine revisions of an existing maintainer
PR continue its recorded workflow; do not restart triage and implementation from scratch.

## Examples

For an internal request to reorganize agent instructions, a sufficient record could be:

```text
Workflow: maintainer-original
Origin: maintainer request to make AGENTS.md a workflow index
Triage: routing rules and detailed procedures are mixed in the entry point
Scope: repository instructions and guides; preserve release/merge rules
Plan: keep selection conditions in AGENTS.md and move procedures/examples to linked guides
Validation: local links/anchors, routing examples, diff review, migrations check
Release impact: none — repository instructions do not change a published package
```

For an internal API change, expand the record with current/proposed signatures, affected callers,
compatibility decisions, native output tests when relevant, and consumer migration steps. Read
[changesets and migrations](migrations.md) while implementing that change, not after opening the PR.

For "prepare the next RC," use this origin workflow plus [releases](releases.md). Release
preparation has its own versioning and editorial review stages; the task does not implicitly
authorize publishing or production promotion.

## Required result

For investigation or planning, return findings or the plan at that requested stage. For authorized
implementation, produce the scoped changes and validation record; proceed through
[pull requests](pull-requests.md) when PR delivery is requested. A source issue is optional for an
internal task, but its purpose, plan, and evidence must still be reviewable.
