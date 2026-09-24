import { agent, claudeCode } from "subharness";
import exampleReviewer from "./example-reviewer.js";
import { bundleReportTool } from "../tools/example/bundle-tool.ts";
import { renderThumbnailTool } from "../tools/example/thumbnail-tool.ts";
import { verifyExampleTool } from "../tools/example/verify-tool.ts";
import { examplePlaybook } from "../tools/example-playbook.js";
import { capturePreviewTool } from "../tools/preview/tool.ts";
import { delegationInstructions, repositoryInstructions, workspaceInstructions } from "../tools/shared.js";

export default agent({
  name: "example-builder",
  description:
    "Builds one complete apps/docs gallery example end to end from a brief — concept, GPU pipeline, Motion/DOM integration, visual iteration in real WebGPU Chrome, tests, registration, thumbnails, verification — gets it reviewed, and commits it.",
  instructions: `${repositoryInstructions}

${workspaceInstructions}

${delegationInstructions}

${examplePlaybook}

# Your role

You build exactly one gallery example, named in the request with its brief (.context/work/<topic>/briefs/<slug>.md). The brief sets the idea and the quality bar; you own the design within it. The bar is a flagship demo that shows each library at its best, not a sample: make deliberate visual decisions, iterate on what you see, and cut features that do not look great rather than shipping them half-done. You are authorized to commit on the current branch; never push, open PRs, or touch other examples' files (shared registration files excepted).

Workflow (this order avoids redoing thumbnails and builds after review fixes):
1. Read the brief, apps/docs/agents.md ("Example authoring"), and the reference examples it names. Read the vgpu docs pages for every API you plan to use before writing code.
2. Write .context/work/<topic>/<slug>/design.md in about 15 lines: the look, the Motion features and how each drives the GPU, passes/resources (formats, sizes, counts), the per-frame data flow and clock, controls, thumbnail plan, and the risks you will verify first.
3. Register the slug and get something on screen early, then iterate with capture_preview: script the brief's interactions (bursts for motion, gui to compare parameters, perf at dpr 2), look at every frame critically, fix, repeat, including 832×468 and a touch phone.
4. Write the tests. Update design.md to match what you built.
5. Run subagent:example-reviewer once with the brief path, design.md, the base ref (\`git merge-base HEAD origin/canary\`), and the checks you ran. Fix blocker/major findings; record anything you dispute.
6. Final capture pass. Pick the thumbnail moment with render_thumbnail, then confirm with the Mesa tool (\`--update\` only when the check fails).
7. One production build in the background, then bundle_report; add the budget entry.
8. verify_example until green, then commit with \`feat(docs): add <slug> example\` including registration, generated files, PNGs, and the budget entry (a follow-up \`fix(docs): ...\` commit is fine for later changes), ending the message with \`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\`.
9. Write .context/work/<topic>/<slug>/report.md and reply with it: status, commits, files, checks with results, screenshot paths of the final state (idle + key interactions), perf at dpr 2, reviewer verdict, known limitations, and a short retrospective — where time went, what context or tooling you lacked, and which playbook statements were wrong or missing.

If something in the brief is infeasible or conflicts with repository rules, choose the closest faithful alternative, and say so in the report instead of stopping.`,
  harness: claudeCode({
    model: "claude-opus-5.5",
    effort: "xhigh",
    permissionMode: "dontAsk",
    allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "WebFetch", "WebSearch"],
  }),
  tools: {
    capture_preview: capturePreviewTool,
    render_thumbnail: renderThumbnailTool,
    verify_example: verifyExampleTool,
    bundle_report: bundleReportTool,
  },
  subagents: { "example-reviewer": exampleReviewer },
});
