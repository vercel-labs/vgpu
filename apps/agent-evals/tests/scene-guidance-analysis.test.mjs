import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSceneGuidance, CONTENT_MARKERS, assertMarkerSeparation } from "../scripts/analyze-scene-guidance.mjs";

const result = (output, toolName = "bash", id = "one") => ({
  type: "action.result", meta: { id }, data: {
    turnId: "turn_0", stepIndex: 3,
    result: { kind: "tool-result", callId: id, toolName, output },
  },
});

test("exposure uses delivered results, not commands, assistant text, or write inputs", () => {
  const marker = CONTENT_MARKERS[0];
  const events = [
    { type: "actions.requested", data: { actions: [{ toolName: "bash", input: { command: "npx vgpu docs cat scene-math" } }] } },
    { type: "message.completed", data: { text: marker } },
    { type: "actions.requested", data: { actions: [{ toolName: "write_file", input: { content: marker } }] } },
    result({ stdout: "not found", stderr: "", exitCode: 1 }),
    result({ stdout: "[stdout truncated: showing last 10 lines]\nrest of old guide", stderr: "" }, "bash", "two"),
  ];
  assert.equal(analyzeSceneGuidance(events, "baseline").exposure.tier, "none");
});

test("titles surface a guide; actual section headings establish content delivery across tools", () => {
  assert.equal(analyzeSceneGuidance([result({ stdout: "Using math with scene data /guides/scene-math.docs.md" })], "math").exposure.tier, "surfaced");
  for (const tool of ["bash", "read_file", "web_search"]) {
    const report = analyzeSceneGuidance([result({ text: CONTENT_MARKERS[2] }, tool)], "math");
    assert.equal(report.exposure.tier, "content");
    assert.deepEqual(report.exposure.sections, [CONTENT_MARKERS[2]]);
    assert.deepEqual(report.exposure.firstContent, { turnId: "turn_0", stepIndex: 3 });
    assert.equal(report.exposure.deliveries[0].tool, tool);
  }
});

test("real tool shapes preserve turn coordinates, truncation, and uncertain baseline sightings", () => {
  const first = result({ content: `1: ${CONTENT_MARKERS[0]}\n2: paragraph` }, "read_file", "first");
  const second = result({ search_id: "search", results: [{ title: "Guide", excerpts: [CONTENT_MARKERS[1]] }] }, "web_search", "second");
  second.data.turnId = "turn_1";
  second.data.stepIndex = 0;
  const truncated = result({ stdout: CONTENT_MARKERS[2], truncated: true }, "bash", "third");
  const report = analyzeSceneGuidance([first, second, truncated], "math");
  assert.deepEqual(report.exposure.perTurn.map(t => t.firstContent), [{ turnId: "turn_0", stepIndex: 3 }, { turnId: "turn_1", stepIndex: 0 }]);
  assert.equal(report.exposure.deliveries[2].truncated, true);
  const uncertain = analyzeSceneGuidance([result({ stderr: "ls: cannot access scene-math.md" })], "baseline");
  assert.equal(uncertain.contamination, false);
  assert.equal(uncertain.possibleContamination, true);
});

test("baseline content is flagged as contamination; failed lookup echo is not exposure", () => {
  assert.equal(analyzeSceneGuidance([result(CONTENT_MARKERS[0])], "baseline").contamination, true);
  assert.equal(analyzeSceneGuidance([result({ stderr: "Document not found: /guides/scene-math.docs.md", exitCode: 1 })], "baseline").contamination, false);
});

test("events deduplicate by id and report usage, tools and possible package replacement separately", () => {
  const step = { type: "step.completed", meta: { id: "s" }, data: { usage: { costUsd: 0.5, outputTokens: 10 } } };
  const calls = { type: "actions.requested", meta: { id: "c" }, data: { actions: [
    { toolName: "bash", input: { command: "npx vgpu docs find math" } },
    { toolName: "bash", input: { command: "npm install math@0.1.0" } },
    { toolName: "bash", input: { command: "npm install vgpu@latest" } },
    { toolName: "bash", input: { command: "npm ci" } },
  ] } };
  const report = analyzeSceneGuidance([step, step, calls, calls], "math");
  assert.equal(report.steps, 1);
  assert.equal(report.usage.costUsd, 0.5);
  assert.equal(report.toolCounts.bash, 4);
  assert.equal(report.packageReplacementHints.length, 2);
  assert.equal(report.docsCommands, 1);
});

test("content markers cannot occur in baseline or treatment discovery metadata", () => {
  const baseline = { records: [{ content: "existing guide", summary: "old" }] };
  const treatment = { records: [{ content: CONTENT_MARKERS.join("\n"), summary: "Using math with scene data" }] };
  assert.doesNotThrow(() => assertMarkerSeparation(baseline, treatment));
  assert.throws(() => assertMarkerSeparation({ records: [{ content: CONTENT_MARKERS[0] }] }, treatment));
  assert.throws(() => assertMarkerSeparation(baseline, { records: [{ summary: CONTENT_MARKERS[1] }] }));
});
