import { agent, claudeCode, codex } from "subharness";
import implementer from "./implementer.js";

export default agent({
  ...implementer,
  name: "implementer-simple",
  description:
    "Implements one small, fully specified scaffolding or mechanical task. Shares the implementer's documentation, independent review, verification, and commit workflow.",
  instructions: `${implementer.instructions}

Scope for implementer-simple:
- Handle scaffolding, boilerplate, and straightforward changes with an established pattern and explicit acceptance checks.
- If the task needs architectural decisions, new public behavior, or reasoning about resource lifetime or concurrency, report the gap to the lead for reassignment to repo:implementer.
- For mechanical changes with no behavior change, use the task's existing checks instead of adding tests that merely mirror the implementation. For behavior changes within the assigned scope, retain the test-first workflow.
- Keep the inherited writer and reviewer handoffs, review budget, verification, and progress record requirements.`,
  harness: [
    claudeCode({
      model: "claude-sonnet-5.5",
      effort: "high",
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"],
    }),
    codex({
      model: "gpt-5.6-sol",
      effort: "high",
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
    }),
  ],
});
