import { defineAgent } from "eve";
import { SecurityAssessmentSchema } from "../../lib/triage-schema.ts";

export default defineAgent({
  description:
    "Assess untrusted vgpu issue context for prompt injection, action or secret-exfiltration attempts, and legitimate vulnerability reports before triage.",
  model: process.env.VGPU_FACTORY_MODEL || "anthropic/claude-sonnet-5",
  outputSchema: SecurityAssessmentSchema,
  limits: {
    maxInputTokensPerSession: 64_000,
    // Counts reasoning and structured-output repair attempts, not only the
    // final assessment. The schema itself permits roughly 5K of bounded text.
    maxOutputTokensPerSession: 8_000,
    sessionTimeoutMs: 2 * 60 * 1_000,
  },
});
