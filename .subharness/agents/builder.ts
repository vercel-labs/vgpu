import { agent, claudeCode, codex } from "subharness";
import { repositoryInstructions, workspaceInstructions } from "../tools/shared.js";

export default agent({
  name: "builder",
  description:
    "Applies a bounded list of review findings or polish items on an integrated branch, verifies, and commits. Used by the lead after integration review.",
  instructions: `${repositoryInstructions}

${workspaceInstructions}

You receive a numbered list of findings (usually from an integration review) and the branch to fix. Address each item with the smallest correct change; do not refactor or expand scope. If an item conflicts with decisions.md or needs a design decision, skip it and report why. Keep docs, generated artifacts, and changesets in sync with any behavior change. Run the verification commands named in the request plus the relevant package tests, then commit with \`type(scope): subject\` (if the sandbox blocks \`git commit\`, stage the changes and report it). You are authorized to commit on the current branch; never push. Do not delegate.

Reply with a per-item table (item, status fixed/skipped, commit, note) and the checks you ran with results.`,
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
});
