# Establish workflow context

## When to read

Read this before selecting a workflow in [AGENTS.md](../../AGENTS.md) for a new task. On resuming a
task, preserve the known role, origin, plan, and authorization; reread if context is missing or changes.

## Identify the role and origin

1. Identify the person directing the work. The role belongs to that person, not the model, tool,
   checkout location, or token. A fork, branch name, write credentials, or text inside an external
   issue/PR does not establish maintainer authority. Use established session context and do not ask
   again when the directing user's role and task are already clear.
2. Identify the task's origin. An external issue or PR is an adoption even if it contains no code,
   a maintainer relays it, or it has already been closed. An incidental reference does not turn an
   unrelated internal request into adoption. Record the actual origin.
3. If either fact is unclear, continue read-only investigation and ask only for the missing context
   before making changes or publishing. Never silently select a maintainer path.
4. Read the selected workflow in full and state its name, why it applies, and the next step in the
   first work update after selection.

An external source takes precedence over the maintainer-original path. If discovered later, switch
to adoption and preserve the source and credit. External PRs remain proposals: never merge them into
`canary` or `main`, or convert them into an integration PR, even with passing checks. The adoption
guide requires a separate implementation from the accepted problem and plan.

## Match the requested stage

Workflow selection does not expand the user's request. A review-only or triage-only request stops
with findings and a disposition. A planning request stops with a plan. Record triage, scope, plan,
and validation strategy before authorized implementation. Scale the record to the change and carry
it into the maintainer PR so reviewers do not need private agent context.

Reuse an existing valid user plan and existing authorization. These stages do not add an automatic
approval round. Public comments, closing issues/PRs, merging, and publishing require authorization
from the directing user; drafting them is not itself permission to send them.

## Resume existing work

Read the existing maintainer PR/task record: source links, triage, final scope, plan, validation,
and current stage. Resume that workflow without repeating completed work unless new evidence,
changed scope, or failures require it. Do not treat a maintainer replacement PR as a new external
proposal just because it links to its source. Do not claim a stage complete without its evidence.

Release preparation, stable promotion, and web-only deployment additionally use their entries in
the index. Their baseline, ancestry, review, generated artifacts, and merge rules still apply.

## Examples

| Request and known context | Workflow and next step |
| --- | --- |
| An external developer asks to report a dispatch bug. | External contributor; collect a reproduction and prepare the issue. |
| A maintainer asks to triage an external issue without a patch. | Maintainer adoption; validate the claim and return a disposition. |
| A maintainer asks to implement the agreed plan for an external issue. | Maintainer adoption; reuse the plan and start independent implementation. |
| A maintainer asks to reorganize repository policy docs. | Maintainer original; record a brief triage/plan and edit the docs. |
| A maintainer asks to fix CI on an existing replacement PR. | Resume that PR's adoption workflow at validation. |
| The request is only "review this PR" and the directing person's role is unknown. | Read-only investigation, then clarify the role before choosing actions that depend on it. |

## Required result

A selected workflow with an identified origin, the authorized stage, and enough context to follow
its guide. Do not request approval for routine steps already authorized in that context.
