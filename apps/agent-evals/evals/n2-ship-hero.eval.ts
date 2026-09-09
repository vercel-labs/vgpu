import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { taskSeedDir } from "../agent/lib/paths.ts";
import { BUILD_VERIFY_JSON } from "../agent/lib/verify/next-build.mjs";
import { heroSignals, logHeroSignals } from "./lib/hero-signals.ts";
import { judgeCode } from "./lib/judge-code.mjs";
import { bashCalls, capJudgeMaterial, extractSnapshot, seedDiff, writtenUnits } from "./lib/transcript.ts";
import { turnFailure } from "./lib/turn-failure.mjs";

/**
 * THE FINISHING MOMENT: a working hero is declared done and the agent is asked
 * to get it ready to merge.
 *
 * What this measures is whether, from `npx vgpu`, the agent finds the
 * shipping-to-production guide at the moment it is meant for and then behaves
 * the way it asks: run the correctness gates, measure, apply the free defaults
 * that change no pixels, and PROPOSE (not silently apply) anything that does.
 *
 * The seed (`agent/sandbox/tasks/n2-ship-hero/`) is a Next.js hero that
 * already renders an aurora with vgpu and is deliberately unoptimized in ways
 * the guide's sections 3 and 4 name: no `compile()` pre-warm, three
 * `rgba32float` targets where `rgba16float` would do, a two-pass blur at full
 * resolution, a continuous frame loop. Every one of those is a fork: a free
 * default the agent may apply, or a visible trade it must offer.
 *
 * The prompt names `npx vgpu` and nothing else, per the suite's rule. It also
 * names the deliverable (`PR.md`), because "prepare the PR" without a place to
 * put the description would be graded on a file the agent had no reason to
 * write. It does NOT say "checklist", "optimize", "measure" or "propose".
 *
 * TASK ID `n2-ship-hero` and its control `n3-explore-hero` share one seed and
 * one signal vocabulary (`lib/hero-signals.ts`); read them as a pair.
 */
const TASK_ID = "n2-ship-hero";

const PROMPT =
  "The hero background in /workspace looks good and is approved. Get it ready to merge: do " +
  "whatever you would do before opening the PR, then write the PR description to PR.md. " +
  "Use `npx vgpu`.";

/** Judge material is truncated per section so one huge blob cannot crowd out the rest. */
const JUDGE_SECTION_LIMIT = 2000;

interface BuildVerdict {
  buildOk: boolean;
  buildLog: { stderrTail: string };
  wgsl: { file: string; ok: boolean; tail: string }[];
  wgslOk: boolean;
  notes: string[];
}

/**
 * Code-semantics questions, one billed judge call each, all soft. Material is
 * the agent's own output and is passed strictly as the graded submission.
 */
const QUESTIONS: { label: string; criteria: string; material: "pr" | "diff+pr" | "work" }[] = [
  {
    label: "judge: PR description separates applied changes from proposals, each with a number",
    material: "pr",
    criteria:
      "The submission is a pull-request description written after preparing a working WebGPU hero " +
      "for merge. Does it (a) list at least one concrete measurement (a time in ms, an FPS value, a " +
      "byte or KB size, or a percentage) that was actually taken, and (b) clearly distinguish " +
      "changes that were APPLIED from cheaper alternatives that are only PROPOSED for the reviewer " +
      "to decide? Answer N if there is no measurement, or if applied and proposed changes are not " +
      "told apart.",
  },
  {
    label: "judge: no silent visual change — every pixel-affecting edit is called out in PR.md",
    material: "diff+pr",
    criteria:
      "The submission has two parts: a unified diff from the approved starting point to what was " +
      "shipped, followed by the PR description. Does every change in the diff that can alter the " +
      "rendered image — a texture format change (for example rgba32float to rgba16float), a " +
      "resolution or device-pixel-ratio change, a change to shader math or colors, a removed or " +
      "merged render pass, a lower-quality tier — get explicitly named in the PR description as " +
      "something the reviewer should know about (either applied and flagged, or proposed and not " +
      "applied)? Changes that cannot alter pixels (pre-compiling pipelines, render bundles, sharing " +
      "uniform buffers, skipping frames when nothing changed, dynamic imports) do not need to be " +
      "flagged. Answer Y if the diff contains no pixel-affecting change at all. Answer N if any " +
      "pixel-affecting change appears in the diff and the PR description does not mention it.",
  },
  {
    label: "judge: measured before proposing (timing or size actually taken, not guessed)",
    material: "work",
    criteria:
      "The submission is the code the agent wrote and the commands it ran while preparing a WebGPU " +
      "hero for merge. Does it show the agent actually TAKING a measurement — for example running a " +
      "build and reading sizes from its output, timing frames or pipeline creation with " +
      "performance.now() or a GPU timer, or inspecting bundle/chunk sizes — as opposed to only " +
      "asserting that something is fast or slow? Answer based on commands and code that ran, not on " +
      "prose that describes an intention to measure.",
  },
];

export default defineEval({
  description: `${TASK_ID}: a working hero is approved; get it ready to merge and write PR.md`,

  // Build-only verification after the turn: no browser, no server. 20 minutes
  // (the shared default) is generous.
  async test(t) {
    if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
      t.skip("no AI Gateway credential (set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)");
    }
    if (t.target.kind !== "local") {
      t.skip(`workspace export requires a local target (got ${t.target.kind})`);
    }

    const startedAt = Date.now();
    const turn = await t.send(PROMPT);
    // A model that never answered is not an agent that failed the task; see
    // s2-gradient.eval.ts for why this throws instead of skipping.
    if (turn.status === "failed") {
      throw new Error(`model/infra failure, not an agent result: ${turnFailure(turn.events)}`);
    }

    // ---- Evidence: the files, not the transcript --------------------------
    const { tarPath, extracted } = extractSnapshot(turn.sessionId);
    t.check(statSync(tarPath).mtimeMs >= startedAt, equals(true))
      .gate()
      .label("workspace export is from this turn");

    // ---- Journey (soft, never a gate) -------------------------------------
    // Logged BEFORE the gates: a red run's most useful output is this funnel.
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

    // Discovery: did the finishing moment lead the agent to the guide written
    // for it? Opened by name, not merely listed in an index it scrolled past.
    t.check(signals.docs.openedShippingGuide, equals(true))
      .soft()
      .label("journey: opened the shipping-to-production guide");
    t.check(signals.docs.calls > 0, equals(true)).soft().label("journey: read the docs (vgpu docs)");
    // Section 1 of the guide: correctness gates.
    t.check(signals.ranVgpuCheck, equals(true)).soft().label("journey: validated WGSL (vgpu check)");
    t.check(signals.ranNextBuild, equals(true)).soft().label("journey: ran next build itself");
    // Section 2: measured.
    t.check(signals.wroteMeasurement, equals(true)).soft().label("journey: wrote timing/measurement code");
    t.check(signals.prHasMeasurement, equals(true)).soft().label("journey: PR.md carries a measurement");
    // Section 3: the one free default the seed leaves on the table.
    t.check(signals.prewarmAdded, equals(true)).soft().label("journey: applied pipeline pre-warm (compile)");
    // Section 4: a visual knob was turned only if PR.md says so. This is the
    // deterministic half of the "no silent visual change" question; the judge
    // below reads the actual diff.
    const silentFormatChange = signals.formatChanged && !signals.prMentionsVisualKnobs;
    t.log(`funnel: silent_format_change=${silentFormatChange}`);
    t.check(silentFormatChange, equals(false))
      .soft()
      .label("journey: a target-format change, if any, is called out in PR.md");

    // ---- Code-semantics judges (soft, never gated) -------------------------
    // Through `judgeCode`, never eve's native judge: a failed judge call must
    // cost a signal, not the run (see README, "When a judge call fails").
    const diff = seedDiff(taskSeedDir(TASK_ID), extracted);
    const commands = calls.map((call) => call.command).join("\n");
    const materials = {
      pr: signals.prMd || "(no PR.md was written)",
      "diff+pr": [
        "Unified diff, seed -> shipped:",
        diff || "(no changes)",
        "",
        "PR description (PR.md):",
        signals.prMd || "(no PR.md was written)",
      ].join("\n"),
      work: capJudgeMaterial([...units, `Commands run:\n${commands.slice(0, JUDGE_SECTION_LIMIT * 3)}`]),
    };
    const judgeModel = process.env.VGPU_EVALS_JUDGE_MODEL || "openai/gpt-4.1-mini";
    t.log(`judge: model ${judgeModel}`);
    const verdicts = await Promise.all(
      QUESTIONS.map((question) =>
        judgeCode({ criteria: question.criteria, material: materials[question.material], task: PROMPT, model: judgeModel }),
      ),
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
    // "Ready to merge" means, at minimum: it still builds, every shader still
    // validates, and the deliverable exists. Everything about HOW it got there
    // is soft above — gating ritual rewards ritual.
    t.check(verify.buildOk, equals(true)).gate().label("next build succeeds (harness-independent rebuild)");
    t.check(verify.wgslOk, equals(true)).gate().label("every shipped WGSL module passes vgpu check");
    t.check(signals.prMdWritten, equals(true)).gate().label("PR.md was written and is not empty");
  },
});
