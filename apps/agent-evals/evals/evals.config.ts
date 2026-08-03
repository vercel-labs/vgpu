import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // The first run also pays for the template: docker image, tarball installs,
  // a software-renderer download and a doctor probe. 10 minutes was not enough
  // once bootstrap remediation was added; later runs reuse the cached template.
  timeoutMs: 1_200_000,

  // Judge model for `t.judge.*`. It only ever scores; it never touches the
  // agent under test, so it is deliberately a small, cheap model — the one
  // judged assertion here reads a command list, not a codebase. String ids
  // route through the AI Gateway, so the same credential covers it.
  judge: { model: process.env.VGPU_EVALS_JUDGE_MODEL || "openai/gpt-4.1-mini" },
});
