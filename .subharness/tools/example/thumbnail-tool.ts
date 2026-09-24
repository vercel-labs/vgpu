// subharness tool: render an example's thumbnail at full size on the local GPU (Metal on macOS) in
// seconds, to judge composition before paying for the canonical Mesa render.
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import pngjs from "pngjs";
import { tool, toolResult } from "subharness";
import { z } from "zod";
import { runCommand } from "./run.ts";

export const renderThumbnailTool = tool({
  description: [
    "Render an example's gallery thumbnails (card 1280×720 and hero 1600×900) through its real render-thumbnail.ts on this machine's GPU, in seconds, without touching the committed baselines.",
    "Returns both images, their luma variance (must be ≥ 6), render time, whether two renders are byte-identical (repeat: 2), and the share of pixels that differ from the committed baseline (a code change that moves many pixels needs a Mesa --update).",
    "Use it to pick the thumbnail moment; then confirm in CI's renderer with `node .subharness/tools/thumbs/mesa.ts <slug>` (Bash, slow).",
  ].join(" "),
  inputSchema: z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    repeat: z.union([z.literal(1), z.literal(2)]).optional().describe("2 renders twice and reports whether the output is deterministic."),
    images: z.enum(["card", "hero", "both"]).optional().describe("Which renders to return as images (default card)."),
  }),
  execute: async ({ slug, repeat = 1, images = "card" }) => {
    const { report, files } = await renderThumbnailPreview(process.cwd(), slug, repeat);
    const shown = images === "both" ? (["card", "hero"] as const) : [images];
    return toolResult({
      content: [
        { type: "text", text: JSON.stringify(report, null, 2) },
        ...shown.map((kind) => ({ type: "image" as const, mimeType: "image/png" as const, data: files[kind].toString("base64") })),
      ],
    });
  },
});

/**
 * Renders card and hero through the thumbnail script's `--preview-dir` mode `repeat` times and
 * reports determinism and drift from the committed baselines.
 *
 * @example
 *   const { report } = await renderThumbnailPreview("/repo", "fluid", 2); // report.deterministic
 */
export async function renderThumbnailPreview(root: string, slug: string, repeat: 1 | 2) {
  const docs = path.join(root, "apps/docs");
  const runs = [];
  for (let index = 0; index < repeat; index++) {
    const dir = path.join(root, ".context/thumbs", slug, `metal-${index + 1}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const result = await runCommand(`node scripts/render-example-thumbs.mjs --preview-dir ${JSON.stringify(dir)} --only ${slug}`, docs, { timeoutMs: 240_000 });
    if (result.code !== 0) throw new Error(`thumbnail render failed (${result.code}):\n${result.output}`);
    runs.push({ dir, result });
  }
  const kinds = ["card", "hero"] as const;
  const files = Object.fromEntries(await Promise.all(kinds.map(async (kind) => [kind, await readFile(path.join(runs[0].dir, `${slug}.${kind}.png`))] as const))) as Record<(typeof kinds)[number], Buffer>;
  const report = {
    slug,
    renderer: "local GPU through vgpu/node (Metal on macOS) — composition preview, not the CI renderer",
    seconds: runs.map((run) => run.result.seconds),
    lines: runs[0].result.output.split("\n").filter((line) => line.startsWith(`- ${slug}.`)),
    files: kinds.map((kind) => path.join(runs[0].dir, `${slug}.${kind}.png`)),
    deterministic: repeat === 2 ? await identical(runs.map((run) => run.dir), slug) : undefined,
    changedVsBaseline: Object.fromEntries(await Promise.all(kinds.map(async (kind) => [kind, await changedShare(files[kind], path.join(docs, "public/examples", `${slug}.${kind}.png`))]))),
  };
  return { report, files };
}

async function identical(dirs: string[], slug: string): Promise<boolean> {
  for (const kind of ["card", "hero"]) {
    const [a, b] = await Promise.all(dirs.map((dir) => readFile(path.join(dir, `${slug}.${kind}.png`))));
    if (!a.equals(b)) return false;
  }
  return true;
}

/** Share of pixels whose largest channel difference exceeds 10% (pixelmatch's threshold scale). */
async function changedShare(png: Buffer, baselinePath: string): Promise<string> {
  const baseline = await readFile(baselinePath).catch(() => undefined);
  if (!baseline) return "no committed baseline";
  const a = pngjs.PNG.sync.read(png);
  const b = pngjs.PNG.sync.read(baseline);
  if (a.width !== b.width || a.height !== b.height) return `size differs (${b.width}×${b.height} committed)`;
  let changed = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    const diff = Math.max(Math.abs(a.data[index] - b.data[index]), Math.abs(a.data[index + 1] - b.data[index + 1]), Math.abs(a.data[index + 2] - b.data[index + 2]));
    if (diff > 25) changed++;
  }
  return `${((changed / (a.width * a.height)) * 100).toFixed(2)}%`;
}
