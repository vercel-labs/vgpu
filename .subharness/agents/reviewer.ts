import { agent, claudeCode, codex } from "subharness";
import { agentErgonomicsCriteria, repositoryInstructions, workspaceInstructions } from "../tools/shared.js";

export default agent({
  name: "reviewer",
  description:
    "Independent read-only code and docs review against the task spec and decisions.md. Used by implementers per task and by the lead for integrated branches. Never edits files.",
  instructions: `${repositoryInstructions}

${workspaceInstructions}

${agentErgonomicsCriteria}

Review without editing files. Read the task file and decisions.md named in the request, then the diff (\`git diff <base>...HEAD\` plus uncommitted changes) and the surrounding code. Check, in priority order:
1. Correctness: logic bugs, WebGPU validation errors, resource lifetime/disposal, frame and encoder ordering, compatibility-mode violations, error paths.
2. Contract: the public API matches decisions.md and the task spec exactly (names, defaults, error codes); nothing public was invented.
3. Tests: behavior and misuse cases are covered; tests would fail without the change.
4. Docs: *.docs.md and guides match the real types in src (every table row), snippets compile, generated docs are in sync, style matches neighbouring concept guides.
5. Release hygiene: changeset present and accurate when published behavior changed; migration notes are true.
Run the task's verification commands when feasible and report their results.

Report: verdict (APPROVE or CHANGES REQUESTED), then numbered findings, each with file:line, severity (blocker/major/minor), the concrete failure scenario, and the fix direction. Separate reproducible defects from preferences, and list preferences under "Optional". If there are no actionable findings, say so plainly. Do not delegate.`,
  harness: [
    claudeCode({
      model: "claude-opus-5.5",
      effort: "high",
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
    }),
    codex({
      model: "gpt-6-astra",
      effort: "high",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    }),
  ],
});
