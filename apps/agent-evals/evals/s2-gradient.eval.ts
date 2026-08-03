import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { PNG } from "pngjs";
import { snapshotTarPath, snapshotWorkspaceDir } from "../agent/lib/paths.ts";

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

/**
 * Per-channel slack.
 *
 * A gradient is interpolated and then quantised to 8 bits, and rasterisers
 * disagree in the last bit or two: lavapipe, a hardware driver and a hand-rolled
 * loop will not agree exactly on the value at x=57. Demanding equality would
 * fail correct images for reasons that have nothing to do with the agent, so
 * every colour comparison here allows +/-2.
 */
const TOL = 2;

/** Sample stride along the middle row. Every pixel is unnecessary and noisy. */
const STRIDE = 8;

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
/** The 0.2.0 shape: free functions taking `gpu` as their first argument. */
const CURRENT_API = [/\btarget\s*\(\s*gpu\b/, /\beffect\s*\(\s*gpu\b/];

const CODE_EXTENSIONS = new Set([".mjs", ".js", ".ts", ".wgsl"]);

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

/** Every text payload the agent wrote through `write_file`. */
function writtenSources(toolCalls: readonly { name: string; input?: unknown }[]): string {
  return toolCalls
    .filter((call) => call.name === "write_file")
    .map((call) => String((call.input as { content?: unknown } | undefined)?.content ?? ""))
    .join("\n");
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

function pixel(png: PNG, x: number, y: number): number[] {
  const i = (png.width * y + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

/** Largest per-channel deviation of a whole column from an expected colour. */
function columnDeviation(png: PNG, x: number, expected: readonly number[]): number {
  let worst = 0;
  for (let y = 0; y < png.height; y += 1) {
    const px = pixel(png, x, y);
    for (let c = 0; c < 4; c += 1) worst = Math.max(worst, Math.abs(px[c] - expected[c]));
  }
  return worst;
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
    t.check(`${png.width}x${png.height}`, equals(`${SIZE}x${SIZE}`))
      .gate()
      .label("image is 128x128");

    const leftOff = columnDeviation(png, 0, [255, 0, 0, 255]);
    const rightOff = columnDeviation(png, png.width - 1, [0, 0, 255, 255]);
    t.log(`endpoints: left column off by <=${leftOff}, right column off by <=${rightOff} (tolerance ${TOL})`);
    t.check(leftOff <= TOL, equals(true)).gate().label("leftmost column is pure red");
    t.check(rightOff <= TOL, equals(true)).gate().label("rightmost column is pure blue");

    // Monotonic across the middle row: red must fall, blue must rise, green
    // must stay out of it. This is what separates a gradient from two flat
    // halves or a red-to-blue image that wanders through purple and back.
    const y = Math.floor(png.height / 2);
    const xs: number[] = [];
    for (let x = 0; x < png.width; x += STRIDE) xs.push(x);
    if (xs[xs.length - 1] !== png.width - 1) xs.push(png.width - 1);
    const samples = xs.map((x) => pixel(png, x, y));

    let redRises = 0;
    let blueFalls = 0;
    let greenOff = 0;
    for (let i = 0; i < samples.length; i += 1) {
      greenOff = Math.max(greenOff, Math.abs(samples[i][1]));
      if (i === 0) continue;
      if (samples[i][0] > samples[i - 1][0] + TOL) redRises += 1;
      if (samples[i][2] < samples[i - 1][2] - TOL) blueFalls += 1;
    }
    t.log(
      `middle row (${samples.length} samples every ${STRIDE}px): ` +
        `red rises ${redRises}x, blue falls ${blueFalls}x, max green ${greenOff}`,
    );
    t.log(`  R: ${samples.map((s) => s[0]).join(" ")}`);
    t.log(`  B: ${samples.map((s) => s[2]).join(" ")}`);
    t.check(redRises === 0 && blueFalls === 0 && greenOff <= TOL, equals(true))
      .gate()
      .label("middle row is monotonic red-to-blue");

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
    // Checked in two places, because they answer different questions: the
    // transcript says what the model reached for first, the final workspace
    // says what it shipped.
    const written = writtenSources(turn.toolCalls);
    const shipped = finalSources(extracted);
    const emitted = STALE_API.some((pattern) => pattern.test(written) || pattern.test(shipped));
    const stillStale = STALE_API.some((pattern) => pattern.test(shipped));
    const usesCurrent = CURRENT_API.some((pattern) => pattern.test(shipped));
    const recovered = emitted && !stillStale && usesCurrent && firstGoodRender !== -1;
    t.log(`stale_api_emitted=${emitted}`);
    t.log(`stale_api_recovered=${recovered}`);

    // ---- Docs usage quality (soft judge) ----------------------------------
    // The only model-graded signal here, and it grades the agent's DISCOVERY
    // behaviour, not whether the image is right — pixels already answered that.
    const docsExcerpt = docsCalls
      .map((call) => `$ ${call.command}\n${call.output.trim()}`)
      .join("\n\n")
      .slice(0, 2000);
    const material = [
      "Commands the agent ran:",
      commands || "(none)",
      "",
      "Output of its documentation commands (truncated):",
      docsExcerpt || "(the agent ran no documentation commands)",
    ].join("\n");
    t.judge.autoevals
      .closedQA(
        [
          "(1) Did the agent use the package's own CLI to discover the API it needed?",
          "(2) Was the number of discovery commands proportionate — a few targeted queries",
          "rather than blind wandering?",
          "(3) Did it act on what it found, so the code it wrote reflects the documentation it read?",
        ].join(" "),
        { on: material },
      )
      .soft()
      .label("docs usage quality");
  },
});
