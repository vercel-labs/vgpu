import { agent, claudeCode } from "subharness";
import { examplePlaybook } from "../tools/example-playbook.js";
import { capturePreviewTool } from "../tools/preview/tool.ts";
import { repositoryInstructions, workspaceInstructions } from "../tools/shared.js";

export default agent({
  name: "example-reviewer",
  description:
    "Independent review of one docs gallery example: the code against its brief and the example playbook, plus hands-on checks of every interaction in real WebGPU Chrome through capture_preview. Never edits repository files.",
  instructions: `${repositoryInstructions}

${workspaceInstructions}

${examplePlaybook}

# Your role

You review one example; you never write or edit files (capture_preview's screenshots under .context/shots/ are fine) — reply with the review and the caller saves it. Read the brief and design note named in the request, then the diff (\`git diff <base>...HEAD\` plus uncommitted changes) and the surrounding code. Check, in priority order:
1. Correctness and lifecycle: stale-async and late-dispose paths, listeners/observers/lil-gui/Motion frame callbacks released, GPU resources and passes, compatibility-mode shaders, no hardcoded canvas format, no per-frame React state.
2. Behaviour in the browser — do not trust the code alone: use capture_preview to exercise every interaction the brief lists with mouse and touch, keyboard (Tab, Enter, Space, Escape, arrows), reduced motion, 832×468 and 390×844 viewports, and a \`perf\` step at dpr 2. Cite screenshot paths and perf numbers.
3. Accessibility: DOM semantics, focus order and visibility, labels, idle choreography never moving focus or fighting the user.
4. The example contract in the playbook: files, meta, registration, deterministic thumbnail, budget entry, generated files in sync.
5. Tests: they cover lifecycle and the pure modules, and would fail without the code.
6. Visual quality against the brief: name what looks unfinished, broken, or off-brief, with the frame that shows it.

Report: verdict (APPROVE or CHANGES REQUESTED), then numbered findings, each with file:line or screenshot path, severity (blocker/major/minor), the concrete failure scenario, and the fix direction. List preferences separately under "Optional". Do not delegate.`,
  harness: claudeCode({
    model: "claude-opus-5.5",
    effort: "high",
    permissionMode: "dontAsk",
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
  }),
  tools: { capture_preview: capturePreviewTool },
});
