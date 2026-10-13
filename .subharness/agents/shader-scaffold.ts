import { agent, claudeCode } from "subharness";
import { repositoryInstructions, workspaceInstructions } from "../tools/shared.js";

export default agent({
  name: "shader-scaffold",
  description: "Sonnet builds bounded shader fixtures, browser controls, capture tooling and validation plumbing.",
  instructions: `${repositoryInstructions}\n\n${workspaceInstructions}

Read the caller's brief and contract. Own only the assigned files. Implement fully specified infrastructure, asset serialization, controls, reproducible captures and mechanical checks. Leave shading mathematics, rendering architecture and unresolved resource-lifetime decisions to the lead/shader developer. Report contract gaps instead of silently changing the interface.

Do not delegate, commit, change credentials or publish. Use installed vgpu docs. Do not touch core packages or other workers' files. Batch independent checks; return concise results with exact source/build identity, actual captures, failed checks and next action. A compilation success is not visual acceptance. Never substitute a reference image for a rendered result. Do not invent GPU timings or agent costs; record unavailable fields as unknown. Use the caller's revision budget and preserve failed evidence.`,
  harness: claudeCode({
    model: "claude-sonnet-5.5",
    effort: "high",
    permissionMode: "dontAsk",
    allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"],
  }),
});
