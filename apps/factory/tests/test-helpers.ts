import type { MessageStreamEvent } from "eve/client";
import type {
  NormalizedTriageInput,
  SecurityAssessment,
  TriageProposal,
  TriageReport,
} from "../agent/lib/triage-schema.ts";
import {
  FACTORY_REPOSITORY,
  SECURITY_SUBAGENT_NAME,
} from "../src/constants.ts";

export function makeContext(
  overrides: Partial<NormalizedTriageInput> = {}
): NormalizedTriageInput {
  const context: NormalizedTriageInput = {
    schemaVersion: 1,
    repository: FACTORY_REPOSITORY,
    issue: {
      number: 123,
      url: "https://github.com/vercel-labs/vgpu/issues/123",
      sourceId: "issue:123",
      title: "Rendering fails for a valid shader",
      body: "Expected pixels, received an empty image.",
      author: "reporter",
      createdAt: "2026-09-01T12:00:00Z",
      labels: [],
    },
    duplicateCandidates: [
      {
        number: 100,
        url: "https://github.com/vercel-labs/vgpu/issues/100",
        sourceId: "duplicate:100",
        title: "Rendering fails for valid shaders",
        bodyExcerpt: "The resulting image is empty.",
        state: "open",
      },
    ],
    availableLabels: [
      { name: "bug", description: "Something is not working" },
      { name: "duplicate", description: "This issue already exists" },
    ],
    availableSourceIds: ["issue:123", "duplicate:100"],
    contextWarnings: [],
    capabilities: { labelsAvailable: true, duplicateSearchAvailable: true },
    ...overrides,
  };
  return context;
}

export const CLEAR_SECURITY: SecurityAssessment = {
  verdict: "clear",
  reason: "The report contains ordinary technical details.",
  signals: [],
};

export function makeProposal(
  overrides: Partial<TriageProposal> = {}
): TriageProposal {
  return {
    security: CLEAR_SECURITY,
    classification: "bug-candidate",
    confidence: "medium",
    summary: "The report plausibly describes incorrect rendering behavior.",
    evidence: [
      {
        sourceId: "issue:123",
        statement: "The reporter expected pixels but received an empty image.",
      },
    ],
    missingInformation: [],
    duplicateOf: null,
    proposedLabels: ["bug"],
    disposition: "queue-investigation",
    draftReply:
      "Thanks for the report. A maintainer should investigate this behavior.",
    ...overrides,
  };
}

export function makeEvents(
  context: NormalizedTriageInput,
  security: SecurityAssessment = CLEAR_SECURITY,
  options: {
    callId?: string;
    input?: Record<string, unknown>;
    output?: unknown;
    sessionId?: string;
  } = {}
): MessageStreamEvent[] {
  const callId = options.callId ?? "security-call-1";
  const completedOutput =
    typeof options.output === "string"
      ? options.output
      : JSON.stringify(options.output ?? security);
  let projectedOutput: unknown = options.output ?? security;
  if (typeof projectedOutput === "string") {
    try {
      projectedOutput = JSON.parse(projectedOutput) as unknown;
    } catch {
      // Preserve malformed child output so validation can reject it.
    }
  }
  return [
    {
      type: "actions.requested",
      data: {
        actions: [
          {
            callId,
            description: "security",
            input: options.input ?? { message: JSON.stringify(context) },
            kind: "subagent-call",
            name: SECURITY_SUBAGENT_NAME,
            nodeId: "agent/subagents/issue_security_triager",
            subagentName: SECURITY_SUBAGENT_NAME,
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      },
    },
    {
      type: "subagent.called",
      data: {
        callId,
        childSessionId: "child-1",
        sessionId: options.sessionId ?? "parent-1",
        sequence: 0,
        name: SECURITY_SUBAGENT_NAME,
        toolName: SECURITY_SUBAGENT_NAME,
        turnId: "turn-1",
        workflowId: "workflow-1",
      },
    },
    {
      type: "subagent.completed",
      data: {
        callId,
        output: completedOutput,
        subagentName: SECURITY_SUBAGENT_NAME,
      },
    },
    {
      type: "action.result",
      data: {
        result: {
          callId,
          kind: "subagent-result",
          output: projectedOutput,
          subagentName: SECURITY_SUBAGENT_NAME,
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn-1",
      },
    },
  ] as MessageStreamEvent[];
}

export function makeReport(
  overrides: Partial<TriageReport> = {}
): TriageReport {
  const context = makeContext();
  return {
    schemaVersion: 1,
    mode: "dry-run",
    repository: context.repository,
    issue: { number: context.issue.number, url: context.issue.url },
    contextWarnings: [],
    ...makeProposal(),
    ...overrides,
  };
}
