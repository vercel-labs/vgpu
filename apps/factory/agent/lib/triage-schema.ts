import { z } from "zod";

const GITHUB_ISSUE_URL =
  /^https:\/\/github\.com\/vercel-labs\/vgpu\/issues\/[1-9]\d*$/u;
const SOURCE_ID = /^(?:issue|duplicate):[1-9]\d*$/u;

const boundedText = (max: number) => z.string().min(1).max(max);

export const RepositorySchema = z
  .object({
    id: z.literal(1230165564),
    owner: z.literal("vercel-labs"),
    name: z.literal("vgpu"),
  })
  .strict();

export const IssueContextSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().regex(GITHUB_ISSUE_URL),
    sourceId: z.string().regex(SOURCE_ID),
    title: boundedText(256),
    body: z.string().max(16_000),
    author: z.string().min(1).max(100).nullable(),
    createdAt: z.string().datetime(),
    labels: z.array(z.string().min(1).max(50)).max(30),
  })
  .strict()
  .superRefine((issue, ctx) => {
    if (issue.sourceId !== `issue:${issue.number}`) {
      ctx.addIssue({
        code: "custom",
        message: "sourceId must identify the issue number",
        path: ["sourceId"],
      });
    }
    if (!issue.url.endsWith(`/issues/${issue.number}`)) {
      ctx.addIssue({
        code: "custom",
        message: "url must identify the issue number",
        path: ["url"],
      });
    }
  });

export const DuplicateCandidateSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().regex(GITHUB_ISSUE_URL),
    sourceId: z.string().regex(SOURCE_ID),
    title: boundedText(256),
    bodyExcerpt: z.string().max(2_000),
    state: z.enum(["open", "closed"]),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if (candidate.sourceId !== `duplicate:${candidate.number}`) {
      ctx.addIssue({
        code: "custom",
        message: "sourceId must identify the candidate issue number",
        path: ["sourceId"],
      });
    }
    if (!candidate.url.endsWith(`/issues/${candidate.number}`)) {
      ctx.addIssue({
        code: "custom",
        message: "url must identify the candidate issue number",
        path: ["url"],
      });
    }
  });

export const LabelContextSchema = z
  .object({
    name: z.string().min(1).max(50),
    description: z.string().max(100).nullable(),
  })
  .strict();

export const NormalizedTriageInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: RepositorySchema,
    issue: IssueContextSchema,
    duplicateCandidates: z.array(DuplicateCandidateSchema).max(5),
    availableLabels: z.array(LabelContextSchema).max(100),
    availableSourceIds: z.array(z.string().regex(SOURCE_ID)).min(1).max(6),
    contextWarnings: z.array(boundedText(500)).max(10),
    capabilities: z
      .object({
        labelsAvailable: z.boolean(),
        duplicateSearchAvailable: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const expectedSourceIds = new Set([
      input.issue.sourceId,
      ...input.duplicateCandidates.map((candidate) => candidate.sourceId),
    ]);
    const suppliedSourceIds = new Set(input.availableSourceIds);

    if (
      suppliedSourceIds.size !== input.availableSourceIds.length ||
      suppliedSourceIds.size !== expectedSourceIds.size ||
      [...expectedSourceIds].some(
        (sourceId) => !suppliedSourceIds.has(sourceId)
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "availableSourceIds must contain each normalized issue source exactly once",
        path: ["availableSourceIds"],
      });
    }

    if (
      input.duplicateCandidates.some(
        (candidate) => candidate.number === input.issue.number
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "duplicateCandidates must not contain the source issue",
        path: ["duplicateCandidates"],
      });
    }

    if (
      !input.capabilities.labelsAvailable &&
      input.availableLabels.length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "availableLabels must be empty when label context is unavailable",
        path: ["availableLabels"],
      });
    }

    if (
      !input.capabilities.duplicateSearchAvailable &&
      input.duplicateCandidates.length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "duplicateCandidates must be empty when duplicate search is unavailable",
        path: ["duplicateCandidates"],
      });
    }
  });

export const SecurityVerdictSchema = z.enum([
  "clear",
  "suspicious-content",
  "security-report",
]);

export const SecurityAssessmentSchema = z
  .object({
    verdict: SecurityVerdictSchema,
    reason: boundedText(1_000),
    signals: z.array(boundedText(500)).max(8),
  })
  .strict();

export const TriageClassificationSchema = z.enum([
  "bug-candidate",
  "feature-request",
  "support-question",
  "needs-information",
  "duplicate-candidate",
  "security-review",
  "needs-maintainer",
]);

export const TriageDispositionSchema = z.enum([
  "queue-investigation",
  "request-information",
  "propose-close-duplicate",
  "route-feature",
  "escalate-security",
  "maintainer-review",
]);

export const TriageProposalSchema = z
  .object({
    security: SecurityAssessmentSchema,
    classification: TriageClassificationSchema,
    confidence: z.enum(["low", "medium", "high"]),
    summary: boundedText(2_000),
    evidence: z
      .array(
        z
          .object({
            sourceId: z.string().regex(SOURCE_ID),
            statement: boundedText(1_000),
          })
          .strict()
      )
      .min(1)
      .max(12),
    missingInformation: z.array(boundedText(500)).max(8),
    duplicateOf: z
      .object({
        number: z.number().int().positive(),
        url: z.string().regex(GITHUB_ISSUE_URL),
      })
      .strict()
      .nullable(),
    proposedLabels: z.array(z.string().min(1).max(50)).max(10),
    disposition: TriageDispositionSchema,
    draftReply: z.string().min(1).max(4_000).nullable(),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    if (
      proposal.security.verdict !== "clear" &&
      (proposal.classification !== "security-review" ||
        proposal.disposition !== "escalate-security")
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "non-clear security assessments must be escalated for security review",
        path: ["security"],
      });
    }

    if (
      proposal.security.verdict === "security-report" &&
      proposal.draftReply !== null
    ) {
      ctx.addIssue({
        code: "custom",
        message: "security reports must not produce a public draft reply",
        path: ["draftReply"],
      });
    }

    if (
      proposal.disposition === "propose-close-duplicate" &&
      (proposal.classification !== "duplicate-candidate" ||
        proposal.confidence !== "high" ||
        proposal.duplicateOf === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "closing a duplicate requires a high-confidence duplicate candidate",
        path: ["disposition"],
      });
    }

    if (
      proposal.duplicateOf !== null &&
      proposal.classification !== "duplicate-candidate"
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "duplicateOf is only valid for duplicate-candidate classifications",
        path: ["duplicateOf"],
      });
    }
  });

export const TriageReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("dry-run"),
    repository: RepositorySchema,
    issue: z
      .object({
        number: z.number().int().positive(),
        url: z.string().regex(GITHUB_ISSUE_URL),
      })
      .strict(),
    contextWarnings: z.array(boundedText(500)).max(10),
    security: SecurityAssessmentSchema,
    classification: TriageClassificationSchema,
    confidence: z.enum(["low", "medium", "high"]),
    summary: boundedText(2_000),
    evidence: z
      .array(
        z
          .object({
            sourceId: z.string().regex(SOURCE_ID),
            statement: boundedText(1_000),
          })
          .strict()
      )
      .min(1)
      .max(12),
    missingInformation: z.array(boundedText(500)).max(8),
    duplicateOf: z
      .object({
        number: z.number().int().positive(),
        url: z.string().regex(GITHUB_ISSUE_URL),
      })
      .strict()
      .nullable(),
    proposedLabels: z.array(z.string().min(1).max(50)).max(10),
    disposition: TriageDispositionSchema,
    draftReply: z.string().min(1).max(4_000).nullable(),
  })
  .strict();

export type Repository = z.infer<typeof RepositorySchema>;
export type IssueContext = z.infer<typeof IssueContextSchema>;
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;
export type LabelContext = z.infer<typeof LabelContextSchema>;
export type NormalizedTriageInput = z.infer<typeof NormalizedTriageInputSchema>;
export type SecurityVerdict = z.infer<typeof SecurityVerdictSchema>;
export type SecurityAssessment = z.infer<typeof SecurityAssessmentSchema>;
export type TriageClassification = z.infer<typeof TriageClassificationSchema>;
export type TriageDisposition = z.infer<typeof TriageDispositionSchema>;
export type TriageProposal = z.infer<typeof TriageProposalSchema>;
export type TriageReport = z.infer<typeof TriageReportSchema>;
