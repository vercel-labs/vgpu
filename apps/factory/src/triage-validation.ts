import { isDeepStrictEqual } from "node:util";
import type { MessageStreamEvent } from "eve/client";
import {
  SecurityAssessmentSchema,
  TriageProposalSchema,
  TriageReportSchema,
  type NormalizedTriageInput,
  type SecurityAssessment,
  type TriageProposal,
  type TriageReport,
} from "../agent/lib/triage-schema.ts";
import { SECURITY_SUBAGENT_NAME } from "./constants.ts";
import { FactoryRuntimeError } from "./errors.ts";

export interface AgentTurnResult {
  readonly status: "completed" | "failed" | "waiting";
  readonly data: unknown;
  readonly events: readonly MessageStreamEvent[];
  readonly inputRequests: readonly unknown[];
  readonly sessionId: string;
  readonly message?: string;
}

const UNSUCCESSFUL_EVENT_TYPES = new Set<MessageStreamEvent["type"]>([
  "step.failed",
  "turn.failed",
  "session.failed",
  "turn.cancelled",
]);

function validateSuccessfulLifecycle(result: AgentTurnResult): void {
  if (result.status === "failed") {
    throw new FactoryRuntimeError(
      `Eve triage turn ended with status ${JSON.stringify(result.status)}.`
    );
  }

  const unsuccessfulEvent = result.events.find((event) =>
    UNSUCCESSFUL_EVENT_TYPES.has(event.type)
  );
  if (unsuccessfulEvent !== undefined) {
    throw new FactoryRuntimeError(
      `Eve triage turn emitted ${JSON.stringify(
        unsuccessfulEvent.type
      )} before its session boundary.`
    );
  }

  if (
    result.inputRequests.length > 0 ||
    result.events.some(
      (event) =>
        event.type === "input.requested" ||
        event.type === "authorization.required" ||
        event.type === "authorization.completed"
    )
  ) {
    throw new FactoryRuntimeError(
      "Eve triage turn requested interactive input or authorization."
    );
  }

  const failedAction = result.events.find(
    (event) =>
      event.type === "action.result" && event.data.status !== "completed"
  );
  if (failedAction !== undefined) {
    throw new FactoryRuntimeError(
      "Eve triage turn contained an unsuccessful action result."
    );
  }

  const expectedBoundary =
    result.status === "waiting" ? "session.waiting" : "session.completed";
  if (result.events.at(-1)?.type !== expectedBoundary) {
    throw new FactoryRuntimeError(
      `Eve triage turn did not end at its expected ${expectedBoundary} boundary.`
    );
  }

  const completedResults = result.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "result.completed");
  const completedTurns = result.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "turn.completed");
  if (completedResults.length !== 1 || completedTurns.length !== 1) {
    throw new FactoryRuntimeError(
      "Eve triage turn must contain exactly one completed result and turn."
    );
  }

  const completedResult = completedResults[0]!;
  const completedTurn = completedTurns[0]!;
  if (
    completedResult.event.type !== "result.completed" ||
    (result.data !== undefined &&
      !isDeepStrictEqual(completedResult.event.data.result, result.data))
  ) {
    throw new FactoryRuntimeError(
      "Eve triage result does not match its completed-result event."
    );
  }
  if (completedResult.index >= completedTurn.index) {
    throw new FactoryRuntimeError(
      "Eve triage result must complete before the turn boundary."
    );
  }
  if (completedTurn.index !== result.events.length - 2) {
    throw new FactoryRuntimeError(
      "Eve triage turn completion must immediately precede its session boundary."
    );
  }
  if (
    completedResult.event.type !== "result.completed" ||
    completedTurn.event.type !== "turn.completed" ||
    completedResult.event.data.turnId !== completedTurn.event.data.turnId ||
    completedResult.event.data.sequence !== completedTurn.event.data.sequence
  ) {
    throw new FactoryRuntimeError(
      "Eve triage result and turn completion events are incoherent."
    );
  }
}

function parseSecurityOutput(output: unknown): SecurityAssessment {
  if (typeof output !== "string") {
    throw new FactoryRuntimeError(
      "Security subagent completed without a string output."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch (error) {
    throw new FactoryRuntimeError(
      "Security subagent returned malformed JSON.",
      { cause: error }
    );
  }

  try {
    return SecurityAssessmentSchema.parse(parsed);
  } catch (error) {
    throw new FactoryRuntimeError(
      "Security subagent returned an invalid assessment.",
      { cause: error }
    );
  }
}

function validateSecurityCallInput(
  input: unknown,
  context: NormalizedTriageInput
): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new FactoryRuntimeError(
      "Security-subagent call input is not an object."
    );
  }
  const inputRecord = input as Record<string, unknown>;
  if (
    Object.keys(inputRecord).length !== 1 ||
    typeof inputRecord.message !== "string"
  ) {
    throw new FactoryRuntimeError(
      "Security-subagent call must contain only a message with the complete normalized context and no custom output schema."
    );
  }

  if (inputRecord.message !== JSON.stringify(context)) {
    throw new FactoryRuntimeError(
      "Security-subagent message must exactly match the canonical compact normalized-context JSON."
    );
  }
}

export function validateSecurityDelegation(
  events: readonly MessageStreamEvent[],
  context: NormalizedTriageInput,
  parentSessionId?: string
): SecurityAssessment {
  const requestedEvents = events.flatMap((event, index) =>
    event.type === "actions.requested" ? [{ event, index }] : []
  );
  const requestedActions = requestedEvents.flatMap(
    ({ event }) => event.data.actions
  );
  const unexpectedAction = requestedActions.find(
    (action) =>
      action.kind !== "subagent-call" ||
      action.subagentName !== SECURITY_SUBAGENT_NAME ||
      action.name !== SECURITY_SUBAGENT_NAME
  );
  if (unexpectedAction !== undefined) {
    throw new FactoryRuntimeError(
      "Agent attempted an action outside the security-only tool surface."
    );
  }

  const unexpectedInlineEvent = events.find(
    (event) =>
      event.type === "subagent.started" || event.type === "subagent.event"
  );
  if (unexpectedInlineEvent !== undefined) {
    throw new FactoryRuntimeError(
      "Agent emitted an unexpected inline-subagent lifecycle event."
    );
  }

  const called = events.flatMap((event, index) =>
    event.type === "subagent.called" ? [{ event, index }] : []
  );
  const completed = events.flatMap((event, index) =>
    event.type === "subagent.completed" ? [{ event, index }] : []
  );
  const actionResults = events.flatMap((event, index) =>
    event.type === "action.result" ? [{ event, index }] : []
  );

  if (
    requestedEvents.length !== 1 ||
    requestedActions.length !== 1 ||
    called.length !== 1 ||
    completed.length !== 1 ||
    actionResults.length !== 1
  ) {
    throw new FactoryRuntimeError(
      "Agent must request, start, complete, and project exactly one security-subagent call."
    );
  }

  const requestedSecurityCall = requestedActions[0]!;
  if (requestedSecurityCall.kind !== "subagent-call") {
    throw new FactoryRuntimeError(
      "Agent attempted an action outside the security-only tool surface."
    );
  }
  validateSecurityCallInput(requestedSecurityCall.input, context);
  const requestedCallId = requestedSecurityCall.callId;
  const calledEvent = called[0]!.event;
  const completedEvent = completed[0]!.event;
  const actionResultEvent = actionResults[0]!.event;
  if (
    calledEvent.data.callId !== requestedCallId ||
    calledEvent.data.name !== SECURITY_SUBAGENT_NAME ||
    calledEvent.data.toolName !== SECURITY_SUBAGENT_NAME ||
    calledEvent.data.remote !== undefined ||
    completedEvent.data.callId !== requestedCallId ||
    completedEvent.data.subagentName !== SECURITY_SUBAGENT_NAME ||
    actionResultEvent.data.result.kind !== "subagent-result" ||
    actionResultEvent.data.status !== "completed" ||
    actionResultEvent.data.result.callId !== requestedCallId ||
    actionResultEvent.data.result.subagentName !== SECURITY_SUBAGENT_NAME ||
    actionResultEvent.data.result.isError === true
  ) {
    throw new FactoryRuntimeError(
      "Security-subagent lifecycle events do not describe one successful local call."
    );
  }
  if (
    parentSessionId !== undefined &&
    calledEvent.data.sessionId !== parentSessionId
  ) {
    throw new FactoryRuntimeError(
      "Security subagent was not called from the active parent session."
    );
  }

  const rootResultIndex = events.findIndex(
    (event) => event.type === "result.completed"
  );
  const orderedIndexes = [
    requestedEvents[0]!.index,
    called[0]!.index,
    completed[0]!.index,
    actionResults[0]!.index,
    ...(rootResultIndex === -1 ? [] : [rootResultIndex]),
  ];
  if (
    orderedIndexes.some(
      (index, position) =>
        position > 0 && index <= orderedIndexes[position - 1]!
    )
  ) {
    throw new FactoryRuntimeError(
      "Security-subagent lifecycle events are out of order."
    );
  }

  const requestedEvent = requestedEvents[0]!.event;
  const turnEvents = [
    requestedEvent,
    calledEvent,
    actionResultEvent,
    ...events.filter(
      (event) =>
        event.type === "result.completed" || event.type === "turn.completed"
    ),
  ];
  if (
    turnEvents.some(
      (event) =>
        event.data.turnId !== requestedEvent.data.turnId ||
        event.data.sequence !== requestedEvent.data.sequence
    )
  ) {
    throw new FactoryRuntimeError(
      "Security-subagent lifecycle does not belong to the completed triage turn."
    );
  }

  const security = parseSecurityOutput(completedEvent.data.output);
  if (!isDeepStrictEqual(actionResultEvent.data.result.output, security)) {
    throw new FactoryRuntimeError(
      "Security-subagent action result does not match its completed output."
    );
  }
  return security;
}

function assertProposalCrossFields(
  proposal: TriageProposal,
  context: NormalizedTriageInput
): void {
  const allowedSourceIds = new Set(context.availableSourceIds);
  for (const evidence of proposal.evidence) {
    if (!allowedSourceIds.has(evidence.sourceId)) {
      throw new FactoryRuntimeError(
        `Triage evidence cites unknown source ID ${JSON.stringify(
          evidence.sourceId
        )}.`
      );
    }
  }

  const availableLabels = new Set(
    context.availableLabels.map((label) => label.name)
  );
  if (
    !context.capabilities.labelsAvailable &&
    proposal.proposedLabels.length > 0
  ) {
    throw new FactoryRuntimeError(
      "Agent proposed labels while the label catalog was unavailable."
    );
  }
  for (const label of proposal.proposedLabels) {
    if (!availableLabels.has(label)) {
      throw new FactoryRuntimeError(
        `Agent proposed unknown label ${JSON.stringify(label)}.`
      );
    }
  }

  const duplicateCandidate =
    proposal.duplicateOf === null
      ? undefined
      : context.duplicateCandidates.find(
          (candidate) =>
            candidate.number === proposal.duplicateOf!.number &&
            candidate.url === proposal.duplicateOf!.url
        );
  if (proposal.duplicateOf !== null && duplicateCandidate === undefined) {
    throw new FactoryRuntimeError(
      "Agent selected a duplicate that was not returned by the trusted search."
    );
  }

  if (!context.capabilities.duplicateSearchAvailable) {
    if (
      proposal.duplicateOf !== null ||
      proposal.classification === "duplicate-candidate" ||
      proposal.disposition === "propose-close-duplicate"
    ) {
      throw new FactoryRuntimeError(
        "Agent made a duplicate recommendation while duplicate search was unavailable."
      );
    }
  }

  if (
    proposal.classification === "duplicate-candidate" &&
    proposal.duplicateOf === null
  ) {
    throw new FactoryRuntimeError(
      "A duplicate-candidate classification must identify a trusted candidate."
    );
  }
  if (
    proposal.duplicateOf !== null &&
    proposal.classification !== "duplicate-candidate"
  ) {
    throw new FactoryRuntimeError(
      "A selected duplicate requires the duplicate-candidate classification."
    );
  }

  if (proposal.disposition === "propose-close-duplicate") {
    if (
      proposal.confidence !== "high" ||
      proposal.classification !== "duplicate-candidate" ||
      proposal.duplicateOf === null ||
      duplicateCandidate === undefined
    ) {
      throw new FactoryRuntimeError(
        "Closing as duplicate requires a high-confidence trusted duplicate candidate."
      );
    }
  }

  const hasSecurityConcern = proposal.security.verdict !== "clear";
  if (
    hasSecurityConcern &&
    (proposal.classification !== "security-review" ||
      proposal.disposition !== "escalate-security")
  ) {
    throw new FactoryRuntimeError(
      "A non-clear security verdict must force security review and escalation."
    );
  }
  if (
    !hasSecurityConcern &&
    (proposal.classification === "security-review" ||
      proposal.disposition === "escalate-security")
  ) {
    throw new FactoryRuntimeError(
      "Security review and escalation require a non-clear security verdict."
    );
  }
}

export function validateAgentTurn(
  result: AgentTurnResult,
  context: NormalizedTriageInput
): TriageProposal {
  // Eve reports a successfully settled interactive turn as `waiting` when its
  // durable session parks for a possible follow-up. Validate the event stream,
  // not that status in isolation: failures, cancellation, and HITL can also
  // reach a waiting boundary.
  validateSuccessfulLifecycle(result);
  if (result.data === undefined) {
    throw new FactoryRuntimeError(
      "Eve triage turn completed without structured output."
    );
  }

  let proposal: TriageProposal;
  try {
    proposal = TriageProposalSchema.parse(result.data);
  } catch (error) {
    throw new FactoryRuntimeError(
      "Eve triage turn returned an invalid proposal.",
      { cause: error }
    );
  }

  const delegatedSecurity = validateSecurityDelegation(
    result.events,
    context,
    result.sessionId
  );
  if (!isDeepStrictEqual(delegatedSecurity, proposal.security)) {
    throw new FactoryRuntimeError(
      "Root triage security result does not exactly match the security subagent output."
    );
  }

  assertProposalCrossFields(proposal, context);
  return proposal;
}

export function assembleTriageReport(
  context: NormalizedTriageInput,
  proposal: TriageProposal
): TriageReport {
  try {
    return TriageReportSchema.parse({
      schemaVersion: 1,
      mode: "dry-run",
      repository: context.repository,
      issue: { number: context.issue.number, url: context.issue.url },
      contextWarnings: context.contextWarnings,
      ...proposal,
    });
  } catch (error) {
    throw new FactoryRuntimeError(
      "Unable to assemble the host-owned triage report.",
      { cause: error }
    );
  }
}
