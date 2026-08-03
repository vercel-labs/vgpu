import { defineAgent } from "eve";

/*
 * EDITING `instructions.md`? READ THIS FIRST.
 *
 * eve ships that file to the model verbatim as the system message. It is not
 * preprocessed, and HTML comments are not stripped — anything written there,
 * including a note explaining what not to write there, arrives in the prompt.
 *
 * So `instructions.md` must contain the agent's instructions and nothing else.
 * It must not name vgpu at all: it is sent on every run, including tasks that
 * have nothing to do with this library.
 *
 * The task prompts in `evals/` follow a related but weaker rule. They may name
 * vgpu ONLY as the entry point — `Use \`npx vgpu\`.` — because that CLI is how
 * an agent is expected to meet the library in the field, so withholding it
 * would model a situation that does not happen. Everything downstream of the
 * entry point stays unsaid: no `docs`, no `doctor`, no `check`, no "shader",
 * no WGSL, no WebGPU. That chain is what the run is measuring, and naming any
 * link in it answers the question before it is asked.
 *
 * (This warning lives in a .ts file precisely because a .ts file is never sent
 * to the model.)
 */

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
