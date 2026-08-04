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
  /**
   * The same material, but each write_file payload and each command kept as its
   * own unit. A signal that needs several facts to be true OF THE SAME script
   * has to test them per unit: against the joined blob, an app component that
   * mentions the pointer and a throwaway script that steps frames would satisfy
   * a "stepped frames with a synthetic pointer" test between them, and report a
   * headless test nobody wrote. Same reasoning as milestones 7 and 8 below.
   */
  writtenUnits: string[];
  /** What it actually shipped: source files in the exported workspace. */
  shipped: string;
  /** How many times it looked at an image with the view-image tool. */
  viewImageCalls: number;
}

/**
 * Parts of "tested it headlessly", kept as named constants because the split
 * between them is the whole point: any one of them alone is a weak signal.
 */
/** Ran a script, not just `node -e "require('vgpu')"`-style poking. */
const RAN_NODE_SCRIPT = /\bnode\s+(?:-e\b|--eval\b|[^\s|&;]*\.(?:mjs|js|ts)\b)/;
/** Stepped frames by hand: vgpu's `frame()`, a clock `.advance()`, a pingPong `.swap()`. */
const DRIVES_FRAMES = /\bframe\s*\(|\.advance\s*\(|\.swap\s*\(/;
/**
 * Fed a pointer position the script made up, rather than a real cursor.
 *
 * Widened past `pointer|mouse` (PR #272 review, "4a predicate provenance"):
 * in both archived n1 runs, `pointer|mouse` matched ONLY an English
 * line-comment narrating what the script does ("// Simulate a pointer
 * sweeping across the canvas…") — zero matches in the code itself, which
 * names its variables `points`/`prevPoint`/`currPoint`. That is exactly the
 * "certified by prose, not by mechanics" bug class this milestone's own
 * comment says it was split off to fix. `cursor|point\b|Point\b` catches the
 * identifier shape real synthetic-pointer code actually uses; combined with
 * comment-stripping below, a match can now only come from code.
 */
const SYNTHETIC_POINTER = /pointer|mouse|cursor|point\b|Point\b/i;
/**
 * Rendered somewhere readable instead of onto a screen.
 *
 * `\.png\b` was dropped (PR #272 review, same finding): it let a REAL
 * `<canvas onPointerMove>` DOM handler that merely references a
 * `/noise.png` background image satisfy this predicate, even though nothing
 * was ever rendered offscreen. `writeFileSync`/`readPixels`/`toPng` are
 * genuine offscreen-read operations; a bare `.png` string reference is not.
 */
const RENDERS_OFFSCREEN = /writeFileSync|readPixels|toPng/i;

/**
 * Best-effort JS comment stripper, used only to keep milestone 4a keyed on
 * code rather than prose (PR #272 review). Not a full lexer: a `//` inside a
 * string literal (e.g. a URL) can be mis-stripped, which is an acceptable
 * trade for a `.soft()` journey signal that never gates. Block comments
 * first, then line comments, and line comments are skipped when the `//`
 * is preceded by `:` so `https://…` in a written unit survives.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
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
    // A throwaway script that renders frames outside a browser with a made-up
    // pointer: the cheapest way to test a feedback shader, and the behaviour
    // that actually matters here.
    //
    // Read from `written`, not `shipped`, because this script is throwaway by
    // nature — in the run this signal was written against the agent left it in
    // /tmp and the copy it made into /workspace was gone before the export.
    //
    // Three facts about ONE unit: it drives frames by hand, it feeds a pointer
    // the agent invented, and it renders somewhere it can read back. Running
    // `node` at all is necessary but nowhere near sufficient — an agent that
    // only ever ran `node -e "require('vgpu')"` must not score this.
    //
    // All three sub-predicates are tested against the unit with comments
    // stripped (PR #272 review, "4a predicate provenance"): otherwise an
    // agent's own prose narrating what it's about to do ("// pointer sweeping
    // across the canvas") can satisfy SYNTHETIC_POINTER on its own, and the
    // milestone ends up certifying commenting style, not code.
    id: "tested headlessly by rendering frames with synthetic input",
    detect: (m) =>
      RAN_NODE_SCRIPT.test(m.commands) &&
      m.writtenUnits.some((unit) => {
        const code = stripComments(unit);
        return DRIVES_FRAMES.test(code) && SYNTHETIC_POINTER.test(code) && RENDERS_OFFSCREEN.test(code);
      }),
  },
  {
    // Kept as its own signal, deliberately narrow: `clock()` + `.advance()` is
    // the specific API the docs teach for stepping time by hand
    // (packages/vgpu-api/src/clock.ts), so this is a docs-discovery question,
    // not a testing-behaviour one. It used to be the ONLY headless signal, and
    // that conflation scored a real, thorough headless test as a miss twice:
    // both n1 runs to date drove frames with `frame(gpu, …)` + `trail.swap()`
    // instead, which is just as headless and never touches `.advance()`.
    //
    // PR #272 review, "the 4b label overstates the miss": both n1 runs DID
    // call `clock()` — it's what the agent's own `hero-shader.ts` uses to
    // drive its `requestAnimationFrame` loop (`clock(gpuInstance)` at
    // `hero-shader.ts:92`). What's actually missing is only `.advance(`: the
    // agent integrated time via the browser's own animation loop instead of
    // the headless step-time-by-hand API. The label below is worded to say
    // exactly that miss, not "never found `clock()`".
    id: "found .advance() for headless clock-stepping (it did call clock() — see hero-shader.ts:92)",
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
    hoverOk?: boolean;
    decoded?: boolean;
    sha256?: string;
    width?: number;
    height?: number;
    lumaStdDev?: number;
    error?: string;
  }[];
  screenshotsOk: boolean;
  /**
   * Aggregate: true only if every waypoint's hover was reported ok (PR #272
   * review, P1-6 — added by lane 1, alongside the per-entry
   * `screenshots[].hoverOk` that already existed but was dropped before it
   * reached this eval). Logged and soft-checked below, deliberately NOT a
   * hard gate: it postdates every archived green run, so no real run has
   * ever exercised the code that computes it yet.
   */
  hoverOk: boolean;
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
    const writtenUnits = [
      ...turn.toolCalls
        .filter((call) => call.name === "write_file")
        .map((call) => String((call.input as { content?: unknown } | undefined)?.content ?? "")),
      // Command text too: agents write files through heredocs, `sed -i` and
      // `node -e`, and a signal that only reads write_file under-reports every
      // other route. Both n1 runs so far wrote their headless test as a
      // heredoc, so this is the branch that carries it.
      ...calls.map((call) => call.command),
    ];
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
        `verify: wp-${shot.waypoint} decoded=${shot.decoded ?? false} hover_ok=${shot.hoverOk ?? "?"} ` +
          `${shot.width ?? "?"}x${shot.height ?? "?"} luma_stddev=${shot.lumaStdDev ?? "?"} ` +
          `sha=${shot.sha256 ?? "?"}${shot.error ? ` error=${shot.error}` : ""}`,
      );
    }
    if (!verify.buildOk) t.log(`verify: build log tail\n${verify.buildLog.stderrTail}`);
    t.log(`verify: browser_ready=${verify.browserReady}`);
    // Logged and soft-checked, deliberately not gated (PR #272 review, P1-6):
    // `hoverOk` is a lane-1 addition that postdates every archived n1 run, so
    // no real run has ever exercised the code that computes it. Gating on an
    // aggregate that has never once been produced by a live run would be
    // gating on untested code, not on a validated signal.
    t.log(`verify: hover_ok=${verify.hoverOk}`);
    t.check(verify.hoverOk, equals(true))
      .soft()
      .label("agent-browser reported a successful hover at every waypoint");

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
    // v0 simplification, disclosed in the README. Read the label literally:
    // this proves the five captures are decodable PNGs and that SOMETHING
    // changed between them. It does not prove the POINTER changed anything —
    // the task asks for an animated shader, so the background moves on its own
    // between captures and satisfies non-identity by itself. Measured on the
    // first green run: consecutive captures differ by 3.14–3.38/255 in regions
    // far from every hover point, so a shader that ignores the pointer entirely
    // would pass this gate. The multimodal judge below is what currently speaks
    // to the trail, softly.
    //
    // The hook's own artifact already carries what a deterministic replacement
    // needs: on that same run the pair where the pointer had just arrived
    // differed by 18.94/255 near the waypoint against 3.14 far from it, a 6x
    // separation. Comparing luma delta in a window around the hovered waypoint
    // against the frame's own baseline is the next iteration (see the README
    // roadmap); deliberately not implemented here, since one run is not enough
    // to pick a threshold.
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
    for (const question of questions) {
      t.judge.autoevals.closedQA(question.criteria, { on: material }).soft().label(question.label);
    }
  },
});
