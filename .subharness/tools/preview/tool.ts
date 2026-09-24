// subharness tool that lets an agent see a docs example running in WebGPU Chrome and drive it.
import { tool, toolResult } from "subharness";
import { z } from "zod";
import { capturePreview } from "./capture.ts";
import { imageSteps } from "./steps.ts";

const point = z.object({ x: z.number(), y: z.number() });
const anchor = z.union([
  point,
  z.object({ selector: z.string(), at: point.optional().describe("Point inside the element box, 0–1 per axis; default centre.") }),
]).describe("Viewport point in CSS px, or { selector, at? } resolved when the step runs.");
const pointer = z.enum(["mouse", "touch"]).optional().describe("Default mouse. Touch needs `touch: true`.");
const clip = z.union([
  z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  z.object({ selector: z.string(), pad: z.number().optional() }),
]);

const step = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wait"), ms: z.number().int().min(0).max(30_000) }),
  z.object({ type: z.literal("screenshot"), label: z.string().max(60).optional(), clip: clip.optional(), scale: z.number().min(0.25).max(4).optional().describe("Output scale; 2 zooms a clip for detail.") }),
  z.object({
    type: z.literal("burst"),
    count: z.number().int().min(2).max(24),
    everyMs: z.number().int().min(0).max(2000).describe("Real-time spacing; capture latency floors it at ~20–40 ms."),
    columns: z.number().int().min(1).max(8).optional(),
    clip: clip.optional(),
    label: z.string().max(60).optional(),
  }),
  z.object({ type: z.literal("move"), to: anchor, durationMs: z.number().int().min(0).max(10_000).optional(), pointer }),
  z.object({ type: z.literal("down"), at: anchor.optional(), pointer }),
  z.object({ type: z.literal("up"), at: anchor.optional(), pointer }),
  z.object({ type: z.literal("click"), at: anchor.optional(), selector: z.string().optional(), pointer }),
  z.object({
    type: z.literal("drag"),
    points: z.array(anchor).min(2).max(64).optional(),
    from: anchor.optional(),
    to: anchor.optional(),
    by: z.object({ dx: z.number(), dy: z.number() }).optional(),
    durationMs: z.number().int().min(16).max(10_000).optional(),
    release: z.boolean().optional(),
    pointer,
  }),
  z.object({ type: z.literal("wheel"), at: anchor, deltaY: z.number(), deltaX: z.number().optional() }),
  z.object({ type: z.literal("key"), key: z.string(), modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).optional() }),
  z.object({ type: z.literal("eval"), expression: z.string().max(20_000), label: z.string().max(60).optional() }),
  z.object({ type: z.literal("rects"), selectors: z.array(z.string()).min(1).max(16), props: z.array(z.string()).max(16).optional(), label: z.string().max(60).optional() }),
  z.object({ type: z.literal("perf"), ms: z.number().int().min(250).max(10_000), label: z.string().max(60).optional() }),
  z.object({ type: z.literal("hide"), selector: z.string() }),
  z.object({ type: z.literal("show"), selector: z.string() }),
  z.object({ type: z.literal("media"), reducedMotion: z.boolean() }),
  z.object({ type: z.literal("resize"), width: z.number().int().min(320).max(2560), height: z.number().int().min(240).max(1600) }),
  z.object({ type: z.literal("gui"), set: z.record(z.string(), z.union([z.number(), z.boolean(), z.string(), z.null()])).describe("lil-gui controllers by label; null clicks a button.") }),
]);

const maxImages = 8;

/**
 * `capture_preview` opens `/preview/<slug>` of this checkout's docs dev server (started on demand)
 * in headless Chrome with a real WebGPU adapter, runs scripted steps, and returns the screenshots
 * and contact sheets as images plus a JSON report.
 */
export const capturePreviewTool = tool({
  description: [
    "See a docs example running in headless Chrome with real WebGPU, drive it, and get screenshots back as images.",
    "Opens /preview/<slug> (or `path`) from this checkout's apps/docs dev server, starting `next dev` on demand (first compile of a new route can take ~30 s).",
    "After the page is ready (`waitFor`, default canvas) and `settleMs`, runs `steps` in order.",
    "Pointer targets are viewport CSS px or { selector, at } element anchors resolved when the step runs; moves and drags are interpolated in real time (short durationMs = flick). `pointer: \"touch\"` (with `touch: true`) sends real touch events.",
    "Steps: wait, screenshot{label,clip,scale}, burst{count,everyMs,columns,clip} (one contact-sheet image of an animation), move{to}, down{at}, up{at}, click{at|selector}, drag{points | from+to | from+by, durationMs, release}, wheel, key{key,modifiers} (Enter/Space activate buttons), eval{expression}, rects{selectors,props}, perf{ms}, hide/show{selector}, media{reducedMotion}, resize{width,height}, gui{set: {label: value}}.",
    "perf reports rAF frame ms, JS ms per frame in page rAF callbacks, GPU submit→done latency (≈ GPU time, an upper bound) and long frames — measure at dpr 2, which is what most visitors have.",
    `Up to ${maxImages} screenshots/bursts per call; a final screenshot is taken if none is requested.`,
    "The report flags `uniform: true` frames (black/failed render), console problems, the vgpu preview error overlay, Next dev errors, and the focused element per screenshot. PNGs are saved under .context/shots/<slug>/.",
  ].join(" "),
  inputSchema: z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/).describe("Example slug, e.g. \"fluid\"."),
    path: z.string().startsWith("/").optional().describe("Override the URL path, e.g. \"/examples/fluid\" for the gallery page."),
    width: z.number().int().min(320).max(2560).optional().describe("Viewport width in CSS px (default 1280)."),
    height: z.number().int().min(240).max(1600).optional().describe("Viewport height in CSS px (default 720)."),
    dpr: z.number().min(1).max(3).optional().describe("Device pixel ratio (default 1). Use 2 for realistic GPU cost."),
    touch: z.boolean().optional().describe("Emulate a touch screen (needed for pointer: \"touch\")."),
    settleMs: z.number().int().min(0).max(30_000).optional().describe("Wait after ready before the steps run (default 2500)."),
    waitFor: z.string().optional().describe("CSS selector that marks the page ready (default \"canvas\")."),
    reducedMotion: z.boolean().optional().describe("Start with prefers-reduced-motion: reduce."),
    steps: z.array(step).max(80).optional(),
  }),
  execute: async (input) => {
    const steps = input.steps ?? [];
    if (imageSteps(steps) > maxImages) throw new Error(`At most ${maxImages} screenshot/burst steps per call; got ${imageSteps(steps)}.`);
    const result = await capturePreview({
      root: process.cwd(),
      slug: input.slug,
      path: input.path,
      width: input.width ?? 1280,
      height: input.height ?? 720,
      dpr: input.dpr ?? 1,
      touch: input.touch ?? false,
      settleMs: input.settleMs ?? 2500,
      waitFor: input.waitFor ?? "canvas",
      reducedMotion: input.reducedMotion ?? false,
      steps,
    });
    const report = { ...result, shots: result.shots.map(({ png: _png, ...shot }) => shot) };
    return toolResult({
      content: [
        { type: "text", text: JSON.stringify(report, null, 2) },
        ...result.shots.flatMap((shot) => [
          { type: "text" as const, text: `Image: ${shot.label} (${shot.file})` },
          { type: "image" as const, mimeType: "image/png" as const, data: shot.png.toString("base64") },
        ]),
      ],
    });
  },
});
