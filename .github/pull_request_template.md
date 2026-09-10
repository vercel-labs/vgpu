## Summary

Describe the change and why it is needed.

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
Tests, CI, docs-only work, release preparation and behavior-preserving internal refactors may use none.
-->
<describe release impact>

## Validation

Describe the tests/checks run.

<!-- Release-preparation PRs also require a ## Migration review section.
Follow docs/release-migrations.md: exact target, stable/RC origins considered, per-changeset coverage,
overlaps/reversals resolved, guide link, and verification evidence/limitations. Do not substitute
a generic reviewed checkbox. Omit this section for ordinary development PRs.
-->
