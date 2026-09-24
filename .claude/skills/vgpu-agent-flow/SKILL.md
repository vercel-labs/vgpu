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
(docs, changeset, examples). Show the human the lane summary before starting implementation.

## Phase 5 — Implement

For each lane that can start:

1. Create an isolated worktree and bring the pipeline folder into it:
   ```sh
   git worktree add .context/worktrees/<topic>-<lane> -b <topic>/<lane> <base>
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
   run, remaining findings, and the PR text (`## PR type`, `## Release impact` per AGENTS.md).
4. Remove finished worktrees: `git worktree remove .context/worktrees/<topic>-<lane>`.

## Running specialists

- Prefer one ordinary `subharness run ...` per specialist through your background-command
  controls, continue other work, and collect the result. Otherwise use `--detach` and later
  `subharness wait <task-id>`. Never use shell `&`.
- Follow up in the same session with `subharness send <session-id> --prompt "..."`; cancel with
  `subharness cancel <task-id>`. `subharness dashboard` shows live sessions.
- Exit code 0 means a response arrived, not that the goal was met — read the response.
- Check readiness without spending a model turn: `npx subharness check repo:<name>`.

## Personal access (per user, not committed)

Research runs on fx through AI Gateway, which needs an explicit connection in the main checkout's
`.subharness/agents.local.json` (auto-excluded from Git). Without it the researchers fall back to
Codex. Example:

```json
{
  "access": {
    "fx": [{ "type": "vercel-api-key", "env": "AI_GATEWAY_API_KEY", "envFile": ".env.local" }]
  }
}
```

Codex and Claude Code use their native subscription logins by default.
