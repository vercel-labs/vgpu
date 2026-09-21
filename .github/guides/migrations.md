# Changesets and consumer migrations

## When to read

Read this while changing published behavior, writing a changeset, or evaluating whether consumers
need adaptation. Write progressive notes during implementation. For release consolidation, also
read [releases](releases.md) and the complete
[editorial checklist](../../docs/release-migrations.md).

## 1. Determine impact

Identify affected packages, API usage, defaults, and environments. Published behavior includes docs
bundled into the CLI/MCP corpus. Repository policy docs, tests, and CI with no published-package
effect may use a specific `none` justification in the integration PR.

Choose the bump based on the actual change. Do not infer whether migration is needed from
patch/minor/major alone: default and environment changes can require adaptation without an API
removal. Ordinary implementation adds a changeset; it does not prepare package versions.

## 2. Write the changeset

Every changeset has normal package/bump YAML frontmatter and exactly two level-two sections:
`## Summary` for release notes and `## Migration` for consumer adaptation. Use a meaningful filename.

If no adaptation is needed, write `None: <specific justification>` under Migration. Otherwise add
`### Affected usage`, `### Steps`, and `### Verification`. Include applicable usage or source
versions and before/after examples when useful, with their headings at level four under Steps.

Illustrative structure for a behavior change requiring adaptation:

```md
---
"vgpu": minor
---

## Summary

Describe the observable behavior change.

## Migration

### Affected usage

Name the API usage, default, or environment that changes.

### Steps

Explain how to reach the final behavior, in dependency order.

#### Before

Show the affected usage when helpful.

#### After

Show the replacement usage when helpful.

### Verification

Give checks a consumer can perform to confirm the migration.
```

Replace the illustrative text with concrete instructions. For an optional API with no adaptation,
a justification might be: `None: Existing calls retain their signatures and behavior; the new
method is opt-in.` Only make that claim if the final diff supports it.

## 3. Verify the final behavior and notes

Compare the text with actual exports, runtime behavior, defaults, examples, and tests. Use current
API snippets for the destination; label historical or partial snippets `ts illustrative` where the
docs tooling requires it. Run `pnpm migrations:check` and applicable snippet/runtime checks.

If implementation changes the plan, update notes to describe the final result. Do not claim that a
passing schema check proves the prose is correct. Carry the changeset path and verification into
the [integration PR](pull-requests.md).

## Existing release inputs

Do not rename or delete changesets already collected in an RC. Stable source collections are
frozen; new fragments belong to the next release. Corrections to the currently prepared release
guide follow [releases](releases.md); do not restore consumed changesets to edit prose or hand-edit
generated records/fingerprints. Released npm packages and Git tags remain immutable.

## Required result

A changeset whose Summary and Migration describe the final implementation, with verification
evidence, or a specific and defensible `none` declaration when there is no published-package effect.
