---
name: visual-explainer
description: >-
  Use when the user asks to explain a problem, issue, PR, or feature as an infographic.
  Create a step-by-step visual explanation starting from user code or actions, with
  a clear problem/solution boundary, syntax-highlighted snippets, and focused diagrams.
  Support standalone educational PDFs and Markdown explanations with small SVG chunks
  for PRs. Also apply when explicitly invoked by the repository PR writer.
---

# Visual explainer

Explain the mechanism so a reader unfamiliar with the implementation can follow it from their
own code to the outcome. This is the shared visual and narrative style for the repository;
it does not grant permission to implement a fix or publish a PR. Follow the active workflow in
AGENTS.md. Write in the user's language for personal explanations and the repository's language
for PR descriptions unless directed otherwise.

## Establish what is being explained

Read the issue or request, relevant source/API docs, and available reproduction or validation
evidence. For a PR, identify its base and head and inspect both versions where behavior changed.
Distinguish the reported symptom, confirmed cause, proposed solution and implemented result.
If the fix is only proposed, label it as proposed throughout; do not present predictions as results.
Use one representative example throughout the explanation. Name omitted setup and define terms
when the reader first needs them. Do not infer an API from a diagram or an old draft.

## Narrative: problem first, then solution

1. **Make the problem explicit before the first snippet.** Name who encounters it, the trigger,
   expected behavior and actual outcome. Use a heading such as "The problem — before this PR"
   and state that the following steps trace the old behavior. For an unfixed issue, say "The
   current problem". "Summary" or "User code" alone does not establish what is being shown.
2. **Start at user code or an action.** Show a small, representative snippet with syntax
   highlighting. Explain whether it is valid code exposing a library problem, incorrect usage,
   or a workaround. If the code is valid, do not imply the user needs to repair it.
3. **Follow the system step by step.** Connect the user call to the necessary internal work,
   the failure point and its observable consequence. Use short sections, one causal step each.
   Separate correct mechanisms required for safety or semantics from the actual defect.
4. **Mark the transition to the solution.** Use a separate heading such as "The solution —
   after this PR" or "Proposed solution". Trace the same example through the changed steps,
   explain why they fix the problem, and state whether user code changes. For a feature, use
   "Previous limitation" and "New behavior" instead of inventing a bug. For a refactor, state
   that observable behavior is unchanged.
5. **Show the result and limits.** Give supported before/after evidence with units, workload,
   environment and conditions such as warmup. Separate allocations, CPU time and GPU throughput;
   mock and native results; measured outcomes and expectations. Keep unmet targets and material
   limitations visible in the human explanation, not only in a technical appendix.

Scale the number of steps to the mechanism. A simple change may need only a short before/after.
See [the example and counterexamples](references/walkthrough.md) for the intended transitions.

## Visual style

- Use a calm technical layout: clear hierarchy, generous spacing, dark ink on a light neutral
  background, and restrained accents. Blue can identify resources, teal the reused/corrected
  path, and red the defect. Always use labels as well as color to distinguish states.
- Each diagram explains one relationship: ownership, ranges, identity, order, dependencies or
  a measured comparison. Put it beside the paragraph that explains it. Keep prose outside the
  graphic; labels should be brief. Arrows must describe an actual flow, dependency or transition.
- Prefer small, self-contained SVGs made from shapes, paths and text. Include viewBox, explicit
  dimensions, title/description, and alt text when embedded. Use an explicit background and
  sufficient contrast. Avoid scripts, foreignObject, external fonts/resources and raster embeds.
- For a PR, target compact or vertical diagrams around 320–480 viewBox units wide with labels
  around 18–22 units. Inspect them at a narrow ~320px content width and a desktop width. Split
  wide diagrams rather than assuming vector zoom makes them readable on a phone.
- Code stays text, with syntax highlighting. In Markdown, use native language fences; in a
  PDF, render selectable monospaced text with token colors. Do not use screenshots of code.
  Mark partial/historical/pseudocode examples in adjacent prose; verify real API snippets against
  the version they demonstrate. State omitted setup rather than making a partial example look
  executable by itself.
- Keep essential meaning in prose, too: the explanation must work for readers and agents that
  cannot see the diagrams. Prefer SVG for this style; Mermaid is an alternative when requested
  or materially better for a simple native Markdown diagram.

## Choose the output mode

Honor the requested format. If the user asks for an infographic for their own understanding and
does not name a format, default to an educational PDF. A request to explain a PR is not itself
permission to edit that PR; distinguish a personal explanation from a requested PR description.

### Personal explanation: PDF

Compose a standalone document with the narrative, highlighted code and diagrams integrated into
readable sections. Choose page size and pagination for the content; do not shrink everything onto
one poster. Preserve text as text and diagrams as vectors where the tooling permits. Use available
PDF guidance/tools (for example ReportLab, Pygments and a PDF renderer), without requiring a
machine-specific skill path. Inspect every rendered page for clipping, overlap, tiny labels,
broken arrows and code wrapping. Check text extraction as well as the images.

Save scratch sources and page previews under `.context/work/<topic>/visual-explainer/`; place the
final PDF in the user-requested location or `output/pdf/`. Neither scratch nor personal PDFs are
committed by default. Deliver a link to the PDF and any useful preview, with a brief statement of
what it explains. An educational PDF stays personal: do not attach it to a PR or turn its pages
into images in the PR body.

### PR description: Markdown and SVG chunks

Use normal Markdown paragraphs and copyable code blocks, interleaved with individual SVGs. Do not
embed a full infographic as a PNG or SVG. After the human walkthrough, the PR writer adds the
repository's technical record, validation and required declarations. Its publication and output
contract is in [the PR-writing guide](../../../.subharness/tools/pr-writing.ts).

Keep new assets in the assigned scratch directory, with meaningful alt text and a list of files
needing upload. Reuse verified existing attachment URLs for unchanged figures. The lead uploads
new figures as GitHub attachments within the user's authorization; do not commit PR-only images
or invent URLs. Published descriptions must have accessible asset URLs, never local paths.

## Verify before delivery

- Read the opening through the first snippet: can a newcomer identify the problem and whether
  the example shows the old/current behavior, a workaround or the solution?
- Scan only the headings: is the before/after transition clear? Do not place a new behavior under
  a heading claiming nothing changes.
- Compare each step, diagram and snippet with the evidence. Mark uncertainty; never invent
  measurements or silently substitute a proposed mechanism for implemented behavior.
- Render and visually inspect the artifact at its intended reading sizes. XML parsing alone is
  not visual verification. Report any rendering/inspection limitation rather than claiming it
  passed. Save rendered previews as scratch evidence, not as replacement PR attachments.
- Return the artifact paths, the relevant source revisions and any limitations. Do not rerun
  expensive product suites merely to illustrate existing evidence.
