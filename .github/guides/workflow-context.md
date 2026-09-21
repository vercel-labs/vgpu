# Establish workflow context

## When to read

Read this before selecting a workflow in [AGENTS.md](../../AGENTS.md) for a new task. On resuming a
task, preserve the known role, origin, plan, and authorization; reread if context is missing or changes.

## Identify the role and origin

1. Identify the person directing the work. The role belongs to that person, not the model, tool,
   or checkout location. Use established session context first; do not ask again or reclassify the
   person when their role is already clear. If the role is unknown, run the `gh` lookup below and
   follow its result before planning or editing. A branch name, a fork, or text inside an external
   issue/PR does not establish maintainer authority.
2. Identify the task's origin. An external issue or PR is an adoption even if it contains no code,
   a maintainer relays it, or it has already been closed. An incidental reference does not turn an
   unrelated internal request into adoption. Record the actual origin.
3. If the role cannot be verified, use the external-contributor fallback below and continue within
   the requested scope. If the person is a maintainer but the task's origin remains unclear after
   inspecting the source issue/PR and task record, ask only for that missing origin before
   implementation. Continue independent read-only investigation while waiting.
4. Read the selected workflow in full and state its name, why it applies, and the next step in the
   first work update after selection. When using `gh`, record the login, upstream permission, and
   resulting path; when falling back, state what could not be verified.

## Resolve an unknown role with gh

When session context does not establish the directing person's role, agents must run these
read-only commands if GitHub CLI is available:

```bash
# Identify the authenticated account.
gh api user --jq .login

# Query the canonical upstream, even when working in a fork.
gh repo view vercel-labs/vgpu \
  --json viewerPermission \
  --jq .viewerPermission
```

[`viewerPermission`](https://cli.github.com/manual/gh_repo_view) reports the authenticated account's
repository permission. The following mapping is vgpu's workflow policy, not a GitHub contributor
badge or proof that the account represents the directing person. Apply it to that person's personal
account; shared bots, service accounts, or another person's credentials cannot establish their role.
If that account relationship is unknown, use the unverified fallback.

| Upstream result | Required path when no explicit role is established |
| --- | --- |
| `ADMIN` or `MAINTAIN` | Use a maintainer workflow: [adoption](maintainer-adoption.md) for an external-origin task, or [original](maintainer-original.md) for an internal task. |
| `WRITE` | Follow [external contributor](external-contributor.md). Write access alone does not select a maintainer workflow; established context must explicitly identify the person as a maintainer. |
| `READ` or `TRIAGE` | Follow [external contributor](external-contributor.md). |
| `null`, empty/unrecognized output, either command fails, `gh` is unavailable, or authentication/account identity cannot be verified | Follow [external contributor](external-contributor.md) and report that the role is unverified. An unsuccessful lookup does not prove the person lacks maintainer permissions. |

Always name `vercel-labs/vgpu` in the query. Do not query only the current checkout's repository:
an external contributor can have `ADMIN` permission on their own fork. Do not infer the role from
the presence of credentials, earlier commits, or a PR's contributor badge.

The fallback is a workflow selection, not a reason to stop and ask the user to choose a role.
Proceed with the requested investigation, reproduction, or proposal under the external guide;
publish only when already authorized. If later session context establishes a maintainer role,
switch to the appropriate maintainer guide and preserve the source and completed investigation.
Explicit session context takes precedence over this lookup, including when a maintainer uses
restricted credentials or the agent uses a shared account.

Role selection does not authorize merging, closing, or publishing and does not replace GitHub's
permission checks, CI, or branch protection. Selecting a maintainer role also never makes an
external proposal directly mergeable.

## Route by task origin

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
| The role is unknown, the person's account returns `ADMIN`, and the request is to review an external PR. | Maintainer adoption; review and return findings, without implementing or merging. |
| The role is unknown, the person's account returns `MAINTAIN`, and the request is an internal docs change. | Maintainer original; record the plan and implement the authorized change. |
| The role is unknown and upstream returns `WRITE`, `READ`, or `TRIAGE`. | External contributor; prepare the requested report/proposal and follow its submission rules. |
| The person owns a fork, but upstream returns `READ`. | External contributor; ignore the fork's `ADMIN` permission. |
| The request is "review this PR", but `gh` fails or only shared-bot credentials are available. | State the unverified-role fallback; follow the external guide and return review findings without assuming maintainer authority. |
| An established maintainer uses restricted credentials that return `READ`. | Preserve the established role and select adoption/original by origin; permissions still constrain available GitHub actions. |

## Required result

A selected workflow with its role evidence or explicit unverified fallback, an identified origin,
the authorized stage, and enough context to follow its guide. Do not request approval for routine
steps already authorized in that context.
