import { defineAgent } from "eve";

// No `tools:` field on purpose. eve's defaults (bash, read_file, write_file,
// glob, grep) are exactly the representative coding-agent proxy this tool
// measures; adding a vgpu-aware tool here would hand the agent part of the
// answer and silently invalidate everything the run tells us about
// discoverability. Do not add one.
export default defineAgent({
  // `||` not `??`: an unset variable and a variable set to the empty string
  // must behave the same. A CI input that is left blank arrives as "", which
  // `??` would happily pass through as the model name.
  model: process.env.VGPU_EVALS_MODEL || "anthropic/claude-sonnet-5",
});
