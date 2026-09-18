<!-- Maintainer integration PR template. Start at AGENTS.md and follow the matching workflow.
Before preparing this PR, also read .github/guides/pull-requests.md.
External submissions follow .github/guides/external-contributor.md and the contribution policy
rollout in CONTRIBUTING.md. Do not label an external proposal development to make CI pass.
-->

## Summary

Describe the change and why it is needed.

## Workflow and origin

<!-- Choose maintainer-adoption or maintainer-original based on AGENTS.md's conditions.
For adoption, link the external source issue/PR and describe its actual contribution and credit.
For original work, identify the internal request or issue; no extra issue is required.
-->
<workflow and source>

## Triage and plan

<!-- Briefly record the confirmed problem/use case, evidence, disposition, and final scope/approach.
For adoption, include relevant differences from the external proposal. Reviewers should not need
private agent context. Scale the detail to the change; do not paste an abandoned plan or activity log.
-->
<triage and implementation plan>

## PR type

<!-- Replace with exactly development or release; there is no default.
release = preparation of a new RC/stable package version, targeting canary.
development = other work, including promotion to main or synchronization already accounted for.
Type is independent of release impact. Release PRs require the Migration review section below.
-->
<choose PR type>

## Release impact

<!-- Replace the placeholder with exactly one declaration:
none — <specific reason consumers are unaffected>
changeset — .changeset/<id>.md
For multiple new changesets, separate paths with commas. This decision is reviewed against the diff.
Tests, CI, repository/site docs without published-package effects, release preparation and
behavior-preserving internal refactors may use none. Bundled CLI/MCP documentation needs a changeset.
-->
<describe release impact>

## Validation

Describe the tests/checks run.

<!-- Release-preparation PRs also require a ## Migration review section.
Follow docs/release-migrations.md: exact target, stable/RC origins considered, per-changeset coverage,
overlaps/reversals resolved, guide link, and verification evidence/limitations. Do not substitute
a generic reviewed checkbox. Omit this section for ordinary development PRs.
-->
