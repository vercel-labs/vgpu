# Agent handoffs

Use this contract in the repository's Subharness pipeline. It governs coordination and context use, not portable Blender authoring guidance. Preserve each role's existing output requirements and the caller's review budget.

## Give a bounded task

Supply the governing task/decisions paths, topic directory, assigned files, input revision or artifact hashes, preserved invariants, one expected outcome and its acceptance checks. Include the necessary context because children do not inherit the conversation. Put long histories, logs and source inventories in files and point to the relevant portions instead of copying them into every prompt.

Run independent work in parallel within disjoint ownership. Start dependent review only when its declared inputs are ready. A request to build or capture is not evidence that the requested version is available.

## Return a compact result with durable evidence

Lead with the outcome, then provide:

- Changed artifact paths and the exact input/output revision reviewed or produced.
- Decisive evidence paths and the checks run, with their outcomes. Label skipped or unavailable checks.
- Remaining blockers or limitations and the next concrete action, if any.
- Child task/session identifiers and terminal outcomes when delegation occurred.

Keep complete logs, manifests and reviews on disk. The caller reads the summary and decisive evidence first, expanding when a finding, inconsistency or required coverage needs it. Brevity must not conceal failed checks, unresolved findings or incomplete visual coverage. Follow-ups report the delta since the last handoff and retain governing paths and revision identity; a fresh session still needs a self-contained scope.

## Make reviews actionable

Use stable finding IDs. For each finding, name the affected artifact/revision, observable defect, evidence location, suspected cause if known, suggested fix and a testable acceptance condition. For a visual defect, link the matched whole view and a crop or image coordinates; distinguish what the image demonstrates from a hypothesis about its cause.

Prioritize violations of the accepted brief and regressions. Label optional aesthetic ideas as suggestions; do not turn them into new acceptance criteria. Consolidate the findings into one revision request and re-review the changed areas plus required regression coverage. Preserve the agreed iteration cap; reaching it does not convert unresolved findings into acceptance.

## Keep execution state authoritative

Assign one writer to each status, request and execution record. When execution is delegated, the executor owns a separate receipt recording the requested revision, actual source snapshot/build and asset hashes, command or task identifier, state, output paths and terminal result. For a running preview, also record URL/port and served identities. Link the receipt from status reports rather than copying a second competing account of execution.

The receipt and the artifacts must agree. Check served identities before captures; if they differ, resolve the mismatch before using the images as evidence. A queued message, local source edit or readiness claim does not prove a newer build was executed. Preserve superseded receipts and failed evidence so follow-ups can distinguish stale observations from the current result.
