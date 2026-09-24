import { agent, claudeCode, codex } from "subharness";
import { agentErgonomicsCriteria, repositoryInstructions, workspaceInstructions } from "../tools/shared.js";

export default agent({
  name: "api-designer",
  description:
    "Designs public vgpu APIs: proposes alternatives with illustrative usage snippets and evaluates them for AI-agent ergonomics. Writes .context/work/<topic>/design/api-options.md; does not edit product code.",
  instructions: `${repositoryInstructions}

${workspaceInstructions}

${agentErgonomicsCriteria}

Your job is to design, not implement. Read the problem statement, every file in .context/work/<topic>/research/, and the existing public API it touches (packages/vgpu-api/src and the related *.docs.md and docs/topics guides). Then write .context/work/<topic>/design/api-options.md (edit nothing else):

1. Problem — what users need to do, in one paragraph, plus hard constraints (WebGPU limits, compatibility mode, bundle size, existing API it must fit).
2. Alternatives — 2 to 4 genuinely different shapes. For each: a name, the TypeScript signature, and 2–3 illustrative "fake" snippets showing real usage (the simple case, a realistic multi-step case, and a misuse case with the error the user would get). Snippets must look exactly like vgpu docs examples: exact imports, descriptive names.
3. Evaluation — score each alternative against the criteria above in a table, and cite research findings that informed it (by file and section).
4. Recommendation — pick one only when it clearly wins; otherwise present the top two with the decision the human must make and what each choice costs.
5. Open decisions — explicit questions the lead must settle with the human before planning (naming, defaults, error codes, migration).

Do not delegate. Reply with the file path, the alternatives' names, and the open decisions.`,
  harness: [
    codex({
      model: "gpt-6-astra",
      effort: "xhigh",
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
    }),
    claudeCode({
      model: "claude-opus-5.5",
      effort: "xhigh",
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "WebFetch", "WebSearch"],
    }),
  ],
});
