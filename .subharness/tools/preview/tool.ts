// subharness tool that lets an agent see a docs example running in WebGPU Chrome and drive it.
import { tool, toolResult } from "subharness";
import { z } from "zod";
import { capturePreview } from "./capture.ts";

const point = z.object({ x: z.number(), y: z.number() });

const step = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wait"), ms: z.number().int().min(0).max(30_000) }),
  z.object({ type: z.literal("screenshot"), label: z.string().max(60).optional() }),
  z.object({ type: z.literal("move"), to: point, durationMs: z.number().int().min(0).max(10_000).optional() }),
  z.object({ type: z.literal("down"), at: point.optional() }),
  z.object({ type: z.literal("up"), at: point.optional() }),
  z.object({ type: z.literal("click"), at: point.optional(), selector: z.string().optional() }),
  z.object({
    type: z.literal("drag"),
    points: z.array(point).min(2).max(64),
    durationMs: z.number().int().min(16).max(10_000).optional(),
    release: z.boolean().optional(),
  }),
  z.object({ type: z.literal("wheel"), at: point, deltaY: z.number(), deltaX: z.number().optional() }),
  z.object({ type: z.literal("key"), key: z.string() }),
  z.object({ type: z.literal("eval"), expression: z.string().max(20_000), label: z.string().max(60).optional() }),
  z.object({ type: z.literal("fps"), ms: z.number().int().min(250).max(10_000) }),
]);

const maxShots = 8;

/**
 * `capture_preview` opens `/preview/<slug>` of this checkout's docs dev server (started on demand)
 * in headless Chrome with a real WebGPU adapter, runs scripted steps, and returns the screenshots
 * as images plus a JSON report: pixel stats that flag black frames, console errors/warnings,
 * page exceptions, the preview error overlay, eval results, frame timing, and canvas sizes.
 */
export const capturePreviewTool = tool({
  description: [
    "See a docs example running in headless Chrome with real WebGPU, optionally drive it, and get screenshots back as images.",
    "Opens /preview/<slug> (or `path`) from this checkout's apps/docs dev server, starting `next dev` on demand (first compile of a new route can take ~30 s).",
    "After the page is ready (`waitFor` selector, default canvas) and `settleMs`, runs `steps` in order.",
    "Pointer coordinates are CSS pixels of the viewport; drags/moves are interpolated in real time, so a short drag durationMs produces a fast flick (useful for drag inertia).",
    "Step types: wait{ms}, screenshot{label}, move{to,durationMs}, down{at}, up{at}, click{at|selector}, drag{points[],durationMs,release}, wheel{at,deltaY,deltaX}, key{key}, eval{expression,label} (awaited, JSON-serializable result), fps{ms} (rAF frame-time stats).",
    `Up to ${maxShots} screenshots per call; a final screenshot is taken if none is requested.`,
    "The report flags `uniform: true` frames (black/failed render), and lists console problems and the vgpu preview error overlay text. PNGs are saved under .context/shots/<slug>/.",
  ].join(" "),
  inputSchema: z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/).describe("Example slug, e.g. \"fluid\"."),
    path: z.string().startsWith("/").optional().describe("Override the URL path, e.g. \"/examples/fluid\" for the gallery page."),
    width: z.number().int().min(320).max(2560).optional().describe("Viewport width in CSS px (default 1280)."),
    height: z.number().int().min(240).max(1600).optional().describe("Viewport height in CSS px (default 720)."),
    settleMs: z.number().int().min(0).max(30_000).optional().describe("Wait after ready before the steps run (default 2500)."),
    waitFor: z.string().optional().describe("CSS selector that marks the page ready (default \"canvas\")."),
    reducedMotion: z.boolean().optional().describe("Emulate prefers-reduced-motion: reduce."),
    steps: z.array(step).max(80).optional(),
  }),
  execute: async (input) => {
    const shotCount = (input.steps ?? []).filter((entry) => entry.type === "screenshot").length;
    if (shotCount > maxShots) throw new Error(`At most ${maxShots} screenshot steps per call; got ${shotCount}.`);
    const result = await capturePreview({
      root: process.cwd(),
      slug: input.slug,
      path: input.path,
      width: input.width ?? 1280,
      height: input.height ?? 720,
      settleMs: input.settleMs ?? 2500,
      waitFor: input.waitFor ?? "canvas",
      reducedMotion: input.reducedMotion ?? false,
      steps: input.steps ?? [],
    });
    const report = { ...result, shots: result.shots.map(({ png: _png, ...shot }) => shot) };
    return toolResult({
      content: [
        { type: "text", text: JSON.stringify(report, null, 2) },
        ...result.shots.flatMap((shot) => [
          { type: "text" as const, text: `Screenshot: ${shot.label} (${shot.file})` },
          { type: "image" as const, mimeType: "image/png" as const, data: shot.png.toString("base64") },
        ]),
      ],
    });
  },
});
