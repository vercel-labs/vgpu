import { defineAgent } from "eve";
import { TriageProposalSchema } from "./lib/triage-schema.ts";

export default defineAgent({
  model: process.env.VGPU_FACTORY_MODEL || "anthropic/claude-sonnet-5",
  outputSchema: TriageProposalSchema,
  limits: {
    // Output includes the one canonical context copy used as the security
    // subagent call plus the final proposal, not only the final JSON result.
    maxInputTokensPerSession: 128_000,
    maxOutputTokensPerSession: 64_000,
    sessionTimeoutMs: 5 * 60 * 1_000,
  },
});
