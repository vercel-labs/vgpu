import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { snapshotTarPath, snapshotWorkspaceDir } from "../agent/lib/paths.ts";
import {
  N1_BASELINE_SCREENSHOT,
  N1_SCREENSHOT_DIR,
  N1_VERIFY_JSON,
  WAYPOINTS,
} from "../agent/lib/verify/n1-hero-shader.mjs";
import { N1_CODE_QUESTIONS, judgeCode } from "./lib/judge-code.mjs";
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
 * FIXTURE NOTE — the seed used to carry five invisible `data-testid="n1-wp-N"`
 * anchor divs for the harness to hover. They are GONE, and must not come back:
 * they were styled `pointer-events: none`, and Playwright's (hence
 * agent-browser's) actionability check refuses to hover an element that cannot
 * receive pointer events, so every hover failed and no pointer event ever
 * reached the canvas. The harness now moves the pointer by COORDINATE along a
 * path derived at runtime from the canvas's own bounding box, so it depends on
 * no markup at all — which is also why the anchors could be deleted rather than
 * restyled.
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
  /**
   * The same material, but each write_file payload and each command kept as its
   * own unit. A signal that needs several facts to be true OF THE SAME script
   * has to test them per unit: against the joined blob, an app component that
   * mentions the pointer and a throwaway script that steps frames would satisfy
   * a "stepped frames with a synthetic pointer" test between them, and report a
   * headless test nobody wrote. Same reasoning as the "set up agent-browser"
   * and "closed its own loop with a browser screenshot" milestones below.
   *
   * Chronological, by tool-call index — see where it is built for why the
   * ordering matters to the capped judge material.
   */
  writtenUnits: string[];
  /** What it actually shipped: source files in the exported workspace. */
  shipped: string;
  /** How many times it looked at an image with the view-image tool. */
  viewImageCalls: number;
}

/**
 * The one code-content fact that stays a regex: did the agent run a script
 * with `node`, as opposed to only ever poking with `node -e`. This reads a
 * bash COMMAND, not code semantics — a literal, verifiable fact about what
 * ran — so it stays deterministic (PR #272 review: everything downstream of
 * "did a script run" is a judged question now, see the code-semantics judge
 * block below).
 */
const RAN_NODE_SCRIPT = /\bnode\s+(?:-e\b|--eval\b|[^\s|&;]*\.(?:mjs|js|ts)\b)/;

/**
 * Journey signals: observed and logged, never gated.
 *
 * Gating any of these would reward ritual. An agent that ships a working trail
 * without ever running `vgpu check` has still shipped a working trail; one that
 * runs every command in the CLI and ships nothing has not.
 *
 * The "set up agent-browser" and "closed its own loop with a browser
 * screenshot" milestones are tested PER COMMAND rather than against the joined
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
  // A literal, verifiable fact about what ran — a script, not just
  // `node -e "require('vgpu')"`-style poking. What that script actually DID
  // (stepped frames, fed a synthetic pointer, rendered offscreen) is a
  // semantic question about code, not a bash command, and moved to the
  // code-semantics judge below (PR #272 review, "4a predicate provenance" —
  // this exact question was previously a code-content regex conjunction that
  // matched an English comment instead of code in both archived runs).
  { id: "ran a node script", detect: (m) => RAN_NODE_SCRIPT.test(m.commands) },
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

/**
 * Source files as they ended up in the exported workspace, one chunk per
 * file. Kept separate from `finalSources` below (which just joins these)
 * because the code-semantics judge material needs per-file chunks to
 * truncate individually — see `buildCodeJudgeMaterial`.
 */
function shippedSourceFiles(dir: string): string[] {
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
  return chunks;
}

/** Source files as they ended up in the exported workspace, joined into one blob. */
function finalSources(dir: string): string {
  return shippedSourceFiles(dir).join("\n");
}

/**
 * Per-unit/per-file truncation and overall cap for the code-semantics judge
 * material below (PR #272 review). Three `t.judge.autoevals.closedQA` calls
 * read this same material, and each one is a real, billed model call — a run
 * that wrote a lot of throwaway script must not blow either cap up.
 */
const JUDGE_CODE_UNIT_LIMIT = 4000;
const JUDGE_CODE_MATERIAL_LIMIT = 20000;

/**
 * Material for the code-semantics judges below: what the agent WROTE DURING
 * THE TURN (`writtenUnits` — write_file payloads and bash command text) plus
 * what it actually SHIPPED (`shippedSourceFiles`, read back per file from the
 * exported workspace).
 *
 * The written half is not optional. In both archived n1 runs the agent's
 * headless test script was written to /tmp via a bash heredoc and was gone
 * from /workspace before the export ran, so a judge given only `shipped`
 * would truthfully answer "no" to "did it write a headless test" about a run
 * that did. `writtenUnits` already carries that script, because it reads bash
 * command TEXT, not just write_file payloads.
 *
 * Each unit/file is truncated to JUDGE_CODE_UNIT_LIMIT chars before joining,
 * and the join stops once JUDGE_CODE_MATERIAL_LIMIT total chars are used, so
 * neither one huge file nor a long transcript can crowd out everything else.
 */
function buildCodeJudgeMaterial(units: readonly string[]): string {
  const sections: string[] = [];
  let used = 0;
  for (const unit of units) {
    if (!unit || used >= JUDGE_CODE_MATERIAL_LIMIT) continue;
    const room = JUDGE_CODE_MATERIAL_LIMIT - used;
    const piece = unit.length > Math.min(JUDGE_CODE_UNIT_LIMIT, room)
      ? `${unit.slice(0, Math.min(JUDGE_CODE_UNIT_LIMIT, room))}\n…[truncated]`
      : unit;
    sections.push(piece);
    used += piece.length;
  }
  return sections.join("\n\n---\n\n");
}

/** The verdict `agent/lib/verify/n1-hero-shader.mjs` writes into the workspace. */
interface N1Verdict {
  buildOk: boolean;
  buildLog: { stderrTail: string };
  serverUp: boolean;
  browserReady: boolean;
  screenshots: N1ScreenshotEntry[];
  /** The pointer-free capture, taken before the pointer moved at all. */
  baseline?: N1ScreenshotEntry | null;
  screenshotsOk: boolean;
  /**
   * Aggregate: true only if every `agent-browser mouse move` on every leg of
   * the pointer path reported success (PR #272 review, P1-6 — same shape and
   * role as the `hoverOk` aggregate it replaces). Logged and soft-checked
   * below, deliberately NOT a hard gate: no live run has produced it yet.
   */
  pointerMoveOk: boolean;
  /** The canvas box the pointer path was derived from, measured at runtime. */
  canvasBox?: {
    x: number;
    y: number;
    w: number;
    h: number;
    vw: number;
    vh: number;
    dpr: number;
    canvases: number;
    source: string;
  } | null;
  pixelScale?: number | null;
  notes: string[];
}

/** One capture out of the harness's pointer pass. */
interface N1ScreenshotEntry {
  waypoint: number;
  path: string;
  /** Every pointer move on the leg ending at this waypoint reported success. */
  pointerMoveOk?: boolean;
  moveSteps?: number;
  moveStepsOk?: number;
  /** The final commanded pointer position for this leg, in CSS px. */
  pointer?: number[];
  decoded?: boolean;
  sha256?: string;
  width?: number;
  height?: number;
  lumaStdDev?: number;
  /**
   * Recorded, not gated (see the README roadmap): mean |Δluma| near the pointer
   * versus far from every waypoint, i.e. the pointer's own contribution against
   * the animated background's noise floor.
   */
  spatial?: {
    near?: number | null;
    far?: number | null;
    ratio?: number | null;
    maxDelta?: number;
    maxDeltaAt?: number[];
    maxDeltaOffset?: number;
    nearRadius?: number;
    farRadius?: number;
    error?: string;
  };
  error?: string;
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
    // Command text as well as write_file payloads: agents write files through
    // heredocs, `sed -i` and `node -e`, and a signal that only reads write_file
    // under-reports every other route. Both n1 runs so far wrote their headless
    // test as a heredoc, so the bash branch is the one that carries it.
    //
    // CHRONOLOGICAL, by tool-call index, and that ordering is load-bearing: the
    // judge material below is capped, and a build that emitted every write_file
    // payload first and every command afterwards would let a `.tsx`-heavy run
    // spend the whole cap before reaching the bash half — dropping exactly the
    // evidence that only lives there (in both archived runs the headless test
    // was a bash heredoc, deleted before the export). Interleaved, truncation
    // drops the END of the turn rather than one whole category of evidence.
    const writtenUnits = turn.toolCalls.flatMap((call) => {
      if (call.name === "write_file") {
        return [String((call.input as { content?: unknown } | undefined)?.content ?? "")];
      }
      if (call.name === "bash") {
        return [String((call.input as { command?: unknown } | undefined)?.command ?? "")];
      }
      return [];
    });
    const written = writtenUnits.join("\n");
    const shipped = finalSources(extracted);
    const viewImageCalls = turn.toolCalls.filter((call) => call.name === TOOL_NAME).length;
    const milestoneContext: MilestoneContext = {
      commands,
      calls,
      written,
      writtenUnits,
      shipped,
      viewImageCalls,
    };

    for (const milestone of MILESTONES) {
      const hit = milestone.detect(milestoneContext);
      t.log(`journey: ${hit ? "yes" : "no "} — ${milestone.id}`);
      if (milestone.id === VIEW_IMAGE_MILESTONE) {
        // The one structural signal of the set, and so the most reliable:
        // eve recorded the tool call itself, no regex involved. `calledTool`
        // defaults to "at least one".
        t.calledTool(TOOL_NAME).soft().label(`journey: ${milestone.id}`);
      } else {
        t.check(hit, equals(true)).soft().label(`journey: ${milestone.id}`);
      }
    }

    // ---- Code-semantics judges (soft, never gated) -------------------------
    // PR #272 review: these three replace code-content regexes that failed in
    // both directions — one matched only an English comment narrating the
    // predicate it existed to check ("// simulate a pointer sweeping across
    // the canvas…"), and the comment-stripper added to fix that could
    // truncate a `//` inside a string literal and silently drop a true match.
    // A judge that reads the code cannot be fooled by a word's appearance in
    // a comment, so these three questions — all about what the code actually
    // DOES, not about a literal command having run — are model-graded.
    //
    // Graded through `./lib/judge-code.mjs` rather than eve's native
    // `t.judge.autoevals.closedQA`, for one reason: a judge call that FAILS
    // must cost this run a SIGNAL, not the RUN. eve's collector rewrites any
    // rejected async score function into a `gate`-severity failure regardless
    // of the `.soft()` asked for at the call site, and one failed gate fails
    // the eval — so a transient 500 on a cheap grading call would throw away
    // 20-30 minutes and real money. The rejection also surfaces at
    // finalization, not here, so a `try`/`catch` around the native call would
    // catch nothing. The helper's prompt is a port of autoevals' own ClosedQA
    // template so the criteria keep being asked the question they were
    // validated 9/9 against; see the module header for the full argument.
    //
    // Deliberately exactly three calls, one per question, because each one is
    // a real, billed model call — see buildCodeJudgeMaterial's comment for the
    // same reason its material is capped.
    //
    // PROMPT-INJECTION NOTE: `codeMaterial` is written by the agent under
    // test, i.e. it is untrusted, potentially adversarial input. It is passed
    // ONLY as the graded submission, in its own message, kept strictly apart
    // from the criteria strings, so nothing in it can rewrite the question
    // being asked. Its only effect on this eval is the resulting
    // verdict/label — never control flow.
    const codeMaterial = buildCodeJudgeMaterial([...writtenUnits, ...shippedSourceFiles(extracted)]);
    const codeJudgeModel = process.env.VGPU_EVALS_JUDGE_MODEL || "openai/gpt-4.1-mini";
    t.log(`judge: code-semantics model ${codeJudgeModel}`);
    // Concurrently, and safely: `judgeCode` resolves rather than throws, so
    // there is no unhandled rejection to leak and no ordering to lose — every
    // verdict is logged below in question order whatever order they land in.
    const codeVerdicts = await Promise.all(
      N1_CODE_QUESTIONS.map((question) =>
        judgeCode({
          criteria: question.criteria,
          material: codeMaterial,
          task: PROMPT,
          model: codeJudgeModel,
        }),
      ),
    );
    let codeJudgesUnavailable = 0;
    for (const [index, question] of N1_CODE_QUESTIONS.entries()) {
      const judged = codeVerdicts[index];
      if (judged.verdict === "unavailable") {
        // Deliberately NO assertion recorded. A judge that could not be
        // reached says nothing about the agent, and recording it as a "no"
        // would put a false finding — "the agent did not do this" — into a
        // tracked signal. A missing signal is not evidence of failure, so it
        // is reported as missing and the run carries on to its gates.
        codeJudgesUnavailable += 1;
        t.log(`judge: unavailable — ${question.label} (${judged.error ?? "unknown error"})`);
        continue;
      }
      t.log(`judge: ${judged.verdict === "yes" ? "yes" : "no "} — ${question.label}`);
      t.log(`judge rationale: ${judged.rationale}`);
      t.check(judged.verdict, equals("yes")).soft().label(question.label);
    }
    // Machine-readable on the summary line: three signals silently absent
    // should be visible as an unavailable judge, not read as three questions
    // nobody asked.
    t.log(`funnel: code_judges_unavailable=${codeJudgesUnavailable}/${N1_CODE_QUESTIONS.length}`);

    // ---- Funnel counters --------------------------------------------------
    const [importsVgpu, hasUseClient, hasCanvas] = integrationParts(shipped);
    t.log(`funnel: integration_imports_vgpu=${importsVgpu}`);
    t.log(`funnel: integration_use_client=${hasUseClient}`);
    t.log(`funnel: integration_canvas=${hasCanvas}`);

    // A call is docs usage if it actually asks `vgpu docs` to do something.
    // Checked FIRST and made mutually exclusive with agent_browser_calls_total
    // below (PR #272 review, "agent_browser_calls_total overcounts browser
    // usage"): `vgpu docs find "agent-browser"` and
    // `vgpu docs cat agent-browser-webgpu.md` both contain the substring
    // "agent-browser" as an argument, not as a browser invocation, and were
    // previously counted into BOTH funnel numbers at once.
    const docsCalls = calls.filter((call) => /vgpu\s+docs\b/.test(call.command));
    // `docs_cmd_count` used to count bash CALLS, not `vgpu docs` INVOCATIONS —
    // a single call can chain several (e.g. `docs find X; docs find Y`), and
    // the archived green run ran 25 invocations across only 20 calls. The
    // smaller, call-level number is the one that was being handed to the
    // "discovery proportionate" judge below, which happens to make the run
    // look less wandering than it actually was. Log both, feed the judge the
    // real count.
    const docsInvocationsTotal = docsCalls.reduce(
      (total, call) => total + (call.command.match(/vgpu\s+docs\s+\S+/g)?.length ?? 0),
      0,
    );
    t.log(`funnel: docs_cmd_count=${docsCalls.length}`);
    t.log(`funnel: docs_invocations_total=${docsInvocationsTotal}`);

    // Counts calls that actually DRIVE agent-browser against a live page —
    // open/hover-equivalent mouse moves/screenshot/eval/wait/reload/console/
    // close, plus `doctor` (which launches a real browser for its own
    // self-check) — not merely calls whose command STRING contains the
    // substring "agent-browser" (PR #272 review, same finding). Excluded,
    // with the real green run's counts: the 2 docs calls above (already
    // counted as docs, not browser), `npm i -g agent-browser@latest` (the
    // package name is an argument to npm, agent-browser is never invoked),
    // and bare CLI probing that touches no page (`which agent-browser`,
    // `agent-browser --help`). That took the green run's 27-by-substring down
    // to 22 calls that actually drove a browser.
    const BROWSER_DRIVING_VERB =
      /agent-browser\b[^\n;&|]*\b(?:open|hover|mouse|screenshot|eval|wait|reload|console|close|doctor)\b/;
    const browserCalls = calls.filter(
      (call) => !docsCalls.includes(call) && BROWSER_DRIVING_VERB.test(call.command),
    );
    const browserCallsWithPath = browserCalls.filter((call) =>
      call.command.includes("--executable-path"),
    );
    // Counts how many of those DRIVING calls passed `--executable-path`,
    // which is ONE way through the arm64/Chrome-for-Testing friction:
    // dropping the flag from a later call in a session can make agent-browser
    // fall back to about:blank while still printing success.
    //
    // A low count is not evidence of that fallback, and the first green run is
    // the counterexample: 22 driving calls, zero with the flag, and a real
    // browser throughout. That agent took a third route — it allowed
    // agent-browser's postinstall (`npm config set allow-scripts=agent-browser`,
    // then `npm i -g agent-browser --allow-scripts`), which provisions a
    // browser of its own. Its `eval` calls came back with the hero's real
    // text, a real canvas and webgpu true. Read the pair as "how", never as
    // "whether".
    t.log(`funnel: agent_browser_calls_total=${browserCalls.length}`);
    t.log(`funnel: agent_browser_calls_with_executable_path=${browserCallsWithPath.length}`);
    t.log(`funnel: total_tool_calls=${turn.toolCalls.length}`);
    t.log(`funnel: view_image_calls=${viewImageCalls}`);
    // The old `feedback_technique` funnel line (pingPong vs hand-rolled, by
    // regex) moved to the code-semantics judge above — see the "feedback via
    // built-in ping-pong helper" question.

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
      const spatial = shot.spatial
        ? ` near=${shot.spatial.near ?? "?"} far=${shot.spatial.far ?? "?"} ` +
          `ratio=${shot.spatial.ratio ?? "?"} max_delta_offset=${shot.spatial.maxDeltaOffset ?? "?"}`
        : "";
      t.log(
        `verify: wp-${shot.waypoint} decoded=${shot.decoded ?? false} ` +
          `pointer_move_ok=${shot.pointerMoveOk ?? "?"} ` +
          `moves=${shot.moveStepsOk ?? "?"}/${shot.moveSteps ?? "?"} ` +
          `at=${shot.pointer ? shot.pointer.join(",") : "?"} ` +
          `${shot.width ?? "?"}x${shot.height ?? "?"} luma_stddev=${shot.lumaStdDev ?? "?"} ` +
          `sha=${shot.sha256 ?? "?"}${spatial}${shot.error ? ` error=${shot.error}` : ""}`,
      );
    }
    if (!verify.buildOk) t.log(`verify: build log tail\n${verify.buildLog.stderrTail}`);
    t.log(`verify: browser_ready=${verify.browserReady}`);
    if (verify.canvasBox) {
      t.log(
        `verify: pointer path derived from ${verify.canvasBox.source} box ` +
          `${verify.canvasBox.w}x${verify.canvasBox.h} at ${verify.canvasBox.x},${verify.canvasBox.y} ` +
          `(viewport ${verify.canvasBox.vw}x${verify.canvasBox.vh}, dpr=${verify.canvasBox.dpr}, ` +
          `canvases=${verify.canvasBox.canvases}, capture scale=${verify.pixelScale ?? "?"})`,
      );
    }
    // Logged and soft-checked, deliberately not gated: the coordinate-driven
    // pointer pass that produces this aggregate is new (it replaced hovering
    // the seed's `pointer-events: none` anchors, which Playwright refuses to
    // hover — so the old `hoverOk` was false on every waypoint of the archived
    // green run). It has been rehearsed against the golden workspace in a
    // container, but no live eval run has produced it yet, and gating on a
    // signal no live run has produced is gating on untested code.
    t.log(`verify: pointer_move_ok=${verify.pointerMoveOk}`);
    t.check(verify.pointerMoveOk, equals(true))
      .soft()
      .label("agent-browser reported a successful pointer move at every path step");

    // ---- Gates (hard) -----------------------------------------------------
    // All four are the harness's own observations, not the agent's claims: this
    // code rebuilt the app, served it, and hovered it itself.
    t.check(verify.buildOk, equals(true))
      .gate()
      .label("next build succeeds (harness-independent rebuild)");
    t.check(verify.serverUp, equals(true)).gate().label("next start serves the hero");
    t.check(verify.screenshots.length, equals(WAYPOINTS.length))
      .gate()
      .label("harness captured a screenshot at every pointer waypoint");
    // v0 simplification, disclosed in the README. Read the label literally:
    // this proves the five captures are decodable PNGs and that SOMETHING
    // changed between them. It does not prove the POINTER changed anything —
    // the task asks for an animated shader, so the background moves on its own
    // between captures and satisfies non-identity by itself. Measured on the
    // first green run: consecutive captures differ by 3.14–3.38/255 in regions
    // far from every pointer position, so a shader that ignores the pointer
    // entirely would pass this gate. Still true after the pointer pass was
    // fixed to move by coordinate: this gate is about non-identity, nothing
    // more. The multimodal judge below, and `screenshots[].spatial`, are what
    // speak to the trail.
    //
    // The hook's artifact now records the numbers a deterministic replacement
    // needs, per waypoint, in `spatial` — mean |Δluma| near the pointer versus
    // far from every waypoint. Two measured populations exist so far, both with
    // this same code: pointer driven along the path over the archived green
    // run's own app gives ratio 25.49-40.32, and that same app with the pointer
    // provably frozen gives 0.89-1.20. `ratio >= 4` sits between them with
    // ~6x/~3x margin. Deliberately NOT gated here until a live run has produced
    // the field (see the README roadmap).
    t.check(verify.screenshotsOk, equals(true))
      .gate()
      .label("the pointer pass changes what is rendered (screenshots decode and are not all identical)");

    // ---- Multimodal judge (soft, never a gate) ----------------------------
    // The pointer-free baseline (captured before the pointer moved at all)
    // versus the last waypoint (pointer just arrived bottom-right, trail
    // fresh). BEFORE used to be `wp-0.png` — a frame the pointer had already
    // painted — which handed the judge a weaker contrast than the run actually
    // produced; the fallback keeps archived runs, which have no baseline,
    // judgeable with the same code. A separate env var from the text judge so
    // the two concerns — cheap text judging of docs usage, image-capable
    // judging of the trail — can be pinned independently.
    const baselinePng = join(extracted, N1_BASELINE_SCREENSHOT);
    const beforePng = existsSync(baselinePng)
      ? baselinePng
      : join(extracted, N1_SCREENSHOT_DIR, `wp-${WAYPOINTS[0]}.png`);
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
      // The real invocation count, not the (smaller, call-level) docs_cmd_count
      // — see the funnel-counter comment above. Feeding the judge the same
      // number the summary logs is the whole point of this fix.
      `- documentation commands: ${docsInvocationsTotal}`,
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
    // KNOWN EXPOSURE, deliberate (see the README's "When a judge call fails"):
    // these three stay on eve's native judge, so a transient failure in any of
    // them still fails the whole eval — eve's collector rewrites a rejected
    // score function into a `gate` failure regardless of this `.soft()`, and
    // there is no error hook to opt out of that. They are NOT ported to
    // `lib/judge-code.mjs` with the code-semantics questions because these
    // three have run history under autoevals' ClosedQA grading and are asked
    // verbatim in both evals so the finding stays comparable across tasks;
    // swapping the grading path would redefine a tracked metric, and the
    // archived material contains no negative examples to validate the new
    // decision boundary against ("discovery proportionate" is threshold
    // sensitive). Converting them needs a comparability run of its own —
    // follow-up, not this change.
    for (const question of questions) {
      t.judge.autoevals.closedQA(question.criteria, { on: material }).soft().label(question.label);
    }
  },
});
