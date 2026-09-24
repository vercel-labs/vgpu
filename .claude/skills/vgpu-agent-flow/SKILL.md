---
name: vgpu-agent-flow
description: Lead workflow for developing vgpu features with the repository's subharness specialists — research, API design, human-validated decisions, planning, parallel implementation with docs and review, integration. Use when the human asks to research, design, plan, or implement a vgpu feature, shader, material, or simulation with agents, or mentions the agent flow, specialists, or subharness team.
---

# vgpu agent flow

You are the lead. Specialists live in `.subharness/agents/` and run through the `subharness` CLI
(root devDependency; call it as `pnpm exec subharness` or `npx subharness`). You own every
conversation with the human, every decision, every worktree, and every merge. Specialists never
talk to the human and never see this conversation — each prompt must carry the full context.

## Team

| Target | Harness / model | Role |
|---|---|---|
| `repo:api-researcher` | fx `google/gemini-3.8-flash` → Codex `gpt-5.6-luna` | How other frameworks/libraries solve it. Raw findings only |
| `repo:graphics-researcher` | fx `google/gemini-3.8-flash` → Codex `gpt-5.6-luna` | Papers, talks, shipped game techniques. Raw findings only |
| `repo:api-designer` | Codex `gpt-6-astra` xhigh → Claude `claude-opus-5.5` xhigh | API alternatives + illustrative snippets, agent-ergonomics evaluation |
| `repo:planner` | Codex `gpt-6-astra` high → Claude `claude-opus-5.5` high | Plan folder: index, task specs, lanes, progress log |
| `repo:implementer` | Codex `gpt-5.6-sol` high → Claude `claude-opus-5.5` high | One task, test-first; runs `writer` and `reviewer` as children; commits |
| `repo:writer` | Claude `claude-opus-5.5` high → Codex `gpt-5.6-sol` high | Docs in house style (called by implementer, or by you for docs-only work) |
| `repo:reviewer` | Claude `claude-opus-5.5` high → Codex `gpt-6-astra` high | Read-only review (called by implementer per task, and by you after integration) |
| `repo:builder` | Codex `gpt-5.6-sol` high → Claude `claude-opus-5.5` high | Applies a bounded list of integration-review findings |
| `repo:example-builder` | Claude `claude-opus-5.5` xhigh | One docs gallery example end to end from a brief; sees it running through `capture_preview`; runs `example-reviewer`; commits |
| `repo:example-reviewer` | Claude `claude-opus-5.5` high | Example review: code plus hands-on interaction checks through `capture_preview` (called by example-builder) |

Fallback (→) only happens when the first harness is unavailable before the task starts (missing
CLI, no login, no fx Gateway access). A task that fails after starting is never retried elsewhere;
re-run it yourself if needed.

## Workspace

All pipeline artifacts are gitignored scratch under `.context/work/<topic>/` (kebab-case topic):

```text
.context/work/<topic>/
  brief.md                 # you: the problem statement in the human's words + constraints
  research/<angle>.md      # researchers: raw findings
  design/api-options.md    # api-designer: alternatives + snippets
  decisions.md             # you: locked decisions (after human validation)
  plan/index.md            # planner
  plan/tasks/T01-*.md      # planner
  plan/progress.md         # planner creates; you keep it current
  plan/progress/T01.md     # implementers
  reviews/integration-*.md # you: saved integration review output
.context/worktrees/<topic>-<lane>/   # git worktrees for parallel lanes
```

Never commit `.context/`.

## Phase 0 — Select the repository workflow

Before Phase 1, follow AGENTS.md and `.github/guides/workflow-context.md`: establish the directing
person's role (run its `gh` permission lookup if unknown) and the task's origin, then select
`maintainer-original` (internal work), `maintainer-adoption` (anything originating from an external
issue/PR), or `external-contributor`. Announce the workflow and record it in `brief.md`:

```text
Workflow: maintainer-original | maintainer-adoption
Origin: internal request, or source issue/PR URL + author
Triage: confirmed problem, evidence, disposition
Scope: accepted outcome and non-goals
```

The phases below implement that workflow's plan and implementation stages; they do not replace its
rules on baseline, changesets, PR delivery, or merge authorization. Every lane branches from a
freshly fetched `origin/canary` (`<base>` below) unless the task is a documented production lane.
For adoption, pass the source links to every specialist as evidence and state that the external
implementation must not be copied, cherry-picked, or merged. Stop at the stage the human asked for:
a research or design request ends with findings, a planning request with the plan.

## Phase 1 — Research

1. Write `brief.md`. Split the question into 2–5 independent angles (e.g. "three.js / Babylon
   API shape", "Bevy / wgpu resource lifetime", "screen-space GI papers 2018–2025").
2. Launch one researcher per angle in parallel, each as its own background command:
   ```sh
   npx subharness run repo:api-researcher --prompt "Topic: <topic>. Brief: .context/work/<topic>/brief.md. Question: <angle question>. Write .context/work/<topic>/research/<angle-slug>.md."
   ```
   Use `api-researcher` for API questions and `graphics-researcher` for shaders, materials,
   simulations, and rendering techniques.
3. Researchers do not conclude. Skim their files yourself only to decide whether an angle needs
   a follow-up run (`subharness send <session-id> --prompt "..."`).

## Phase 2 — API design (skip for work with no public API change)

```sh
npx subharness run repo:api-designer --prompt "Topic: <topic>. Read brief.md and research/ under .context/work/<topic>/. Design the public API for <problem>. Write design/api-options.md."
```

Expect 2–4 alternatives; a single recommendation only when one clearly wins.

## Phase 3 — Validate with the human and lock decisions

1. Present the alternatives to the human: short summary, one key snippet each, trade-offs, the
   designer's open decisions, and your recommendation. Use the ask-question tool for each open
   decision. Iterate (re-run the designer with feedback via `send`) until every decision is settled.
2. Write `decisions.md`: one numbered section per decision (`D1`, `D2`, ...) with the chosen option,
   the final signatures/defaults/error codes, rejected alternatives with one-line reasons, and
   explicit non-goals. Mark it `Status: locked (<date>)`. Only the human can reopen a decision.

## Phase 4 — Plan

```sh
npx subharness run repo:planner --prompt "Topic: <topic>. Plan the implementation of .context/work/<topic>/decisions.md. Write plan/ under .context/work/<topic>/."
```

Review `plan/index.md` for lane isolation (disjoint files between lanes) and missing tasks
(docs, changeset, examples, bundle budgets, native GPU tests), and check that its PR record is
self-contained. Show the human the lane summary before starting implementation.

## Phase 5 — Implement

For each lane that can start:

1. Create an isolated worktree and bring the pipeline folder into it:
   ```sh
   git fetch origin canary
   git worktree add .context/worktrees/<topic>-<lane> -b <topic>/<lane> <base>   # <base> = origin/canary
   mkdir -p .context/worktrees/<topic>-<lane>/.context/work
   cp -R .context/work/<topic> .context/worktrees/<topic>-<lane>/.context/work/
   (cd .context/worktrees/<topic>-<lane> && pnpm install --frozen-lockfile && pnpm build)
   ```
   A single-lane plan can run in the current workspace instead.
2. Run the lane's tasks in order, one implementer session per task, each lane as its own
   background command:
   ```sh
   npx subharness run repo:implementer --cwd .context/worktrees/<topic>-<lane> --prompt "Topic: <topic>. Implement task .context/work/<topic>/plan/tasks/T03-<slug>.md. Base ref: <base>. Governing: .context/work/<topic>/decisions.md."
   ```
   The implementer writes tests first, runs `writer` for docs in parallel, runs `reviewer`
   (max 2 rounds), commits on the lane branch, and writes `plan/progress/<id>.md`.
3. After each task, copy the lane's `plan/progress/<id>.md` back and update `plan/progress.md`.
   Report blocked tasks and disputed findings to the human instead of forcing them through.

## Phase 6 — Integrate, review, polish

1. Merge lane branches into the feature branch in the plan's integration order; resolve conflicts
   yourself and run the checks the plan lists after each merge.
2. Run your own integration review over the whole branch:
   ```sh
   npx subharness run repo:reviewer --prompt "Integration review for <topic>. Base: <base>. Governing: .context/work/<topic>/decisions.md and plan/index.md. Review the full branch diff, focusing on cross-task consistency, public API contract, docs vs code, and release hygiene."
   ```
   Save the output to `reviews/integration-<n>.md`.
3. Hand blocker/major findings (and cheap polish) to the builder as a numbered list:
   ```sh
   npx subharness run repo:builder --prompt "Topic: <topic>. Fix these findings on the current branch: 1. ... 2. ... Verify with: <commands>."
   ```
   Re-review if the builder changed behavior. Then summarize to the human: what shipped, checks
   run, and remaining findings. When the human asks for a PR, follow
   `.github/guides/pull-requests.md` and `.github/pull_request_template.md` against `canary`. Build
   the description from `plan/index.md`'s PR record, the key `decisions.md` entries, and the
   implementers' validation notes; reviewers cannot see `.context/`. Declare exactly one PR type
   (`development` for normal work) and one release impact matching the diff, and run
   `pnpm migrations:check`. For adoption, link the sources and credit the actual contribution; add a
   `Co-authored-by` trailer only when verified and warranted. Opening a PR does not authorize
   merging, closing sources, or releasing.
4. Remove finished worktrees: `git worktree remove .context/worktrees/<topic>-<lane>`.

## Gallery examples

A new `apps/docs/examples/<slug>` example skips Phases 1–4: write
`.context/work/<topic>/briefs/<slug>.md` (idea, quality bar, interactions, constraints, closest
reference examples) and run one builder session per example in the target checkout:

```sh
npx subharness run repo:example-builder --prompt "Topic: <topic>. Build the example in .context/work/<topic>/briefs/<slug>.md. Base ref: origin/canary."
```

The builder carries the example contract in `.subharness/tools/example-playbook.ts` and these tools:
`capture_preview` (`.subharness/tools/preview/`) loads `/preview/<slug>` from the checkout's docs dev
server in headless WebGPU Chrome, replays scripted mouse/touch/keyboard input, and returns
screenshots, burst contact sheets, console problems, and GPU/frame timing; `render_thumbnail`,
`verify_example`, and `bundle_report` (`.subharness/tools/example/`) cover thumbnails, the
pre-commit checklist, and chunk budgets. Two also run from a shell:
`node .subharness/tools/preview/cli.ts <slug> --steps '<json>'` and
`node .subharness/tools/thumbs/mesa.ts <slug> [--update]` (CI's pinned Mesa renderer).

When several examples are built in sequence, improve the builder between them: ask its session what
context or tooling would have saved time (`subharness send <session-id> --prompt "..."`), evaluate
each suggestion against the next brief and the repository rules, apply the ones that generalize to
the playbook or tools, and log feedback, verdicts, and changes in `.context/work/<topic>/iterations.md`.

## Running specialists

- Prefer one ordinary `subharness run ...` per specialist through your background-command
  controls, continue other work, and collect the result. Otherwise use `--detach` and later
  `subharness wait <task-id>`. Never use shell `&`.
- Follow up in the same session with `subharness send <session-id> --prompt "..."`; cancel with
  `subharness cancel <task-id>`. `subharness dashboard` shows live sessions.
- Exit code 0 means a response arrived, not that the goal was met — read the response.
- Check readiness without spending a model turn: `npx subharness check repo:<name>`.

## Personal access (per user, not committed)

Research runs on fx through AI Gateway, which needs an explicit connection. Use the OIDC token of
the `vercel-labs/vgpu` project, configured once in the **main checkout** (worktrees read it from
there):

```sh
cd <main-checkout>
vercel link --yes --project vgpu --scope vercel-labs   # writes .vercel/project.json
vercel env pull .env.local --yes                       # writes VERCEL_OIDC_TOKEN
```

`vercel link` may append `.vercel` / `.env*.local` to `.gitignore`; revert that and add them to
`.git/info/exclude` instead. Then create `<main-checkout>/.subharness/agents.local.json`
(auto-excluded from Git):

```json
{
  "access": {
    "fx": [{ "type": "vercel-oidc", "project": ".", "envFile": ".env.local" }]
  }
}
```

Verify with `npx subharness check repo:graphics-researcher`. The OIDC token expires after about
12 hours; when fx fails with an expired-token error, re-run `vercel env pull .env.local --yes` in
the main checkout. Without fx access the researchers fall back to Codex. Codex and Claude Code use
their native subscription logins by default.

`claude-opus-5.5` is served through AI Gateway, not every Claude subscription: when a Claude
specialist fails with `HARNESS_ERROR` or "selected a different model than requested", add the same
connection for Claude Code (`"claudeCode": [{ "type": "vercel-oidc", "project": ".", "envFile":
".env.local" }]`) to `agents.local.json`. That bills Claude specialists to the linked project.
