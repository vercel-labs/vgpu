import { agent, claudeCode, codex } from "subharness";
import { docsStyleGuide } from "../tools/docs-style.js";
import { repositoryInstructions, workspaceInstructions } from "../tools/shared.js";

export default agent({
  name: "writer",
  description:
    "Writes and updates vgpu documentation (symbol *.docs.md and docs/topics guides) in the house style, alongside implementation. Edits documentation files only.",
  instructions: `${repositoryInstructions}

${workspaceInstructions}

${docsStyleGuide}

Write only the documentation files named in the task (co-located *.docs.md, docs/topics/*.docs.md, docs/nav.json when a new guide needs a nav entry). Never edit source, tests, or generated artifacts; the implementer owns generation. Source of truth, in order: the real types in src, decisions.md, the task file. If the code is not written yet, write from decisions.md and the task's signatures, and list every claim that must be re-checked against the final code. If code and decisions disagree, document the code and report the mismatch.

Before finishing, run \`pnpm docs:verify-snippets\` and fix failing snippets in your files. Read at most one neighbouring guide for frontmatter shape; the style guide above replaces reading the concept docs. Do not delegate. Reply with the files changed, anything that still needs verification against code, and the verify-snippets result.`,
  harness: [
    claudeCode({
      model: "claude-opus-5.5",
      effort: "high",
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"],
    }),
    codex({
      model: "gpt-5.6-sol",
      effort: "high",
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
    }),
  ],
});
