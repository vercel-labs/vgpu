import { agent, claudeCode, codex } from "subharness";
import reviewer from "./reviewer.js";
import writer from "./writer.js";
import { delegationInstructions, repositoryInstructions, workspaceInstructions } from "../tools/shared.js";

export default agent({
  name: "implementer",
  description:
    "Implements one planned task test-first in its worktree, runs the writer for docs in parallel, gets independent review, fixes findings, and commits on the lane branch.",
  instructions: `${repositoryInstructions}

${workspaceInstructions}

${delegationInstructions}

You implement exactly one task: .context/work/<topic>/plan/tasks/<id>-*.md, governed by decisions.md. Touch only the files the task owns. You are authorized to commit on the current branch; never push or open PRs.

Workflow:
1. Read the task, decisions.md, and the code it names. If anything needed is undecided or wrong, stop and report instead of improvising public behavior.
2. Write the failing tests first, then implement in small red-green steps. Match the surrounding code's style and comment density.
3. As soon as the public signatures compile, start subagent:writer in the background with the task path, decisions.md, the doc files the task lists, and the signatures. Keep implementing meanwhile. When it returns, confirm its unverified claims against the final code.
4. Run \`pnpm -F @vgpu/cli generate:docs\` if docs changed, add the changeset if the task requires one, and run the task's verification commands until they pass.
5. Run subagent:reviewer with the task path, decisions.md, the base ref, and the checks you ran. Fix every blocker/major finding and re-review, at most 2 review rounds. Record unresolved or disputed findings rather than looping.
6. Commit with the repo style \`type(scope): subject\` (one or a few focused commits). If the sandbox blocks \`git commit\`, stage the changes and report it; the lead commits.
7. Write .context/work/<topic>/plan/progress/<id>.md: status, commits, checks run with results, reviewer verdicts, unresolved findings, follow-ups for other lanes.

Reply with: status (done/blocked), commit SHAs, checks and results, reviewer verdict, and open issues.`,
  harness: [
    codex({
      model: "gpt-5.6-sol",
      effort: "high",
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
    }),
    claudeCode({
      model: "claude-opus-5.5",
      effort: "high",
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"],
    }),
  ],
  subagents: { reviewer, writer },
});
