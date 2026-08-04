import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { PNG } from "pngjs";
import { snapshotTarPath, snapshotWorkspaceDir } from "../agent/lib/paths.ts";
import { MIX_MAX, MIX_MIN, TOL, gradeGradient } from "./lib/grade-gradient.mjs";
import { turnFailure } from "./lib/turn-failure.mjs";

/**
 * The one hint is `npx vgpu`, and it is deliberate.
 *
 * That command is the official entry point for agents, so handing it over is
 * not contamination — it is the starting condition we expect in the field. What
 * this eval measures is the chain of guidance AFTER the entry point: from `npx
 * vgpu`, can the agent reach a working gradient? Everything downstream of it
 * stays unsaid: no "shader", no WGSL, no `docs`, no `doctor`, no `check`.
 *
 * The workspace is deliberately poor — `package.json` and installed
 * dependencies, no `render.mjs`. The agent writes the whole program, so this
 * grades discovery rather than the editing of an example we already wrote.
 */
const PROMPT = [
  "The project in /workspace must produce out.png (128x128) by running `node render.mjs`:",
  "a horizontal linear gradient from pure red (255,0,0,255) at the leftmost column",
  "to pure blue (0,0,255,255) at the rightmost column.",
  "",
  "Use `npx vgpu`.",
].join("\n");

const SIZE = 128;

/** Journey signals: observed and logged, never gated. */
const MILESTONES: { id: string; test: RegExp }[] = [
  { id: "ran the vgpu CLI at all", test: /(^|[^\w-])(npx\s+)?vgpu\b/ },
  { id: "read the docs (vgpu docs)", test: /vgpu\s+docs\b/ },
  { id: "ran vgpu doctor", test: /vgpu\s+doctor\b/ },
  { id: "validated WGSL (vgpu check)", test: /vgpu\s+check\b/ },
  { id: "looked at examples", test: /vgpu\s+examples\b/ },
];

/**
 * The 0.1.x facade, which 0.2.0 replaced with free functions.
 *
 * Models trained on the old API reach for `gpu.target(...)` and friends. Whether
 * they do, and whether they then recover, is a docs signal: it says how loudly
 * the current surface announces itself. Never a gate — an agent that emits a
 * stale call, reads the error and fixes it has done nothing wrong.
 */
const STALE_API = [/\bgpu\.target\s*\(/, /\bgpu\.effect\s*\(/, /\bgpu\.draw\s*\(/, /\bgpu\.frame\s*\(\)/];
/**
 * The 0.2.0 shape: free functions taking the device as their first argument.
 *
 * The receiver is matched as any identifier rather than the literal `gpu`,
 * because naming it `device` or `g` is not a stale API. The tradeoff is
 * accepted knowingly: `target(anything)` can match an unrelated local function
 * of the same name. Over-reporting "recovered" on a soft signal is much cheaper
 * than under-reporting it because the agent picked a different variable name.
 */
const CURRENT_API = [/\btarget\s*\(\s*\w+/, /\beffect\s*\(\s*\w+/];

const CODE_EXTENSIONS = new Set([".mjs", ".js", ".ts", ".wgsl"]);

/** Judge material is truncated per section so one huge blob cannot crowd out the rest. */
const JUDGE_SECTION_LIMIT = 2000;

interface BashCall {
  command: string;
  exitCode: number | null;
  output: string;
}

/** Bash calls with their real exit codes. */
function bashCalls(toolCalls: readonly { name: string; input?: unknown; output?: unknown }[]): BashCall[] {
  return toolCalls
    .filter((call) => call.name === "bash")
    .map((call) => {
      const input = call.input as { command?: unknown } | undefined;
      const output = call.output as { exitCode?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
      return {
        command: String(input?.command ?? ""),
        // Trust the exit code, not the text. The sandbox's stderr is full of
        // harmless `Error: Loader Message: ...` Vulkan chatter, so any
        // "does the output mention an error" heuristic reads a successful
        // render as a failure.
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
      if (entry.name === "node_modules" || entry.name === ".vgpu-tarballs") continue;
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

export default defineEval({
  description: "s2-gradient: write render.mjs from scratch so out.png is a 128x128 red-to-blue gradient",

  async test(t) {
    // Credentials first, before anything is spent. A missing key must skip, not
    // fail: a red suite that only means "you have no token" trains people to
    // ignore red suites.
    if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
      t.skip("no AI Gateway credential (set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)");
    }
    // The export hook writes the workspace tar to the HOST running the agent
    // runtime. Against a remote target that host is not this machine, so the
    // tar we would read here is either absent or stale.
    if (t.target.kind !== "local") {
      t.skip(`workspace export requires a local target (got ${t.target.kind})`);
    }

    const startedAt = Date.now();
    const turn = await t.send(PROMPT);

    // A model that never answered is not an agent that failed the task.
    //
    // `send()` resolves with a failed turn instead of throwing (only
    // `expectOk()` throws), so without this the run falls through to the
    // workspace-export assertion below and reports `gates 0/1` — indis-
    // tinguishable on the summary line from "the agent produced nothing". That
    // is exactly how a restricted-provider 403 once got recorded as an agent
    // result. This must stay ABOVE the gates for that reason.
    //
    // Two details are load-bearing, both learned the hard way:
    //
    // 1. The test is `=== "failed"`, NOT `!== "completed"`. eve derives the
    //    status from the SESSION boundary event, not the turn:
    //    `session.waiting -> "waiting"`, `session.failed -> "failed"`, anything
    //    else -> `"completed"`. A successful single-turn run here ends on
    //    `session.waiting` because the session parks for the next message, so
    //    it reports `"waiting"` and `"completed"` never occurs in this suite.
    //    Testing for `!== "completed"` rejects every healthy run.
    //
    // 2. It throws rather than calling `t.skip()`. Skipping would be the
    //    honest verdict — this is not the agent's failure — but eve rejects it
    //    after work has happened: "skip() must be called before sending
    //    messages or recording assertions." A throw still puts the cause on the
    //    summary line, which is the point.
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

    const outPath = join(extracted, "out.png");
    await t.require(existsSync(outPath), equals(true));
    const png = PNG.sync.read(readFileSync(outPath));

    // ---- Gates ------------------------------------------------------------
    // v0 trusts the agent's out.png: this reads the file it left behind, it
    // does NOT re-render from source. A hand-written PNG passes. Known and
    // accepted for this iteration — see "Trust model" in the README.
    //
    // The grading itself lives in ./lib/grade-gradient.mjs so that offline
    // probes can exercise the real logic instead of a copy of it.
    const grade = gradeGradient(png, SIZE);
    t.log(`endpoints: left column off by <=${grade.leftOff}, right off by <=${grade.rightOff} (tol ${TOL})`);
    for (const row of grade.rows) {
      t.log(`row y=${row.y} mid=[R${row.mid[0]} B${row.mid[1]}]`);
      t.log(`  R: ${row.R.join(" ")}`);
      t.log(`  B: ${row.B.join(" ")}`);
    }

    t.check(`${png.width}x${png.height}`, equals(`${SIZE}x${SIZE}`)).gate().label("image is 128x128");
    t.check(grade.leftOff <= TOL, equals(true)).gate().label("leftmost column is pure red");
    t.check(grade.rightOff <= TOL, equals(true)).gate().label("rightmost column is pure blue");

    // Red never climbs, blue never drops, green stays out of it — sampled on
    // three rows so a correct middle row cannot carry an image of noise.
    // Note what this does NOT assert: monotonicity alone is satisfied by a hard
    // step between two flat halves, which is why the midpoint gate exists.
    t.log(`monotonic: red rises ${grade.redRises}x, blue falls ${grade.blueFalls}x, max green ${grade.greenOff}`);
    t.check(grade.monotonic, equals(true)).gate().label("red falls and blue rises across the image");

    // The midpoint must be a genuine blend. Two flat halves and a ramp through
    // black both pass monotonicity while being the wrong picture; neither has a
    // mixed middle column. The window is wide because the midpoint of a correct
    // ramp is ~127 in sRGB space and ~186 in linear light.
    t.check(grade.midpointMixed, equals(true))
      .gate()
      .label(`middle column blends both channels (${MIX_MIN}-${MIX_MAX})`);

    // ---- Journey (soft, never a gate) -------------------------------------
    // Gating any of this would reward ritual: an agent that solves the task
    // without reading the docs has still solved it, and one that runs
    // `vgpu docs` five times and fails has not.
    const calls = bashCalls(turn.toolCalls);
    const commands = calls.map((call) => call.command).join("\n");
    for (const milestone of MILESTONES) {
      const hit = milestone.test.test(commands);
      t.log(`journey: ${hit ? "yes" : "no "} — ${milestone.id}`);
      t.check(hit, equals(true)).soft().label(`journey: ${milestone.id}`);
    }

    // ---- Funnel counters --------------------------------------------------
    const docsCalls = calls.filter((call) => /vgpu\s+docs\b/.test(call.command));
    const renderCalls = calls.filter((call) => /node\s+\S*render\.mjs/.test(call.command));
    const firstGoodRender = turn.toolCalls.findIndex((call) => {
      if (call.name !== "bash") return false;
      const command = String((call.input as { command?: unknown } | undefined)?.command ?? "");
      const exitCode = (call.output as { exitCode?: unknown } | undefined)?.exitCode;
      return /node\s+\S*render\.mjs/.test(command) && exitCode === 0;
    });
    t.log(`funnel: docs_cmd_count=${docsCalls.length}`);
    t.log(`funnel: renders_count=${renderCalls.length}`);
    t.log(
      `funnel: tool_calls_to_first_successful_render=${firstGoodRender === -1 ? "never" : firstGoodRender + 1}`,
    );
    t.log(`funnel: total_tool_calls=${turn.toolCalls.length}`);

    // ---- Stale API (soft) -------------------------------------------------
    // Checked in two places, because they answer different questions: what the
    // model reached for while working, and what it actually shipped.
    //
    // "While working" includes the TEXT of its bash commands, not just
    // `write_file` payloads: agents write files through heredocs
    // (`cat > render.mjs <<'EOF'`), `sed -i`, and `node -e`, and a signal that
    // only reads one tool silently under-reports every other route.
    const written = [
      ...turn.toolCalls
        .filter((call) => call.name === "write_file")
        .map((call) => String((call.input as { content?: unknown } | undefined)?.content ?? "")),
      commands,
    ].join("\n");
    const shipped = finalSources(extracted);
    const emitted = STALE_API.some((pattern) => pattern.test(written) || pattern.test(shipped));
    const stillStale = STALE_API.some((pattern) => pattern.test(shipped));
    const usesCurrent = CURRENT_API.some((pattern) => pattern.test(shipped));
    const recovered = emitted && !stillStale && usesCurrent && firstGoodRender !== -1;
    t.log(`stale_api_emitted=${emitted}`);
    t.log(`stale_api_recovered=${recovered}`);

    // ---- Docs usage quality (soft judges) ---------------------------------
    // The only model-graded signals here, and they grade DISCOVERY behaviour,
    // not whether the image is right — pixels already answered that. Three
    // separate questions rather than one compound verdict, because "used the
    // CLI but read ten pages at random" and "read one page and ignored it" are
    // different findings and a single yes/no hides which one happened.
    const docsExcerpt = docsCalls
      .map((call) => `$ ${call.command}\n${call.output.trim()}`)
      .join("\n\n")
      .slice(0, JUDGE_SECTION_LIMIT);
    const material = [
      // The counters are handed over explicitly. Asking a judge to weigh
      // "proportionate" while making it count commands out of a transcript
      // produced 1.0 for a 7-call run and a 24-call run alike.
      "Counters for this run:",
      `- documentation commands: ${docsCalls.length}`,
      `- total tool calls: ${turn.toolCalls.length}`,
      `- tool calls up to and including the first successful render: ${
        firstGoodRender === -1 ? "never rendered successfully" : firstGoodRender + 1
      }`,
      "",
      "Commands the agent ran:",
      commands.slice(0, JUDGE_SECTION_LIMIT) || "(none)",
      "",
      "Output of its documentation commands (truncated):",
      docsExcerpt || "(the agent ran no documentation commands)",
    ].join("\n");

    const questions: { label: string; criteria: string }[] = [
      {
        label: "docs discovery via CLI",
        criteria: "Did the agent use the package's own CLI to discover the API it needed?",
      },
      {
        label: "discovery proportionate",
        criteria:
          "Was the amount of discovery proportionate for a task this small (write one file that renders a " +
          "gradient)? Judge from the counters, not the prose: 1-3 documentation commands is proportionate; " +
          "4-6 is acceptable only if each command was targeted at something the agent then used; more than 6 " +
          "documentation commands, or more than 20 total tool calls, or more than 12 tool calls before the " +
          "first successful render, is wandering. Answer N when the counters fall outside those ranges and " +
          "the commands show no clear reason for the extra work.",
      },
      {
        label: "acted on docs read",
        criteria:
          "Did it act on what it found, so the code it wrote reflects the documentation it read?",
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
