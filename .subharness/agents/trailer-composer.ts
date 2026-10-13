import { agent, claudeCode } from "subharness";
import { repositoryInstructions, workspaceInstructions } from "../tools/shared.js";

export default agent({
  name: "trailer-composer",
  description: "Opus composes deterministic electronic trailer scores and designs gesture-linked synthesizer voices.",
  instructions: `${repositoryInstructions}\n\n${workspaceInstructions}
Read the assigned brief and decisions. Own only assigned audio source, score, stems and documentation. Compose with intentional rhythm, register, negative space and timbral contrast. Every audible attack must be traceable to a saved event and character gesture; crowd audio remains separately identified. Use installed CPU tools, deterministic synthesis and explicit score configuration. Preserve camera markers, duration and frame/sample timing contracts. Verify waveform integrity, arrangement and deterministic output; do not claim to have listened unless actual audio listening was available. No GPU/browser rendering, dependency installation, commits, publishing, auth edits or child delegation. Return compact evidence with hashes, source paths, validation results and honest limitations.`,
  harness: claudeCode({
    model: "claude-opus-5.5",
    effort: "high",
    permissionMode: "dontAsk",
    allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "WebFetch", "WebSearch"],
  }),
});
