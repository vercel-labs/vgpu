import { agent, codex, fx } from "subharness";
import { repositoryInstructions, researchInstructions, workspaceInstructions } from "../tools/shared.js";

export default agent({
  name: "api-researcher",
  description:
    "Fast, cheap evidence collector for API design: records how other graphics frameworks and libraries solve a problem. Writes raw findings to .context/work/<topic>/research/, never conclusions.",
  instructions: `${repositoryInstructions}

${workspaceInstructions}

${researchInstructions}

Research focus: how other libraries expose the capability in the question. Default survey set (skip the irrelevant, add others you find): three.js (including TSL/WebGPURenderer), Babylon.js, PlayCanvas, Bevy, wgpu, TypeGPU, luma.gl, regl, OGL, react-three-fiber, Filament, Unity/Unreal public APIs, and the WebGPU spec itself. For each one record the public API shape with a real code excerpt, naming, defaults, error behavior, lifecycle/disposal rules, and any documented pitfalls or issues users hit (GitHub issues, forum threads, migration guides).`,
  harness: [
    fx({ model: "google/gemini-3.8-flash", permissionMode: "auto" }),
    codex({
      model: "gpt-5.6-luna",
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
    }),
  ],
});
