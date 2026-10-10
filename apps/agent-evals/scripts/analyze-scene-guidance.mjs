#!/usr/bin/env node
// Observational transcript metrics, never correctness gates. Source adoption
// still needs semantic review; delivery of text does not establish understanding.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTENT_MARKERS = [
  "## Choose who owns each operation",
  "## Pass a math matrix into an instance",
  "## Write local transforms into an external hierarchy",
  "## Read a vgpu matrix with math",
  "## Match camera and matrix conventions",
  "### Scope and external math",
];
const SURFACED_MARKERS = ["scene-math", "Using math with scene data"];

export function assertMarkerSeparation(baseline, treatment) {
  const previous = JSON.stringify(baseline);
  const discovery = JSON.stringify((treatment.records ?? []).map(({ summary, snippet, keywords }) => ({ summary, snippet, keywords })));
  for (const marker of CONTENT_MARKERS) {
    if (previous.includes(marker) || discovery.includes(marker)) {
      throw new Error(`Content marker is not unique to treatment body: ${marker}`);
    }
    if (!(treatment.records ?? []).some((record) => record.content?.includes(marker))) {
      throw new Error(`Treatment body is missing content marker: ${marker}`);
    }
  }
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(outputText).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(outputText).join("\n");
  return "";
}

export function analyzeSceneGuidance(inputEvents, condition) {
  if (!["baseline", "math"].includes(condition)) throw new Error("Condition must be baseline or math");
  const seen = new Set();
  const events = inputEvents.filter((event) => {
    if (!event.meta?.id) return true;
    if (seen.has(event.meta.id)) return false;
    seen.add(event.meta.id);
    return true;
  });
  const calls = events.filter((e) => e.type === "actions.requested")
    .flatMap((e) => (e.data.actions ?? []).map((call) => ({ ...call, turnId: e.data.turnId })));
  const byId = new Map(calls.map((call) => [call.callId, call]));
  const steps = events.filter((e) => e.type === "step.completed");
  const usage = {};
  for (const step of steps) for (const [key, value] of Object.entries(step.data.usage ?? {})) {
    if (typeof value === "number") usage[key] = (usage[key] ?? 0) + value;
  }
  const deliveries = [];
  let surfaced = false;
  const sections = new Set();
  for (const event of events) {
    if (event.type !== "action.result" || event.data.result?.kind !== "tool-result") continue;
    const result = event.data.result;
    // An unsuccessful lookup can echo the guessed slug without exposing docs.
    const text = outputText(result.output).split("\n")
      .filter((line) => !/^(?:error[: ]*)?(?:document |docs? |path )?(?:not found|unknown)|(?:document|path) not found:/i.test(line.trim()))
      .join("\n");
    const found = CONTENT_MARKERS.filter((marker) => text.includes(marker));
    const hasTitle = SURFACED_MARKERS.some((marker) => text.includes(marker));
    if (!hasTitle && !found.length) continue;
    surfaced ||= hasTitle;
    for (const marker of found) sections.add(marker);
    deliveries.push({
      turnId: event.data.turnId,
      stepIndex: event.data.stepIndex ?? null,
      tool: result.toolName,
      callId: result.callId,
      command: byId.get(result.callId)?.input?.command ?? null,
      tier: found.length ? "content" : "surfaced",
      sections: found,
      truncated: result.output?.truncated === true || /\[.*truncated/i.test(text),
    });
  }
  const bash = calls.filter((call) => call.toolName === "bash");
  const packageReplacementHints = bash.filter((call) => {
    const command = call.input?.command ?? "";
    return /\bvgpu@|\bnpm\s+(?:i|install)\b[^\n]*\bvgpu\b|\bnpm\s+ci\b|\bnpx\s+-p\b|\brm\s+-rf\b[^\n]*node_modules/.test(command);
  }).map((call) => ({ turnId: call.turnId, command: call.input.command }));
  const tier = sections.size ? "content" : surfaced ? "surfaced" : "none";
  const firstContent = (items) => {
    const first = items.find((delivery) => delivery.tier === "content");
    return first ? { turnId: first.turnId, stepIndex: first.stepIndex } : null;
  };
  const turnIds = [...new Set(events.map((event) => event.data?.turnId).filter(Boolean))];
  const perTurn = turnIds.map((turnId) => {
    const items = deliveries.filter((delivery) => delivery.turnId === turnId);
    const headings = [...new Set(items.flatMap((delivery) => delivery.sections))];
    return { turnId, tier: headings.length ? "content" : items.length ? "surfaced" : "none", sections: headings, firstContent: firstContent(items) };
  });
  return {
    condition,
    eventCount: events.length,
    steps: steps.length,
    usage,
    observedModel: events.find((event) => event.type === "session.started")?.data.runtime?.modelId ?? null,
    generationIds: steps.map((step) => step.data.providerMetadata?.gateway?.generationId).filter(Boolean),
    toolCounts: Object.fromEntries([...new Set(calls.map((call) => call.toolName))]
      .map((name) => [name, calls.filter((call) => call.toolName === name).length])),
    docsCommands: bash.filter((call) => /\bvgpu\s+docs\b/.test(call.input?.command ?? "")).length,
    exposure: { tier, sections: [...sections], firstContent: firstContent(deliveries), perTurn, deliveries },
    contamination: condition === "baseline" && tier === "content",
    possibleContamination: condition === "baseline" && tier === "surfaced",
    packageReplacementHints,
    limitations: [
      "Markers measure delivered text, not comprehension or causation; excerpts without markers can be missed.",
      "Command patterns are possible replacement hints; use installed-corpus hashes and transcript review to assess deviations.",
      "Source adoption and handwritten math require independent semantic review.",
      "Surfaced detection uses the guide slug/title, not all summary or keyword text; baseline surfaced-only hits require manual confirmation.",
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [eventsPath, condition, outputPath] = process.argv.slice(2);
  if (!eventsPath || !outputPath) throw new Error("Usage: analyze-scene-guidance.mjs <events.ndjson> <baseline|math> <output.json>");
  const events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const report = analyzeSceneGuidance(events, condition);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, steps: report.steps, costUsd: report.usage.costUsd, exposure: report.exposure.tier, contamination: report.contamination }));
}
