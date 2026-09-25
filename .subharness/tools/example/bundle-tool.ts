// subharness tool: measure every preview route of the current production build against its budget in
// one pass, show which chunks routes share, and compare with the latest canary CI measurement.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { tool } from "subharness";
import { z } from "zod";
import { runCommand } from "./run.ts";

interface Measurement {
  readonly slug: string;
  readonly gzip: number;
  readonly raw: number;
  readonly chunks: readonly string[];
}

const linePattern = /^([a-z0-9-]+): (\d+) B gzip \/ (\d+) B raw \(baseline \d+ B, limit \d+ B; chunks ([^)]*)\)/;

export const bundleReportTool = tool({
  description: [
    "Grade every docs preview route of the current production build (apps/docs/.next) against apps/docs/scripts/example-chunk-budgets.json in one pass — the repo checker stops at the first failure.",
    "Reports gzip/raw per route, baseline, limit, over-limit routes, chunks shared between routes, the local-minus-CI delta against the latest green canary CI run, and a proposed budget entry for `slug`.",
    "It never builds: when the build is stale or missing it says so — then run `pnpm --filter docs build` in the background (several minutes), `git checkout apps/docs/next-env.d.ts`, and call it again.",
  ].join(" "),
  inputSchema: z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/).optional().describe("The example being added; gets a proposed budget entry."),
    ci: z.boolean().optional().describe("Compare with the latest green canary CI measurement (default true; needs gh)."),
  }),
  execute: async ({ slug, ci = true }) => {
    const root = process.cwd();
    const docs = path.join(root, "apps/docs");
    const budgets = JSON.parse(await readFile(path.join(docs, "scripts/example-chunk-budgets.json"), "utf8"));
    const slugs = [...(await readFile(path.join(docs, "lib/example-slugs.ts"), "utf8")).matchAll(/^\s+'([a-z0-9-]+)',$/gm)].map((match) => match[1]);
    const loose = { ...budgets, sharedHost: { ...budgets.sharedHost, gzipBytes: 1e9 }, examples: Object.fromEntries(slugs.map((name) => [name, 1e9])) };
    const looseFile = path.join(root, ".context/bundle-budgets.loose.json");
    await mkdir(path.dirname(looseFile), { recursive: true });
    await writeFile(looseFile, JSON.stringify(loose));
    const run = await runCommand("node scripts/check-example-bundles.mjs", docs, { env: { VGPU_EXAMPLE_BUDGETS_FILE: looseFile }, tailLines: 400 });
    if (run.code !== 0) {
      const stale = /Stale chunks|Missing \.next/.test(run.output);
      return { ok: false, stale, message: run.output.split("\n").slice(-8).join("\n"), next: stale ? "Run `pnpm --filter docs build` (background), then `git checkout apps/docs/next-env.d.ts`, then call bundle_report again." : "Structural failure (isolation or loader); fix it before grading sizes." };
    }
    const measured = parse(run.output);
    const ciMeasured = ci ? await canaryMeasurements(root).catch((error) => ({ error: String(error) })) : undefined;
    const routes = measured.map((route) => {
      const baseline = budgets.examples[route.slug] as number | undefined;
      const limit = baseline === undefined ? undefined : baseline + Math.max(budgets.exampleGrowth.minimumBytes, Math.ceil(baseline * budgets.exampleGrowth.percent / 100));
      const ciGzip = ciMeasured && "routes" in ciMeasured ? ciMeasured.routes.get(route.slug) : undefined;
      return {
        slug: route.slug,
        gzip: route.gzip,
        raw: route.raw,
        baseline,
        limit,
        status: baseline === undefined ? "no-baseline" : route.gzip > limit! ? "over" : "ok",
        deltaVsBaseline: baseline === undefined ? undefined : route.gzip - baseline,
        ciGzip,
        localMinusCi: ciGzip === undefined ? undefined : route.gzip - ciGzip,
        ciStatus: ciGzip === undefined || limit === undefined ? undefined : ciGzip > limit ? "over in CI" : `ok in CI (${limit - ciGzip} B headroom)`,
      };
    });
    const owners = new Map<string, string[]>();
    for (const route of measured) for (const chunk of route.chunks) owners.set(chunk, [...(owners.get(chunk) ?? []), route.slug]);
    const target = slug ? measured.find((route) => route.slug === slug) : undefined;
    // The tool boundary rejects `undefined` anywhere in the result; a JSON round trip drops those keys.
    return jsonSafe({
      ok: routes.every((route) => route.status === "ok"),
      over: routes.filter((route) => route.status !== "ok"),
      // Routes whose size differs from the current canary CI build: candidates for a chunk-factoring shift caused by this branch.
      moved: routes.filter((route) => route.slug !== slug && route.localMinusCi !== undefined && Math.abs(route.localMinusCi) >= 100),
      target: target && {
        ...routes.find((route) => route.slug === slug),
        chunks: await Promise.all(target.chunks.map(async (chunk) => {
          const others = (owners.get(chunk) ?? []).filter((owner) => owner !== slug);
          const source = await readFile(path.join(docs, ".next/static/chunks", chunk));
          return {
            chunk,
            gzip: gzipSync(source).byteLength,
            raw: source.byteLength,
            hints: packageHints(source.toString("utf8")),
            sharedWith: others.length > 6 ? `${others.length} other routes (framework)` : others,
          };
        })),
        proposedBudget: { [`examples.${slug}`]: target.gzip, [`$comment:${slug}`]: `Measured at ${target.gzip} B gzip from a local production build on Node ${process.versions.node} / Next <version>; <what dominates the size>.` },
      },
      ci: ciMeasured && ("routes" in ciMeasured ? { run: ciMeasured.run, sha: ciMeasured.sha } : ciMeasured),
      routes,
      rule: "Only change another route's baseline when it is over its limit in CI terms (ciGzip + your shift > limit). localMinusCi mixes environment noise (tens of bytes; atmosphere reads ~188 B high on macOS) with real chunk-factoring shifts from this branch; a shift within its limit needs no budget change.",
    });
  },
});

/** Rough content hints for a minified chunk, for writing the `$comment` budget notes. */
function packageHints(source: string): string[] {
  const hints: [string, RegExp][] = [
    ["motion/react (layout/drag/presence)", /layoutId|dragConstraints|AnimatePresence|PresenceContext/],
    ["motion core", /springValue|stagger|inertia|calcGeneratorDuration/],
    ["lil-gui", /lil-gui|\.lil-controller/],
    ["vgpu", /VGPU-[A-Z]/],
    ["example WGSL", /@fragment|@compute|@vertex/],
    ["react-dom", /react-dom|__reactFiber/],
  ];
  return hints.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parse(output: string): Measurement[] {
  return output.split("\n").flatMap((line) => {
    const match = line.match(linePattern);
    return match ? [{ slug: match[1], gzip: Number(match[2]), raw: Number(match[3]), chunks: match[4].split(", ") }] : [];
  });
}

/** Latest green canary CI run's `check:example-bundles` numbers, cached per run in .context/. */
async function canaryMeasurements(root: string) {
  const gh = (args: string[]) => execFileSync("gh", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const [run] = JSON.parse(gh(["run", "list", "-R", "vercel-labs/vgpu", "--branch", "canary", "--workflow", "ci.yml", "--status", "success", "--limit", "1", "--json", "databaseId,headSha"])) as { databaseId: number; headSha: string }[];
  if (!run) throw new Error("no green canary CI run found");
  const cacheFile = path.join(root, ".context", `bundle-ci-${run.databaseId}.txt`);
  let log = await readFile(cacheFile, "utf8").catch(() => undefined);
  if (!log) {
    const job = gh(["api", `repos/vercel-labs/vgpu/actions/runs/${run.databaseId}/jobs`, "--paginate", "--jq", '.jobs[] | select(.name=="docs-app-build") | .id']).trim();
    log = gh(["api", `repos/vercel-labs/vgpu/actions/jobs/${job}/logs`]).split("\n").map((line) => line.replace(/^\S+Z /, "")).filter((line) => linePattern.test(line)).join("\n");
    await writeFile(cacheFile, log);
  }
  return { run: run.databaseId, sha: run.headSha.slice(0, 8), routes: new Map(parse(log).map((route) => [route.slug, route.gzip])) };
}
