import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import type {
  NormalizedTriageInput,
  SecurityAssessment,
  TriageProposal,
} from "../agent/lib/triage-schema.ts";
import {
  assembleTriageReport,
  validateAgentTurn,
  validateSecurityDelegation,
  type AgentTurnResult,
} from "../src/triage-validation.ts";
import {
  CLEAR_SECURITY,
  makeContext,
  makeEvents,
  makeProposal,
} from "./test-helpers.ts";

type SuccessStatus = "completed" | "waiting";

function makeLifecycleEvents(
  proposal: unknown,
  status: SuccessStatus
): MessageStreamEvent[] {
  return [
    {
      type: "result.completed",
      data: {
        result: proposal,
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      },
    },
    {
      type: "turn.completed",
      data: { sequence: 0, turnId: "turn-1" },
    },
    status === "waiting"
      ? {
          type: "session.waiting",
          data: {
            continuationToken: "eve:test",
            wait: "next-user-message",
          },
        }
      : { type: "session.completed" },
  ] as MessageStreamEvent[];
}

function result(
  context: NormalizedTriageInput,
  proposal: TriageProposal = makeProposal(),
  status: SuccessStatus = "waiting"
): AgentTurnResult {
  return {
    status,
    data: proposal,
    events: [
      ...makeEvents(context, proposal.security),
      ...makeLifecycleEvents(proposal, status),
    ],
    inputRequests: [],
    sessionId: "parent-1",
  };
}

function replaceResultData(
  turn: AgentTurnResult,
  data: unknown
): AgentTurnResult {
  return {
    ...turn,
    data,
    events: turn.events.map((event) =>
      event.type === "result.completed"
        ? ({
            ...event,
            data: { ...event.data, result: data },
          } as MessageStreamEvent)
        : event
    ),
  };
}

function insertBeforeBoundary(
  turn: AgentTurnResult,
  event: MessageStreamEvent
): AgentTurnResult {
  return {
    ...turn,
    events: [...turn.events.slice(0, -1), event, turn.events.at(-1)!],
  };
}

describe("validateSecurityDelegation", () => {
  it("accepts exactly one completed canonical security delegation", () => {
    const context = makeContext();
    expect(validateSecurityDelegation(makeEvents(context), context)).toEqual(
      CLEAR_SECURITY
    );
  });

  it("rejects omitted, altered, and non-canonical delegated context", () => {
    const context = makeContext();
    expect(() =>
      validateSecurityDelegation(
        makeEvents(context, CLEAR_SECURITY, { input: { message: "{}" } }),
        context
      )
    ).toThrow("exactly match");
    const altered = structuredClone(context);
    altered.issue.body = "different";
    expect(() =>
      validateSecurityDelegation(
        makeEvents(context, CLEAR_SECURITY, {
          input: { message: JSON.stringify(altered) },
        }),
        context
      )
    ).toThrow("exactly match");
    expect(() =>
      validateSecurityDelegation(
        makeEvents(context, CLEAR_SECURITY, { input: { message: "not-json" } }),
        context
      )
    ).toThrow("exactly match");
    expect(() =>
      validateSecurityDelegation(
        makeEvents(context, CLEAR_SECURITY, {
          input: { message: JSON.stringify(context, null, 2) },
        }),
        context
      )
    ).toThrow("canonical compact");
  });

  it("rejects a custom output schema or any other extra subagent input", () => {
    const context = makeContext();
    expect(() =>
      validateSecurityDelegation(
        makeEvents(context, CLEAR_SECURITY, {
          input: {
            message: JSON.stringify(context),
            outputSchema: { type: "string" },
          },
        }),
        context
      )
    ).toThrow("no custom output schema");
  });

  it("rejects missing, repeated, or mismatched lifecycle events", () => {
    const context = makeContext();
    const events = makeEvents(context);
    expect(() =>
      validateSecurityDelegation(
        events.filter((event) => event.type !== "subagent.completed"),
        context
      )
    ).toThrow("exactly one");
    expect(() =>
      validateSecurityDelegation([...events, ...events], context)
    ).toThrow("exactly one");

    const mismatch = structuredClone(events) as MessageStreamEvent[];
    const completed = mismatch.find(
      (event) => event.type === "subagent.completed"
    );
    if (completed?.type === "subagent.completed")
      completed.data.callId = "another-call";
    expect(() => validateSecurityDelegation(mismatch, context)).toThrow(
      "successful local call"
    );
  });

  it("requires one matching, ordered security action result", () => {
    const context = makeContext();
    const events = makeEvents(context);
    expect(() =>
      validateSecurityDelegation(
        events.filter((event) => event.type !== "action.result"),
        context
      )
    ).toThrow("project exactly one");

    const mismatched = structuredClone(events) as MessageStreamEvent[];
    const actionResult = mismatched.find(
      (event) => event.type === "action.result"
    );
    if (
      actionResult?.type === "action.result" &&
      actionResult.data.result.kind === "subagent-result"
    ) {
      actionResult.data.result.output = {
        ...CLEAR_SECURITY,
        reason: "Different projected result.",
      };
    }
    expect(() => validateSecurityDelegation(mismatched, context)).toThrow(
      "does not match its completed output"
    );

    const reordered = structuredClone(events) as MessageStreamEvent[];
    const completedIndex = reordered.findIndex(
      (event) => event.type === "subagent.completed"
    );
    const actionResultIndex = reordered.findIndex(
      (event) => event.type === "action.result"
    );
    [reordered[completedIndex], reordered[actionResultIndex]] = [
      reordered[actionResultIndex]!,
      reordered[completedIndex]!,
    ];
    expect(() => validateSecurityDelegation(reordered, context)).toThrow(
      "out of order"
    );
  });

  it("rejects foreign subagent lifecycle events and parent-session mismatches", () => {
    const context = makeContext();
    const events = makeEvents(context);
    const foreign = structuredClone(events) as MessageStreamEvent[];
    foreign.push({
      type: "subagent.started",
      data: { callId: "foreign", subagentName: "foreign" },
    } as MessageStreamEvent);
    expect(() => validateSecurityDelegation(foreign, context)).toThrow(
      "unexpected inline-subagent"
    );
    expect(() =>
      validateSecurityDelegation(events, context, "different-parent")
    ).toThrow("active parent session");
  });

  it("rejects malformed security output and all non-security actions", () => {
    const context = makeContext();
    expect(() =>
      validateSecurityDelegation(
        makeEvents(context, CLEAR_SECURITY, { output: "{malformed" }),
        context
      )
    ).toThrow("malformed JSON");

    const events = makeEvents(context);
    const requested = events.find(
      (event) => event.type === "actions.requested"
    );
    if (requested?.type === "actions.requested") {
      requested.data.actions = [
        { kind: "tool-call", callId: "bad", input: {}, toolName: "bash" },
      ];
    }
    expect(() => validateSecurityDelegation(events, context)).toThrow(
      "outside the security-only tool surface"
    );
  });
});

describe("validateAgentTurn", () => {
  it("validates structured output and exact security equality", () => {
    const context = makeContext();
    expect(validateAgentTurn(result(context), context)).toEqual(makeProposal());

    const differentSecurity: SecurityAssessment = {
      verdict: "clear",
      reason: "Different reason.",
      signals: [],
    };
    const successful = result(context);
    const mismatched: AgentTurnResult = {
      ...successful,
      events: [
        ...makeEvents(context, differentSecurity),
        ...makeLifecycleEvents(successful.data, "waiting"),
      ],
    };
    expect(() => validateAgentTurn(mismatched, context)).toThrow(
      "does not exactly match"
    );
  });

  it("accepts both Eve success boundaries and rejects a failed turn", () => {
    const context = makeContext();
    expect(validateAgentTurn(result(context), context)).toEqual(makeProposal());
    expect(
      validateAgentTurn(result(context, makeProposal(), "completed"), context)
    ).toEqual(makeProposal());
    expect(() =>
      validateAgentTurn({ ...result(context), status: "failed" }, context)
    ).toThrow('status "failed"');
  });

  it("rejects missing, mismatched, or repeated completion boundaries", () => {
    const context = makeContext();
    const waiting = result(context);
    expect(() =>
      validateAgentTurn(
        { ...waiting, events: waiting.events.slice(0, -1) },
        context
      )
    ).toThrow("expected session.waiting boundary");
    expect(() =>
      validateAgentTurn({ ...waiting, status: "completed" }, context)
    ).toThrow("expected session.completed boundary");

    const completedResult = waiting.events.find(
      (event) => event.type === "result.completed"
    )!;
    expect(() =>
      validateAgentTurn(insertBeforeBoundary(waiting, completedResult), context)
    ).toThrow("exactly one completed result and turn");

    const withoutTurn = waiting.events.filter(
      (event) => event.type !== "turn.completed"
    );
    expect(() =>
      validateAgentTurn({ ...waiting, events: withoutTurn }, context)
    ).toThrow("exactly one completed result and turn");

    const eventAfterTurn = insertBeforeBoundary(waiting, {
      type: "message.completed",
      data: {
        message: "late",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      },
    } as MessageStreamEvent);
    expect(() => validateAgentTurn(eventAfterTurn, context)).toThrow(
      "immediately precede"
    );
  });

  it("rejects failed, cancelled, interactive, and unsuccessful-action turns even when waiting", () => {
    const context = makeContext();
    const waiting = result(context);
    for (const type of [
      "step.failed",
      "turn.failed",
      "session.failed",
      "turn.cancelled",
    ] as const) {
      const failed = insertBeforeBoundary(waiting, {
        type,
        data: {},
      } as unknown as MessageStreamEvent);
      expect(() => validateAgentTurn(failed, context)).toThrow(
        `emitted ${JSON.stringify(type)}`
      );
    }

    expect(() =>
      validateAgentTurn({ ...waiting, inputRequests: [{}] }, context)
    ).toThrow("requested interactive input or authorization");

    for (const type of [
      "input.requested",
      "authorization.required",
      "authorization.completed",
    ] as const) {
      const interactive = insertBeforeBoundary(waiting, {
        type,
        data: {},
      } as unknown as MessageStreamEvent);
      expect(() => validateAgentTurn(interactive, context)).toThrow(
        "requested interactive input or authorization"
      );
    }

    const unsuccessfulAction = insertBeforeBoundary(waiting, {
      type: "action.result",
      data: {
        result: {
          callId: "security-call-1",
          kind: "subagent-result",
          output: "failed",
          subagentName: "issue_security_triager",
        },
        sequence: 4,
        stepIndex: 1,
        status: "failed",
        turnId: "turn-1",
      },
    } as MessageStreamEvent);
    expect(() => validateAgentTurn(unsuccessfulAction, context)).toThrow(
      "unsuccessful action result"
    );
  });

  it("requires the returned data to match the single completed-result event", () => {
    const context = makeContext();
    const mismatched: AgentTurnResult = {
      ...result(context),
      data: makeProposal({ summary: "A different result." }),
    };
    expect(() => validateAgentTurn(mismatched, context)).toThrow(
      "does not match its completed-result event"
    );
  });

  it("rejects missing and schema-invalid structured output", () => {
    const context = makeContext();
    expect(() =>
      validateAgentTurn({ ...result(context), data: undefined }, context)
    ).toThrow("without structured output");
    expect(() =>
      validateAgentTurn(
        replaceResultData(result(context), {
          classification: "confirmed-bug",
        }),
        context
      )
    ).toThrow("invalid proposal");
  });

  it("allows evidence only from supplied source IDs", () => {
    const context = makeContext();
    const proposal = makeProposal({
      evidence: [{ sourceId: "issue:999", statement: "Invented evidence." }],
    });
    expect(() => validateAgentTurn(result(context, proposal), context)).toThrow(
      "unknown source ID"
    );
  });

  it("allows only available labels and blocks labels when the catalog is unavailable", () => {
    const context = makeContext();
    expect(() =>
      validateAgentTurn(
        result(context, makeProposal({ proposedLabels: ["unknown"] })),
        context
      )
    ).toThrow("unknown label");

    const noLabels = makeContext({
      availableLabels: [],
      capabilities: { labelsAvailable: false, duplicateSearchAvailable: true },
    });
    expect(() => validateAgentTurn(result(noLabels), noLabels)).toThrow(
      "catalog was unavailable"
    );
  });

  it("requires trusted, high-confidence duplicate evidence", () => {
    const context = makeContext();
    const unknownDuplicate = makeProposal({
      classification: "duplicate-candidate",
      duplicateOf: {
        number: 999,
        url: "https://github.com/vercel-labs/vgpu/issues/999",
      },
    });
    expect(() =>
      validateAgentTurn(result(context, unknownDuplicate), context)
    ).toThrow("trusted search");

    const lowConfidenceClose = makeProposal({
      classification: "duplicate-candidate",
      confidence: "medium",
      duplicateOf: {
        number: 100,
        url: "https://github.com/vercel-labs/vgpu/issues/100",
      },
      disposition: "propose-close-duplicate",
    });
    expect(() =>
      validateAgentTurn(result(context, lowConfidenceClose), context)
    ).toThrow("invalid proposal");

    const validDuplicate = makeProposal({
      classification: "duplicate-candidate",
      confidence: "high",
      duplicateOf: {
        number: 100,
        url: "https://github.com/vercel-labs/vgpu/issues/100",
      },
      disposition: "propose-close-duplicate",
    });
    expect(validateAgentTurn(result(context, validDuplicate), context)).toEqual(
      validDuplicate
    );
  });

  it("prohibits duplicate-dependent recommendations when search is unavailable", () => {
    const context = makeContext({
      duplicateCandidates: [],
      availableSourceIds: ["issue:123"],
      capabilities: { labelsAvailable: true, duplicateSearchAvailable: false },
    });
    const proposal = makeProposal({ classification: "duplicate-candidate" });
    expect(() => validateAgentTurn(result(context, proposal), context)).toThrow(
      "duplicate recommendation"
    );
  });

  it("forces non-clear security results to security escalation and rejects the inverse", () => {
    const context = makeContext();
    const suspicious: SecurityAssessment = {
      verdict: "suspicious-content",
      reason: "The issue asks the agent to reveal secrets.",
      signals: ["Secret-exfiltration request"],
    };
    const notEscalated = makeProposal({ security: suspicious });
    expect(() =>
      validateAgentTurn(result(context, notEscalated), context)
    ).toThrow("invalid proposal");

    const clearButEscalated = makeProposal({
      classification: "security-review",
      disposition: "escalate-security",
    });
    expect(() =>
      validateAgentTurn(result(context, clearButEscalated), context)
    ).toThrow("require a non-clear");

    const escalated = makeProposal({
      security: suspicious,
      classification: "security-review",
      disposition: "escalate-security",
      proposedLabels: [],
    });
    expect(validateAgentTurn(result(context, escalated), context)).toEqual(
      escalated
    );

    const securityReport: SecurityAssessment = {
      verdict: "security-report",
      reason: "The issue alleges an isolation vulnerability.",
      signals: ["Isolation boundary bypass"],
    };
    const publicSecurityReply = makeProposal({
      security: securityReport,
      classification: "security-review",
      disposition: "escalate-security",
      proposedLabels: [],
      draftReply: "Please post more vulnerability details here.",
    });
    expect(() =>
      validateAgentTurn(result(context, publicSecurityReply), context)
    ).toThrow("invalid proposal");
  });
});

describe("assembleTriageReport", () => {
  it("owns repository, issue, warnings, version, and mode outside the model", () => {
    const context = makeContext({
      contextWarnings: ["Duplicate search degraded."],
    });
    const report = assembleTriageReport(context, makeProposal());
    expect(report).toMatchObject({
      schemaVersion: 1,
      mode: "dry-run",
      repository: { id: 1230165564, owner: "vercel-labs", name: "vgpu" },
      issue: {
        number: 123,
        url: "https://github.com/vercel-labs/vgpu/issues/123",
      },
      contextWarnings: ["Duplicate search degraded."],
    });
  });
});
