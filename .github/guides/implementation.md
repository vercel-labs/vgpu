# Shared maintainer implementation

## When to read

Read this after selecting [maintainer adoption](maintainer-adoption.md) or
[maintainer original](maintainer-original.md). It applies when implementation is authorized and
the triage and plan are recorded. It does not authorize external actions on its own.

## 1. Establish the baseline

- Read applicable repository instructions. Inspect the workspace status before changing files;
  preserve unrelated work and the assigned branch name.
- Verify the baseline. Normal development starts from current `canary`; inspect any existing diff
  before resuming it. A clean isolated checkout is appropriate when the workspace contains an
  unrelated or external patch. Do not rename/reset a user's branch as a shortcut.
- If the task prepares a release, promotion, or web-only production change, first read its guide
  from [AGENTS.md](../../AGENTS.md). That lane defines the baseline and ancestry requirements.

## 2. Implement the recorded plan

- Implement the accepted plan using the current repository architecture. For adoption, retain
  independence from the external patch as required by its guide. Update the recorded plan when
  findings materially change scope or API behavior.
- Keep code, public typings, examples, and documentation coherent. Add meaningful regression or
  output tests for behavior changes; do not add tests that only repeat a trivial edit.
- When changing published behavior, read [changesets and migrations](migrations.md) and write the
  notes during implementation. Repository policy/guide changes with no published-package effect
  use a specific `none` justification. Bundled CLI/MCP
  documentation is published behavior. Never bump package versions during ordinary development.

## 3. Validate the change

Run checks appropriate to the diff and all applicable required checks. Behavior changes normally
need typechecking and the fast suite plus focused API, native GPU, docs, or bundle validation as
relevant. Documentation-only policy changes need link/consistency checks and applicable repository
checks. Run `pnpm migrations:check` before preparing an integration PR.
Record exact results and limitations; local mocks do not stand in for native GPU output tests.

| Example change | Relevant validation |
| --- | --- |
| Repository workflow documentation. | Local links/anchors, decision cases, diff consistency, and migration/filename checks. |
| Compute pipeline validation behavior. | Typecheck, focused validation/compilation tests, native error/output reproduction, and the required broader suite. |
| Managed uniform capture. | Multiple operations with distinct values, output correctness, resource lifetime cases, and applicable native tests. |
| API reference or example shipped in the CLI. | Snippet checks, generated-document drift, and the published-package changeset. |

Choose checks based on the actual diff; these examples do not replace the repository's required
checks. Once relevant checks pass, do not rerun or broaden them without new changes, failures, or
an unresolved concern.

## 4. Hand off to PR delivery

Review the whole diff against the intended base and verify that it contains only the intended work.
If the user requested PR preparation/publication, read [pull requests](pull-requests.md) and carry
the origin, triage/plan, changesets, validation, and source credit into that workflow. Otherwise
return the local changes and evidence at the requested stage.

## Required result

The implemented scope, coherent code/docs/tests, any required changeset, and an accurate validation
record. Record remaining limitations explicitly. PR creation, merge, source closure, and release
are handled by their respective workflows when authorized.
