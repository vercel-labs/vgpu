# Maintainer adoption workflow

## When this applies

Follow this guide when acting for a maintainer on a task originating from an external issue or PR.
It applies to reports without patches, feature requests, prototypes, old PRs, and requests to
"just merge" an external patch. See [workflow context](workflow-context.md) for role selection. Continuing a
maintainer's replacement PR retains this workflow and its original source links.

## 1. Triage the contribution

Read the source description, discussion, linked evidence, and any patch or tests relevant to the
claim. Verify the object's kind, author, state, and URL; an issue is not a PR. Check for duplicates,
existing fixes, supported versions, and the current API on `canary`.

Reproduce a reported bug against the maintainer baseline, or record precisely why reproduction is
not possible. For a feature, validate the use case and assess API fit, compatibility, and scope.
Passing checks on the external PR are evidence about that proposal, not approval of its design.

Record one disposition: accepted for planning, needs information, deferred, duplicate/already
resolved, or declined, with evidence and a reason. Acceptance applies to the problem and intended
outcome, not automatically to the proposed implementation. A review/triage request ends here unless
the user also authorized further work. Do not publish a response merely because it is drafted.

## 2. Plan the maintainer implementation

Before editing implementation files, record:

- Source issue/PR links and contributor identities.
- Confirmed problem/use case, evidence, and unresolved questions.
- Accepted scope, API behavior, constraints, and non-goals.
- Proposed implementation and meaningful differences from the external proposal.
- Regression/output tests, other required checks, and likely migration work.
- Intended attribution for the report, design, tests, or other contribution.

Keep this readable in the conversation or task document and carry it into the implementation PR.
Reuse an existing accepted plan when it still applies; revise it if the investigation changes the
scope. Do not introduce an extra permission request when the user has already authorized the work.

For example, if a report proves that invalid compute compilation is invisible to the caller, the
plan should specify how errors reach JavaScript and how tests prove it. It may choose a different
pipeline lifecycle than the contributor's prototype; explain that decision and credit the report.

Use a compact record like this, populated with verified evidence:

```text
Workflow: maintainer-adoption
Source: exact issue/PR URL and author
Triage: disposition, reproduction result, and affected behavior
Scope: accepted outcome and boundaries
Plan: implementation approach and differences from the proposal
Validation: regression/output tests and other required checks
Attribution: report, design, tests, or other actual contribution
```

## 3. Implement independently

Follow [shared implementation](implementation.md). Start the maintainer implementation from an
up-to-date `canary` baseline, or the specifically permitted baseline for a documented production
lane. Use a separate maintainer branch/PR, respecting workspace instructions about branch names.
Compare an existing workspace with that baseline before using it: the candidate contribution's
commits or implementation must not have been imported on top of it. If they have, use a clean
checkout/worktree rather than rewriting someone else's work.

Do not merge, cherry-pick, rebase onto, or copy the external implementation into the maintainer
branch. Use the report, reproduction, and design as evidence; write the production changes and
regression coverage against the accepted plan. Reading a proposal is allowed: this process is not
a claim that the author never saw external code. Describe the actual provenance honestly.

Never relabel an external PR to make it mergeable, regardless of who can edit it or whether its CI
passes. The replacement is a new PR with its own implementation, validation, and release impact.

## 4. Deliver, attribute, and close

Read [pull requests](pull-requests.md) before preparing or acting on the replacement PR.
The maintainer PR must identify `maintainer-adoption`, link its source contributions, summarize the
triage/plan, and include validation and migration evidence. Link related issues and PRs separately;
do not assume an issue-closing keyword will close a source PR.

Credit the actual contribution. Thank/link a reporter for a report or reproduction. Add a verified
`Co-authored-by` trailer for substantive collaboration or when the directing maintainer explicitly
requests it; explain design/test/report provenance without suggesting external code was merged.
Do not invent names/emails or grant co-authorship automatically to every reporter. Preserve chosen
trailers through squash merge and verify them on the resulting commit.

After an authorized merge, verify the resulting commit is on the intended branch. Only then, when
closure/commenting is authorized, close the source PR as superseded with a link and credit. Verify
whether linked issues already closed automatically before acting. Deferred/declined/duplicate
closures use their actual reason, not a claim that a replacement shipped.

Finish by reporting the implementation PR, merge state, source state, and any remaining action.
If the task only requested a closing comment draft, return the draft without posting or closing.

## Examples and stopping points

| Request | Required process and result |
| --- | --- |
| "Triage this external issue." | Read and reproduce/evaluate it; return evidence and a disposition. Implementation is not part of this request. |
| "Implement the accepted fix for this external PR." | Preserve the source, record/reuse the plan, start independently from the maintainer baseline, and validate the replacement. |
| "Fix CI on our replacement PR." | Resume its existing plan at validation; do not restart implementation or lose attribution. |
| "Merge the external PR; its tests pass." | Explain that proposals use adoption; provide triage and a replacement plan, following the authorized scope. Do not merge or relabel the source. |
| "Show me the comment to close the source." | Return a draft with the verified replacement link; do not send it. |
| "Close the source with that comment" after the replacement merges. | Verify source kind/state and replacement merge, then post/close as authorized. |

A concise closing note after crediting the original contributor as a co-author:

> Addressed by [replacement PR], now merged into canary. You've been credited as a co-author.

Substitute the verified replacement link and confirm the contributor's `Co-authored-by` trailer
is present in the merged commit before using this wording. If a different form of credit was
given, state that actual credit instead. Closing an issue does not mean a related PR was closed.
