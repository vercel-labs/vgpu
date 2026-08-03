import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { snapshotTarPath, snapshotWorkspaceDir } from "../agent/lib/paths.ts";
import {
  N1_SCREENSHOT_DIR,
  N1_VERIFY_JSON,
  WAYPOINTS,
} from "../agent/lib/verify/n1-hero-shader.mjs";
import { judgeTrailEffect } from "./lib/judge-trail.mjs";
import { turnFailure } from "./lib/turn-failure.mjs";

/**
 * The flagship task: take a plain Next.js hero and give it an animated
 * background shader that leaves a fading trail behind the pointer.
 *
 * The prompt names `npx vgpu` and nothing else, for the same reason
 * `s2-gradient` does: the CLI is the official entry point for agents, so handing
 * it over is the realistic starting condition rather than a leak. Everything
 * downstream stays unsaid — no "WGSL", no `docs`, no `doctor`, no `check`, no
 * `pingPong`, no "use client", no agent-browser, no mention of how to look at a
 * pixel. That chain of guidance is exactly what this run measures.
 *
 * What makes this one different from s2 is that the outcome is verified by the
 * HARNESS, not read out of a file the agent left behind: `agent/lib/verify/
 * n1-hero-shader.mjs` runs inside the live sandbox after the turn ends and
 * rebuilds, serves and hovers the app itself. This eval only reads that
 * verdict. See the README's "Trust model (v0)" for what that still does not
 * prove.
 *
 * FIXTURE NOTE — do not "clean up" the five `data-testid="n1-wp-N"` divs in
 * `agent/sandbox/tasks/n1-hero-shader/app/page.tsx`. They look like dead markup
 * and they are not: they are the fixed hover targets the harness aims
 * `agent-browser hover` at, which is what makes the screenshot pass reproducible
 * whatever layout the agent's canvas ends up with. The agent is never asked to
 * add or keep them.
 */
const PROMPT =
  "Add an animated background shader to the hero: a hover effect that leaves a " +
  "fading trail behind the pointer. Use `npx vgpu`.";

/**
 * The tool's name is its filename (kebab-case — eve derives the name from the
 * file, not from any string inside it). Same spelling as
 * `view-image-smoke.eval.ts` asserts.
 */
const TOOL_NAME = "view-image";

/** The one milestone proven structurally instead of by regex. */
const VIEW_IMAGE_MILESTONE = "looked at a rendered image (view-image tool)";

/** Judge material is truncated per section so one huge blob cannot crowd out the rest. */
const JUDGE_SECTION_LIMIT = 2000;

/**
 * Extensions worth reading back out of the exported workspace.
 *
 * Wider than s2's set because this task ships a React app: the integration
 * evidence ("use client", a `<canvas`, the vgpu import) lives in `.tsx`.
 */
const CODE_EXTENSIONS = new Set([".mjs", ".js", ".jsx", ".ts", ".tsx", ".wgsl"]);

/**
 * Directories skipped when aggregating shipped sources. `.next` is the reason
 * this list exists at all: `next build` leaves tens of megabytes of compiled
 * copies of the agent's own code there, and reading them back would be slow and
 * would double-count every signal below.
 */
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".vgpu-tarballs", ".agent-evals"]);

interface BashCall {
  command: string;
  exitCode: number | null;
  output: string;
}

interface MilestoneContext {
  /** Every bash command the agent ran, joined by newlines. */
  commands: string;
  /** Bash calls with their real exit codes. */
  calls: BashCall[];
  /** What the agent wrote while working: write_file payloads plus command text. */
  written: string;
  /** What it actually shipped: source files in the exported workspace. */
  shipped: string;
  /** How many times it looked at an image with the view-image tool. */
  viewImageCalls: number;
}

/**
 * Journey signals: observed and logged, never gated.
 *
 * Gating any of these would reward ritual. An agent that ships a working trail
 * without ever running `vgpu check` has still shipped a working trail; one that
 * runs every command in the CLI and ships nothing has not.
 *
 * Milestones 7 and 8 are tested PER COMMAND rather than against the joined
 * blob, because `.*` over a newline-joined transcript would happily match an
 * `agent-browser` call on one line and the word `screenshot` twenty commands
 * later, and report a loop the agent never closed.
 */
const MILESTONES: { id: string; detect: (m: MilestoneContext) => boolean }[] = [
  { id: "ran vgpu doctor", detect: (m) => /vgpu\s+doctor\b/.test(m.commands) },
  {
    id: "wrote a WGSL shader (@fragment/@vertex)",
    detect: (m) => /@fragment\b|@vertex\b/.test(m.written) || /@fragment\b|@vertex\b/.test(m.shipped),
  },
  { id: "validated WGSL (vgpu check)", detect: (m) => /vgpu\s+check\b/.test(m.commands) },
  {
    // A throwaway script that steps the frame clock by hand with a synthetic
    // pointer uniform: the cheapest way to test a feedback shader without a
    // browser, and the one vgpu's own clock API exists for.
    id: "tested the shader headlessly by driving the clock",
    detect: (m) =>
      (/\bclock\s*\(/.test(m.written) && /\.advance\s*\(/.test(m.written)) ||
      (/\bclock\s*\(/.test(m.shipped) && /\.advance\s*\(/.test(m.shipped)),
  },
  { id: VIEW_IMAGE_MILESTONE, detect: (m) => m.viewImageCalls > 0 },
  {
    // Logged as three booleans too (below), because "wrote a client component
    // but never mounted a canvas" and "mounted a canvas but never imported
    // vgpu" are different findings and one AND hides which happened.
    id: "integrated the shader into the app",
    detect: (m) => integrationParts(m.shipped).every(Boolean),
  },
  { id: "set up agent-browser", detect: (m) => m.calls.some((call) => /agent-browser\b/.test(call.command)) },
  {
    id: "closed its own loop with a browser screenshot",
    detect: (m) => m.calls.some((call) => /agent-browser\b.*screenshot/.test(call.command)),
  },
];

/**
 * The three independent halves of "integrated it": a vgpu import from the
 * browser entrypoint (bare specifier, no subpath), a client component, and a
 * canvas in the JSX.
 */
function integrationParts(shipped: string): [boolean, boolean, boolean] {
  return [
    /from\s+["']vgpu["']/.test(shipped),
    /["']use client["']/.test(shipped),
    /<canvas\b/.test(shipped),
  ];
}

/**
 * How the agent kept the previous frame around, which is the one genuinely hard
 * part of a fading trail.
 *
 * Never gated: a correct hand-rolled double buffer is a correct solution, and
 * gating on API choice is precisely the "reward ritual" mistake this suite
 * forbids. It is reported because "nobody finds `pingPong`" and "everybody
 * finds it" are different docs problems.
 */
function feedbackTechnique(shipped: string): "pingPong" | "hand-rolled" | "unclear" {
  if (/\bpingPong(Storage)?\s*\(/.test(shipped)) return "pingPong";
  const allocations = shipped.match(/\btarget\s*\(\s*\w+/g)?.length ?? 0;
  const manualSwap = /\bswap\b|\btmp\b|\btemp\b|\bprev(ious)?\b|%\s*2\b/i.test(shipped);
  if (allocations >= 2 && manualSwap) return "hand-rolled";
  return "unclear";
}

/**
 * Bash calls with their real exit codes.
 *
 * Deliberately a near-copy of `s2-gradient.eval.ts`'s helper of the same name
 * rather than a shared import: the s2 eval is the suite's reference pattern and
 * a green regression run of it is worth more than forty lines of dedupe. If a
 * third task needs this, extract all three at once.
 */
function bashCalls(toolCalls: readonly { name: string; input?: unknown; output?: unknown }[]): BashCall[] {
  return toolCalls
    .filter((call) => call.name === "bash")
    .map((call) => {
      const input = call.input as { command?: unknown } | undefined;
      const output = call.output as { exitCode?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
      return {
        command: String(input?.command ?? ""),
        // Trust the exit code, not the text: the sandbox's stderr carries
        // harmless Vulkan loader chatter that any "mentions an error" heuristic
        // reads as a failure.
        exitCode: typeof output?.exitCode === "number" ? output.exitCode : null,
        output: `${String(output?.stdout ?? "")}\n${String(output?.stderr ?? "")}`,
      };
    });
}

/** Source files as they ended up in the exported workspace. */
function finalSources(dir: string): string {
  const chunks: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (CODE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        chunks.push(readFileSync(full, "utf8"));
      }
    }
  };
  walk(dir);
  return chunks.join("\n");
}

/** The verdict `agent/lib/verify/n1-hero-shader.mjs` writes into the workspace. */
interface N1Verdict {
  buildOk: boolean;
  buildLog: { stderrTail: string };
  serverUp: boolean;
  browserReady: boolean;
  screenshots: {
    waypoint: number;
    path: string;
    decoded?: boolean;
    sha256?: string;
    width?: number;
    height?: number;
    lumaStdDev?: number;
    error?: string;
  }[];
  screenshotsOk: boolean;
  notes: string[];
}

export default defineEval({
  description:
    "n1-hero-shader: add a hover-trail background shader to a Next.js hero, browser-verified",

  // 30 minutes, overriding evals.config.ts's shared 20. Per-eval, not global:
  // raising the shared default would let a hung s2 run half an hour before
  // anyone noticed, for no benefit to s2. This task legitimately needs it — the
  // agent installs a browser, and the harness then rebuilds, serves and drives
  // five hovers of its own after the turn.
  timeoutMs: 1_800_000,

  async test(t) {
    // Credentials first, before anything is spent. A missing key must skip, not
    // fail: a red suite that only means "you have no token" trains people to
    // ignore red suites.
    if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
      t.skip("no AI Gateway credential (set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)");
    }
    // The finalize hook writes the workspace tar — verification artifacts and
    // screenshots included — to the HOST running the agent runtime. Against a
    // remote target that host is not this machine, so what we would read here
    // is either absent or stale.
    if (t.target.kind !== "local") {
      t.skip(`workspace export requires a local target (got ${t.target.kind})`);
    }

    const startedAt = Date.now();
    const turn = await t.send(PROMPT);

    // A model that never answered is not an agent that failed the task.
    //
    // Copied verbatim from s2-gradient.eval.ts, including its position ABOVE
    // every gate, and it matters more here than there: this turn is the most
    // expensive one in the suite, and a restricted-provider 403 recorded as
    // "the agent produced nothing" costs a 30-minute re-run to discover.
    // `=== "failed"` and not `!== "completed"` is load-bearing — a healthy
    // single-turn run ends on `session.waiting`. See s2's comment for the full
    // reasoning, and for why this throws instead of skipping.
    if (turn.status === "failed") {
      throw new Error(`model/infra failure, not an agent result: ${turnFailure(turn.events)}`);
    }

    const sessionId = turn.sessionId;

    // ---- Evidence: the files, not the transcript --------------------------
    const tarPath = snapshotTarPath(sessionId);
    await t.require(existsSync(tarPath), equals(true));
    // Freshness, not just existence: the hook rewrites this tar on every
    // completed turn, so a stale one would be graded as this turn's work.
    t.check(statSync(tarPath).mtimeMs >= startedAt, equals(true))
      .gate()
      .label("workspace export is from this turn");

    const extracted = snapshotWorkspaceDir(sessionId);
    rmSync(extracted, { force: true, recursive: true });
    mkdirSync(extracted, { recursive: true });
    const untar = spawnSync("tar", ["-xf", tarPath, "-C", extracted], { encoding: "utf8" });
    if (untar.status !== 0) {
      throw new Error(`could not extract ${tarPath}: ${untar.stderr}`);
    }

    // ---- Journey (soft, never a gate) -------------------------------------
    // Deliberately BEFORE the gates and before the verification artifact is
    // read. Everything below can end in a throw (a missing artifact is harness
    // breakage, not an agent result), and the journey funnel is the most
    // valuable thing in a red run — it must already be logged by then.
    const calls = bashCalls(turn.toolCalls);
    const commands = calls.map((call) => call.command).join("\n");
    const written = [
      ...turn.toolCalls
        .filter((call) => call.name === "write_file")
        .map((call) => String((call.input as { content?: unknown } | undefined)?.content ?? "")),
      // Command text too: agents write files through heredocs, `sed -i` and
      // `node -e`, and a signal that only reads write_file under-reports every
      // other route.
      commands,
    ].join("\n");
    const shipped = finalSources(extracted);
    const viewImageCalls = turn.toolCalls.filter((call) => call.name === TOOL_NAME).length;
    const milestoneContext: MilestoneContext = { commands, calls, written, shipped, viewImageCalls };

    for (const milestone of MILESTONES) {
      const hit = milestone.detect(milestoneContext);
      t.log(`journey: ${hit ? "yes" : "no "} — ${milestone.id}`);
      if (milestone.id === VIEW_IMAGE_MILESTONE) {
        // The one structural signal of the eight, and so the most reliable:
        // eve recorded the tool call itself, no regex involved. `calledTool`
        // defaults to "at least one".
        t.calledTool(TOOL_NAME).soft().label(`journey: ${milestone.id}`);
      } else {
        t.check(hit, equals(true)).soft().label(`journey: ${milestone.id}`);
      }
    }

    // ---- Funnel counters --------------------------------------------------
    const [importsVgpu, hasUseClient, hasCanvas] = integrationParts(shipped);
    t.log(`funnel: integration_imports_vgpu=${importsVgpu}`);
    t.log(`funnel: integration_use_client=${hasUseClient}`);
    t.log(`funnel: integration_canvas=${hasCanvas}`);

    // The gap between these two counts IS the measurement of whether the agent
    // navigated the arm64/Chrome-for-Testing friction or only attempted it:
    // dropping `--executable-path` from a later call in a session makes
    // agent-browser fall back to about:blank while still printing success.
    const browserCalls = calls.filter((call) => /agent-browser\b/.test(call.command));
    const browserCallsWithPath = browserCalls.filter((call) =>
      call.command.includes("--executable-path"),
    );
    t.log(`funnel: agent_browser_calls_total=${browserCalls.length}`);
    t.log(`funnel: agent_browser_calls_with_executable_path=${browserCallsWithPath.length}`);

    const docsCalls = calls.filter((call) => /vgpu\s+docs\b/.test(call.command));
    t.log(`funnel: docs_cmd_count=${docsCalls.length}`);
    t.log(`funnel: total_tool_calls=${turn.toolCalls.length}`);
    t.log(`funnel: view_image_calls=${viewImageCalls}`);
    t.log(`funnel: feedback_technique=${feedbackTechnique(shipped)}`);

    // ---- Harness verdict --------------------------------------------------
    // Written by agent/lib/verify/n1-hero-shader.mjs inside the live sandbox
    // before the tar was taken. It never throws past its own first step, so an
    // absent artifact means the hook itself did not run — infra, not an agent
    // result, and worth saying so on the summary line.
    const verifyPath = join(extracted, N1_VERIFY_JSON);
    if (!existsSync(verifyPath)) {
      throw new Error(
        `harness verification artifact missing at ${N1_VERIFY_JSON}: the finalize-turn hook did ` +
          "not run its verification pass, so no outcome was measured (infra failure, not an agent result)",
      );
    }
    const verify = JSON.parse(readFileSync(verifyPath, "utf8")) as N1Verdict;

    for (const note of verify.notes) t.log(`verify: ${note}`);
    for (const shot of verify.screenshots) {
      t.log(
        `verify: wp-${shot.waypoint} decoded=${shot.decoded ?? false} ` +
          `${shot.width ?? "?"}x${shot.height ?? "?"} luma_stddev=${shot.lumaStdDev ?? "?"} ` +
          `sha=${shot.sha256 ?? "?"}${shot.error ? ` error=${shot.error}` : ""}`,
      );
    }
    if (!verify.buildOk) t.log(`verify: build log tail\n${verify.buildLog.stderrTail}`);
    t.log(`verify: browser_ready=${verify.browserReady}`);

    // ---- Gates (hard) -----------------------------------------------------
    // All four are the harness's own observations, not the agent's claims: this
    // code rebuilt the app, served it, and hovered it itself.
    t.check(verify.buildOk, equals(true))
      .gate()
      .label("next build succeeds (harness-independent rebuild)");
    t.check(verify.serverUp, equals(true)).gate().label("next start serves the hero");
    t.check(verify.screenshots.length, equals(WAYPOINTS.length))
      .gate()
      .label("harness captured a screenshot at every hover waypoint");
    // v0 simplification, disclosed in the README: this proves the pointer
    // changes what is rendered and that no capture is a broken PNG. It does not
    // yet prove the change follows the pointer or fades over time — that is
    // what the multimodal judge below reads, softly.
    t.check(verify.screenshotsOk, equals(true))
      .gate()
      .label("hover changes what is rendered (screenshots decode and are not all identical)");

    // ---- Multimodal judge (soft, never a gate) ----------------------------
    // First waypoint (pointer at the top-left) versus last (pointer just
    // arrived bottom-right). A separate env var from the text judge so the two
    // concerns — cheap text judging of docs usage, image-capable judging of the
    // trail — can be pinned independently.
    const beforePng = join(extracted, N1_SCREENSHOT_DIR, `wp-${WAYPOINTS[0]}.png`);
    const afterPng = join(extracted, N1_SCREENSHOT_DIR, `wp-${WAYPOINTS[WAYPOINTS.length - 1]}.png`);
    if (existsSync(beforePng) && existsSync(afterPng)) {
      const visionModel =
        process.env.VGPU_EVALS_VISION_JUDGE_MODEL ||
        process.env.VGPU_EVALS_JUDGE_MODEL ||
        "openai/gpt-4.1-mini";
      t.log(`judge: vision model ${visionModel}`);
      try {
        const judged = await judgeTrailEffect({
          beforePng: readFileSync(beforePng),
          afterPng: readFileSync(afterPng),
          model: visionModel,
        });
        // Logged whatever the score is: a red run has to stay legible, and the
        // rationale is the part a human actually reads.
        t.log(`judge score: ${judged.score}`);
        t.log(`judge rationale: ${judged.rationale}`);
        t.check(
          judged.score,
          satisfies<number>((score) => score >= 50, "score >= 50"),
        )
          .soft()
          .label("hover trail reads as a fading trail (multimodal judge)");
      } catch (error) {
        // A judge that could not be reached says nothing about the agent, so it
        // must not turn into a verdict about the agent.
        t.log(`judge: unavailable (${String(error).slice(0, 300)})`);
      }
    } else {
      t.log("judge: skipped — the harness captured no before/after pair to compare");
    }

    // ---- Docs-usage quality (soft judges) ---------------------------------
    // s2's three questions verbatim, because the finding they produce is
    // comparable across tasks only if the question is identical. The material
    // is extended with the agent's agent-browser calls: vgpu ships its own
    // browser guide, so those calls are documentation-following evidence too.
    const docsExcerpt = docsCalls
      .map((call) => `$ ${call.command}\n${call.output.trim()}`)
      .join("\n\n")
      .slice(0, JUDGE_SECTION_LIMIT);
    const browserExcerpt = browserCalls
      .map((call) => `$ ${call.command}\n${call.output.trim()}`)
      .join("\n\n")
      .slice(0, JUDGE_SECTION_LIMIT);
    const material = [
      // Counters handed over explicitly. Asking a judge to weigh
      // "proportionate" while also making it count commands out of a transcript
      // scored a 7-call run and a 24-call run identically.
      "Counters for this run:",
      `- documentation commands: ${docsCalls.length}`,
      `- agent-browser commands: ${browserCalls.length} (${browserCallsWithPath.length} with --executable-path)`,
      `- images viewed with the view-image tool: ${viewImageCalls}`,
      `- total tool calls: ${turn.toolCalls.length}`,
      "",
      "Commands the agent ran:",
      commands.slice(0, JUDGE_SECTION_LIMIT) || "(none)",
      "",
      "Output of its documentation commands (truncated):",
      docsExcerpt || "(the agent ran no documentation commands)",
      "",
      "Output of its browser commands (truncated):",
      browserExcerpt || "(the agent ran no browser commands)",
    ].join("\n");

    const questions: { label: string; criteria: string }[] = [
      {
        label: "docs discovery via CLI",
        criteria: "Did the agent use the package's own CLI to discover the API it needed?",
      },
      {
        label: "discovery proportionate",
        criteria:
          "Was the amount of discovery proportionate for this task (add an animated hover-trail " +
          "shader to an existing Next.js hero, then check it in a browser)? Judge from the " +
          "counters, not the prose: this is a large task, so 2-8 documentation commands is " +
          "proportionate; more than 12 documentation commands, or more than 60 total tool calls, " +
          "is wandering. Answer N when the counters fall outside those ranges and the commands " +
          "show no clear reason for the extra work.",
      },
      {
        label: "acted on docs read",
        criteria: "Did it act on what it found, so the code it wrote reflects the documentation it read?",
      },
    ];
    for (const question of questions) {
      t.judge.autoevals.closedQA(question.criteria, { on: material }).soft().label(question.label);
    }
  },
});
