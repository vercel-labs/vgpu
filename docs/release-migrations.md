# Editorial migration review for releases

This is a required task for the agent preparing **every RC and stable release**, even when the guide
or changesets appear unchanged. Changesets are evidence collected during development, not the final
consumer document. The guide must explain how to reach the target API, not replay implementation history.

## Prepare and read all inputs

1. Read CONTRIBUTING.md for release-channel and versioning rules. Enter or exit RC mode as appropriate,
   then run `pnpm release:version`. It captures sources before Changesets can consume them, versions
   packages and updates the lockfile. It does not publish or finalize documentation.
2. Run `pnpm migrations:review` and read its complete output: **every archived changeset in this cycle**
   (Summary and Migration, including justified None), plus the current guide. Continue reading if tool
   output was truncated. Do not review only changesets added since the last RC.
3. Inspect the final affected exports, signatures, defaults, runtime behavior and tests. Compare them
   with the previous stable version and the published RCs. Read earlier guides/changelogs from their
   immutable Git tags where needed. An archive retains the latest source text per ID; it is not a
   substitute for the history of what users actually installed. Do not invent an unpublished RC.
4. Account for each changeset in working notes: guide section(s) covering it, merged with another
   change, reverted/superseded with affected origins explained, or no migration with a specific reason.
   A None declaration is a claim to verify, not permission to skip that changeset.

## Write the consolidated guide

Edit `docs/migrations/<stable-destination>.docs.md` directly. Preparation preserves this file across
RCs so you can revise it. Do not edit generated records, index, CLI payload or website copies.

Keep its title/frontmatter and these three level-two sections (use subheadings freely):

- `## From the previous stable release`: name the applicable source version/range, state who is affected,
  and present only the **net** changes to the target, ordered by dependency. Consolidate overlapping
  notes; do not organize the guide by PR number or changeset filename.
- `## From release candidates`: identify the published source RC versions/ranges and give each distinct
  upgrade path. Group only RCs with equivalent starting behavior. Explain which stable-path steps still
  apply and which must be skipped. Say explicitly when no additional migration is needed, and why.
  For the first RC, state that there are no earlier published RCs in the cycle.
- `## Verification`: give concrete typechecking, runtime, platform and regression checks for the final
  behavior. Include verification for RC-only reversals when they differ from the stable-origin path.

Use before/after code for nontrivial API changes, exact replacement names and explicit affected usage.
Keep complete current-API snippets typechecked; mark historical/partial samples `ts illustrative`.
Cover deployment/default changes as well as removed APIs. Remove duplicates, contradictory steps and
obsolete intermediate APIs. If nothing requires migration, explain that in both origin sections;
do not omit the guide or use placeholder text.

### Reversals across RCs

Suppose 0.4.x uses `size`, rc.0 replaces it with `width`/`height`, and rc.1 restores `size`:

- A 0.4.x user upgrading to rc.1 keeps `size` with no migration.
- An rc.0 user upgrading to rc.1 must replace `width`/`height` with `size`.
- The eventual stable guide retains the rc.0 repair path if it still applies.

Do not ask stable users to rename twice. Do not erase the RC repair merely because the stable-to-stable
diff is empty. Resolve cancellation by **source version and final behavior**, not by automatically
subtracting changesets. The same reasoning applies to partial reversals and multiple related changes.

## Verify, attest and hand off

1. Walk through the guide as both a previous-stable user and each distinct RC adopter. Check that every
   step uses the final API and that applying the relevant path does not require obsolete intermediate
   steps. If two fragments conflict and the code does not resolve it, stop and request a decision.
2. Run the relevant API/runtime tests and `pnpm docs:verify-snippets`. Do not claim an illustrative sample
   was typechecked or an unexecuted upgrade path was tested. Record limitations explicitly.
3. Run `pnpm release:finalize` **only after completing the review**. This records a fingerprint of the
   exact target version, all archived sources and final guide, then generates CLI/web docs and checks
   release readiness. A changed target or input invalidates the review; guide edits need a new
   attestation. Even an unchanged guide must be reviewed again for a new RC or stable target.
4. Run `pnpm check:skill-drift` and the normal release validations. Review the entire generated diff.
5. In the release PR, include a `## Migration review` section with the exact target, source stable/RC
   versions considered, a compact **per-changeset coverage** list from your notes, resolution of
   overlaps/reversals, and verification results/limitations. Link the consolidated guide. Do not paste
   a generic "reviewed" checkbox instead of this evidence.

CI checks structure and freshness, not whether you read, understood or correctly synthesized the
inputs. Treat finalization and the release PR review as substantive editorial responsibilities.
Never calculate or hand-edit a fingerprint to bypass the workflow. Published packages/tags are
immutable; finalized stable guides cannot be rewritten by these commands.

If a changeset needs correction after preparation, edit its source and run
`pnpm migrations:sync <current-exact-version>` to recollect without bumping versions or overwriting the
guide, then repeat the editorial review and finalization. Never use sync to change the release version.
