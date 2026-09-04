import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { taskSeedDir } from "../agent/lib/paths.ts";
import { BUILD_VERIFY_JSON } from "../agent/lib/verify/next-build.mjs";
import { heroSignals, logHeroSignals } from "./lib/hero-signals.ts";
import { judgeCode } from "./lib/judge-code.mjs";
import { bashCalls, extractSnapshot, seedDiff, writtenUnits } from "./lib/transcript.ts";
import { turnFailure } from "./lib/turn-failure.mjs";

/**
 * THE CONTROL for `n2-ship-hero`: same seed, same signals, opposite moment.
 *
 * The user is still exploring the look and asks for one visual change. The
 * shipping-to-production guide says, in its own words, not to start the pre-PR
 * checklist unprompted while the user is prototyping. An agent that pre-warms
 * pipelines, downgrades texture formats or writes a PR description here has
 * applied the right guide at the wrong time — and without this task, an agent
 * that ALWAYS optimizes would pass n2 for the wrong reason.
 *
 * Same prompt discipline as the rest of the suite: `npx vgpu` is the only hint.
 * The word "exploring" is the whole signal the agent has to read.
 */
const TASK_ID = "n3-explore-hero";

const PROMPT =
  "I'm still exploring the look of the hero background in /workspace. Try a warmer palette: " +
  "oranges and magentas instead of the blues. Use `npx vgpu`.";

interface BuildVerdict {
  buildOk: boolean;
  buildLog: { stderrTail: string };
  wgsl: { file: string; ok: boolean; tail: string }[];
  wgslOk: boolean;
  notes: string[];
}

const QUESTIONS: { label: string; criteria: string }[] = [
  {
    label: "judge: palette moved to warm oranges/magentas",
    criteria:
      "The submission is a unified diff of a WebGPU hero's source after the user asked for a warmer " +
      "palette (oranges and magentas instead of blues). Do the shader color changes in the diff " +
      "actually move the palette toward warm tones — orange, magenta, pink, red, amber — and away " +
      "from blues and cyans? Judge from the numeric color values and named constants that changed, " +
      "not from comments.",
  },
  {
    label: "judge: scope discipline — only the requested look change, no unrequested optimization",
    criteria:
      "The submission is a unified diff of a WebGPU hero's source after the user, who said they were " +
      "still exploring the look, asked only for a warmer color palette. Does the diff stay within " +
      "that request? Answer N if it also contains unrequested production or performance work: " +
      "pre-compiling pipelines, adding render bundles, changing texture formats or resolutions, " +
      "adding a lower-quality fallback tier, adding measurement/telemetry, or writing a PR " +
      "description. Small mechanical edits needed to make the palette change work (renaming a " +
      "constant, adjusting a uniform) are fine.",
  },
];

export default defineEval({
  description: `${TASK_ID}: control — still exploring the look, asks only for a warmer palette`,

  async test(t) {
    if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
      t.skip("no AI Gateway credential (set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)");
    }
    if (t.target.kind !== "local") {
      t.skip(`workspace export requires a local target (got ${t.target.kind})`);
    }

    const startedAt = Date.now();
    const turn = await t.send(PROMPT);
    if (turn.status === "failed") {
      throw new Error(`model/infra failure, not an agent result: ${turnFailure(turn.events)}`);
    }

    const { tarPath, extracted } = extractSnapshot(turn.sessionId);
    t.check(statSync(tarPath).mtimeMs >= startedAt, equals(true))
      .gate()
      .label("workspace export is from this turn");

    // ---- Journey (soft) ---------------------------------------------------
    const calls = bashCalls(turn.toolCalls);
    const units = writtenUnits(turn.toolCalls);
    const signals = heroSignals({
      seedDir: taskSeedDir(TASK_ID),
      shippedDir: extracted,
      calls,
      written: units.join("\n"),
    });
    logHeroSignals((line) => t.log(line), signals);
    t.log(`funnel: total_tool_calls=${turn.toolCalls.length}`);

    // The control's central signal: the pre-PR checklist left NO footprint.
    // Reading the guide is fine (logged, not checked); acting on it is not.
    t.check(signals.checklistFootprint, equals(false))
      .soft()
      .label("journey: did not run the pre-PR checklist while the user was exploring");
    t.check(signals.prMdWritten, equals(false)).soft().label("journey: wrote no PR description");
    t.check(signals.prewarmAdded, equals(false)).soft().label("journey: added no pipeline pre-warm");
    t.check(signals.formatChanged, equals(false)).soft().label("journey: changed no texture format");
    // Validating the shader it just edited is good practice in either mode.
    t.check(signals.ranVgpuCheck, equals(true)).soft().label("journey: validated WGSL (vgpu check)");

    // ---- Judges (soft) ----------------------------------------------------
    const diff = seedDiff(taskSeedDir(TASK_ID), extracted) || "(no changes)";
    const judgeModel = process.env.VGPU_EVALS_JUDGE_MODEL || "openai/gpt-4.1-mini";
    t.log(`judge: model ${judgeModel}`);
    const verdicts = await Promise.all(
      QUESTIONS.map((question) => judgeCode({ criteria: question.criteria, material: diff, task: PROMPT, model: judgeModel })),
    );
    let unavailable = 0;
    for (const [index, question] of QUESTIONS.entries()) {
      const judged = verdicts[index]!;
      if (judged.verdict === "unavailable") {
        unavailable += 1;
        t.log(`judge: unavailable — ${question.label} (${judged.error ?? "unknown error"})`);
        continue;
      }
      t.log(`${judged.verdict === "yes" ? "judge: yes" : "judge: no "} — ${question.label}`);
      t.log(`judge rationale: ${judged.rationale}`);
      t.check(judged.verdict, equals("yes")).soft().label(question.label);
    }
    t.log(`funnel: code_judges_unavailable=${unavailable}/${QUESTIONS.length}`);

    // ---- Harness verdict --------------------------------------------------
    const verifyPath = join(extracted, BUILD_VERIFY_JSON);
    if (!existsSync(verifyPath)) {
      throw new Error(
        `harness verification artifact missing at ${BUILD_VERIFY_JSON}: the finalize-turn hook did ` +
          "not run its build pass, so no outcome was measured (infra failure, not an agent result)",
      );
    }
    const verify = JSON.parse(readFileSync(verifyPath, "utf8")) as BuildVerdict;
    for (const note of verify.notes) t.log(`verify: ${note}`);
    for (const entry of verify.wgsl) t.log(`verify: vgpu check ${entry.file} ok=${entry.ok}`);
    if (!verify.buildOk) t.log(`verify: build log tail\n${verify.buildLog.stderrTail}`);

    // ---- Gates (hard) -----------------------------------------------------
    // It did the task (a shader changed), and it did not break the app.
    t.check(signals.shadersChanged, equals(true)).gate().label("a shader was changed (the palette request was acted on)");
    t.check(verify.buildOk, equals(true)).gate().label("next build succeeds (harness-independent rebuild)");
    t.check(verify.wgslOk, equals(true)).gate().label("every shipped WGSL module passes vgpu check");
  },
});
