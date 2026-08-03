import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { PNG } from "pngjs";
import { snapshotTarPath, snapshotWorkspaceDir } from "../agent/lib/paths.ts";

/**
 * The prompt is deliberately free of vgpu vocabulary: no "shader", no "WebGPU",
 * no "doctor", no "docs". Whether the agent finds the library's own tooling is
 * the interesting part of the run; naming it here would answer the question for
 * it. Keep it that way.
 */
const PROMPT = [
  "The project in /workspace renders an image by running `node render.mjs`,",
  "which writes `out.png`.",
  "",
  "Make it produce a solid red image: every pixel exactly R=255, G=0, B=0, A=255,",
  "at 64x64.",
  "",
  "Keep the entry point as `node render.mjs` writing `out.png`.",
].join("\n");

const EXPECTED = { width: 64, height: 64, color: [255, 0, 0, 255] as const };

/** Journey signals. Observed and logged, never gated — see below. */
const MILESTONES: { id: string; test: RegExp }[] = [
  { id: "ran the vgpu CLI at all", test: /(^|[^\w-])(npx\s+)?vgpu\b/ },
  { id: "read the docs (vgpu docs)", test: /vgpu\s+docs\b/ },
  { id: "ran vgpu doctor", test: /vgpu\s+doctor\b/ },
  { id: "validated WGSL (vgpu check)", test: /vgpu\s+check\b/ },
  { id: "looked at examples", test: /vgpu\s+examples\b/ },
];

function dominantPixel(png: PNG): { color: number[]; fraction: number } {
  const counts = new Map<string, number>();
  for (let i = 0; i < png.data.length; i += 4) {
    const key = `${png.data[i]},${png.data[i + 1]},${png.data[i + 2]},${png.data[i + 3]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  const total = png.data.length / 4;
  return { color: best.split(",").map(Number), fraction: total === 0 ? 0 : bestCount / total };
}

export default defineEval({
  description: "s1-clear-color: make `node render.mjs` write a solid red 64x64 out.png",

  async test(t) {
    // Credentials first, before anything is spent. A missing key must skip, not
    // fail: a red suite that only means "you have no token" trains people to
    // ignore red suites.
    if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
      t.skip("no AI Gateway credential (set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)");
    }
    // The export hook writes the workspace tar to the HOST running the agent
    // runtime. Against a remote target that host is not this machine, so the
    // tar we would read here is either absent or stale — skip rather than
    // grade the wrong bytes.
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
    // completed turn, so a stale one from an earlier turn would otherwise be
    // graded as if it were this turn's work.
    const exportedAt = statSync(tarPath).mtimeMs;
    t.check(exportedAt >= startedAt, equals(true))
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
    const { color, fraction } = dominantPixel(png);
    t.log(
      `out.png: ${png.width}x${png.height}, dominant pixel [${color.join(",")}] ` +
        `covering ${(fraction * 100).toFixed(2)}% of the image`,
    );

    // ---- Gates ------------------------------------------------------------
    // v0 trusts the agent's out.png: this reads the file it left behind, it
    // does NOT re-render from source. An agent that hand-writes a red PNG
    // passes. That is a known and accepted limitation of this iteration — see
    // "Trust model" in the README.
    t.check(`${png.width}x${png.height}`, equals(`${EXPECTED.width}x${EXPECTED.height}`))
      .gate()
      .label("image is 64x64");
    t.check(color.join(","), equals(EXPECTED.color.join(",")))
      .gate()
      .label("dominant pixel is solid red");
    // The prompt says "every pixel exactly", so grade that and not the mode:
    // a half-red image has a red dominant pixel and is not the asked-for image.
    t.check(fraction, equals(1))
      .gate()
      .label("every pixel is that colour");

    // ---- Journey (soft, never a gate) -------------------------------------
    // This is the part a docs/DX person actually reads: HOW did the agent get
    // there? Gating on it would reward ritual — an agent that solves the task
    // without reading the docs has still solved the task, and one that runs
    // `vgpu docs` five times and fails has not.
    // Only bash commands. Serialising every tool call's input made the first
    // real run report "ran the vgpu CLI" for an agent that never invoked it:
    // the pattern matched the `vgpu/node` import inside a write_file payload.
    // A journey signal that fires on the agent typing a package name measures
    // nothing.
    const commands = turn.toolCalls
      .filter((call) => call.name === "bash")
      .map((call) => String((call.input as { command?: unknown } | undefined)?.command ?? ""))
      .join("\n");
    for (const milestone of MILESTONES) {
      const hit = milestone.test.test(commands);
      t.log(`journey: ${hit ? "yes" : "no "} — ${milestone.id}`);
      t.check(hit, equals(true)).soft().label(`journey: ${milestone.id}`);
    }
    t.log(`journey: ${turn.toolCalls.length} tool calls in total`);
  },
});
