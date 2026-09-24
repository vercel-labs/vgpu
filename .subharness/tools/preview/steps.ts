// The scripted steps a capture replays on the live page, and the runner that turns them into
// screenshots, contact sheets, evaluations, and timing reports.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChromePage } from "./chrome.ts";
import { contactSheet } from "./contact-sheet.ts";
import { imageStats, type ImageStats } from "./image-stats.ts";
import { approach, glide, press, pressKey, resolveAnchor, type Anchor, type Point, type Pointer, type PointerKind } from "./input.ts";
import { focusExpression, guiExpression, perfExpression, rectExpression, rectsExpression, visibilityExpression } from "./page-scripts.ts";

export type Clip =
  | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | { readonly selector: string; readonly pad?: number };

type Modifier = "Alt" | "Control" | "Meta" | "Shift";

export type CaptureStep =
  | { readonly type: "wait"; readonly ms: number }
  | { readonly type: "screenshot"; readonly label?: string; readonly clip?: Clip; readonly scale?: number }
  | { readonly type: "burst"; readonly count: number; readonly everyMs: number; readonly label?: string; readonly columns?: number; readonly clip?: Clip }
  | { readonly type: "move"; readonly to: Anchor; readonly durationMs?: number; readonly pointer?: PointerKind }
  | { readonly type: "down"; readonly at?: Anchor; readonly pointer?: PointerKind }
  | { readonly type: "up"; readonly at?: Anchor; readonly pointer?: PointerKind }
  | { readonly type: "click"; readonly at?: Anchor; readonly selector?: string; readonly pointer?: PointerKind }
  | {
      readonly type: "drag";
      readonly points?: readonly Anchor[];
      readonly from?: Anchor;
      readonly to?: Anchor;
      readonly by?: { readonly dx: number; readonly dy: number };
      readonly durationMs?: number;
      readonly release?: boolean;
      readonly pointer?: PointerKind;
    }
  | { readonly type: "wheel"; readonly at: Anchor; readonly deltaY: number; readonly deltaX?: number }
  | { readonly type: "key"; readonly key: string; readonly modifiers?: readonly Modifier[] }
  | { readonly type: "eval"; readonly expression: string; readonly label?: string }
  | { readonly type: "rects"; readonly selectors: readonly string[]; readonly props?: readonly string[]; readonly label?: string }
  | { readonly type: "perf"; readonly ms: number; readonly label?: string }
  | { readonly type: "hide"; readonly selector: string }
  | { readonly type: "show"; readonly selector: string }
  | { readonly type: "media"; readonly reducedMotion: boolean }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "gui"; readonly set: Readonly<Record<string, number | boolean | string | null>> };

export interface CaptureShot {
  readonly label: string;
  readonly file: string;
  readonly png: Buffer;
  readonly stats: ImageStats;
  readonly focus: unknown;
  readonly frames?: readonly { readonly tMs: number; readonly meanLuma: number; readonly lumaStdDev: number; readonly uniform: boolean }[];
}

export interface StepContext {
  readonly page: ChromePage;
  readonly outDir: string;
  readonly viewport: { width: number; height: number; dpr: number; touch: boolean };
}

export interface StepResults {
  readonly shots: CaptureShot[];
  readonly evals: { label: string; value?: unknown; error?: string }[];
  readonly perf: unknown[];
}

const sheetWidth = 1600;

/** Screenshot-like steps: each costs one image in the tool result. */
export function imageSteps(steps: readonly CaptureStep[]): number {
  return steps.filter((step) => step.type === "screenshot" || step.type === "burst").length;
}

export async function runSteps(context: StepContext, steps: readonly CaptureStep[]): Promise<StepResults> {
  const { page } = context;
  const results: StepResults = { shots: [], evals: [], perf: [] };
  const pointer: Pointer = { x: 0, y: 0, pressed: false };
  const stamp = Date.now();
  const name = (label: string) => `${stamp}-${results.shots.length + 1}-${slugify(label)}`;
  for (const step of steps) {
    const kind: PointerKind = "pointer" in step && step.pointer ? step.pointer : "mouse";
    if (step.type === "wait") await sleep(step.ms);
    else if (step.type === "screenshot") {
      const label = step.label ?? `frame ${results.shots.length + 1}`;
      results.shots.push(await screenshot(context, name(label), label, step.clip, step.scale ?? 1));
    } else if (step.type === "burst") {
      const label = step.label ?? `burst ${results.shots.length + 1}`;
      results.shots.push(await burst(context, name(label), label, step));
    } else if (step.type === "move") {
      await glide(page, pointer, kind, [await resolveAnchor(page, step.to)], step.durationMs ?? 200);
    } else if (step.type === "down") {
      if (step.at) await approach(page, pointer, kind, await resolveAnchor(page, step.at));
      await press(page, pointer, kind, true);
    } else if (step.type === "up") {
      if (step.at) await glide(page, pointer, kind, [await resolveAnchor(page, step.at)], 60);
      await press(page, pointer, kind, false);
    } else if (step.type === "click") {
      const target = step.selector ? { selector: step.selector } : step.at;
      if (target) await approach(page, pointer, kind, await resolveAnchor(page, target));
      await press(page, pointer, kind, true);
      await sleep(kind === "touch" ? 40 : 0);
      await press(page, pointer, kind, false);
    } else if (step.type === "drag") {
      const route = await dragRoute(page, step);
      await approach(page, pointer, kind, route[0]);
      await press(page, pointer, kind, true);
      await glide(page, pointer, kind, route.slice(1), step.durationMs ?? 400);
      if (step.release ?? true) await press(page, pointer, kind, false);
    } else if (step.type === "wheel") {
      const at = await resolveAnchor(page, step.at);
      await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: step.deltaX ?? 0, deltaY: step.deltaY });
    } else if (step.type === "key") await pressKey(page, step.key, step.modifiers);
    else if (step.type === "eval") await record(results, step.label ?? `eval ${results.evals.length + 1}`, () => evaluate(page, step.expression));
    else if (step.type === "rects") await record(results, step.label ?? "rects", () => evaluate(page, rectsExpression(step.selectors, step.props ?? [])));
    else if (step.type === "gui") await record(results, "gui", () => evaluate(page, guiExpression(step.set)));
    else if (step.type === "perf") {
      try {
        results.perf.push({ label: step.label ?? `perf ${results.perf.length + 1}`, dpr: context.viewport.dpr, ...(await evaluate(page, perfExpression(step.ms)) as object) });
      } catch (error) {
        results.perf.push({ label: step.label, error: messageOf(error) });
      }
    } else if (step.type === "hide" || step.type === "show") await evaluate(page, visibilityExpression(step.selector, step.type === "show"));
    else if (step.type === "media") {
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: step.reducedMotion ? "reduce" : "no-preference" }] });
    } else if (step.type === "resize") {
      context.viewport.width = step.width;
      context.viewport.height = step.height;
      await page.send("Emulation.setDeviceMetricsOverride", { width: step.width, height: step.height, deviceScaleFactor: context.viewport.dpr, mobile: false });
    }
  }
  return results;
}

async function dragRoute(page: ChromePage, step: Extract<CaptureStep, { type: "drag" }>): Promise<Point[]> {
  if (step.points && step.points.length >= 2) return Promise.all(step.points.map((anchor) => resolveAnchor(page, anchor)));
  if (!step.from) throw new Error("drag needs `points` (2+) or `from` with `to` or `by`.");
  const from = await resolveAnchor(page, step.from);
  if (step.to) return [from, await resolveAnchor(page, step.to)];
  if (step.by) return [from, { x: from.x + step.by.dx, y: from.y + step.by.dy }];
  throw new Error("drag with `from` also needs `to` or `by`.");
}

async function screenshot(context: StepContext, name: string, label: string, clip: Clip | undefined, scale: number): Promise<CaptureShot> {
  const region = await clipRegion(context, clip);
  const png = await capture(context.page, { ...region, scale });
  const file = path.join(context.outDir, `${name}.png`);
  await writeFile(file, png);
  return { label, file, png, stats: imageStats(png), focus: await evaluate(context.page, focusExpression) };
}

/**
 * Captures `count` frames `everyMs` apart (real time; capture latency bounds the rate at roughly
 * 20–40 ms per frame) and packs them into one contact sheet no wider than 1600 px.
 */
async function burst(context: StepContext, name: string, label: string, step: Extract<CaptureStep, { type: "burst" }>): Promise<CaptureShot> {
  const region = await clipRegion(context, step.clip);
  const columns = Math.max(1, Math.min(step.columns ?? Math.min(step.count, 4), step.count));
  const scale = Math.min(1, sheetWidth / (columns * region.width * context.viewport.dpr));
  const frames: Buffer[] = [];
  const times: number[] = [];
  const started = Date.now();
  for (let index = 0; index < step.count; index++) {
    const due = started + index * step.everyMs;
    await sleep(Math.max(0, due - Date.now()));
    times.push(Date.now() - started);
    frames.push(await capture(context.page, { ...region, scale }));
  }
  const png = contactSheet(frames, columns);
  const file = path.join(context.outDir, `${name}.png`);
  await mkdir(context.outDir, { recursive: true });
  await writeFile(file, png);
  return {
    label: `${label} (${step.count} frames, ${columns} per row, left→right then down)`,
    file,
    png,
    stats: imageStats(png),
    focus: await evaluate(context.page, focusExpression),
    frames: frames.map((frame, index) => ({ tMs: times[index], ...imageStats(frame) })),
  };
}

async function clipRegion(context: StepContext, clip: Clip | undefined) {
  const { width, height } = context.viewport;
  if (!clip) return { x: 0, y: 0, width, height };
  if (!("selector" in clip)) return clamp(clip, width, height);
  const rect = await evaluate(context.page, rectExpression(clip.selector)) as { left: number; top: number; width: number; height: number } | null;
  if (!rect) throw new Error(`No element matches ${clip.selector}.`);
  const pad = clip.pad ?? 16;
  return clamp({ x: rect.left - pad, y: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }, width, height);
}

function clamp(region: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  const x = Math.max(0, Math.min(width - 1, region.x));
  const y = Math.max(0, Math.min(height - 1, region.y));
  return { x, y, width: Math.max(1, Math.min(width - x, region.width)), height: Math.max(1, Math.min(height - y, region.height)) };
}

async function capture(page: ChromePage, clip: { x: number; y: number; width: number; height: number; scale: number }): Promise<Buffer> {
  const { data } = await page.send("Page.captureScreenshot", { format: "png", clip }) as { data: string };
  return Buffer.from(data, "base64");
}

async function record(results: StepResults, label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    results.evals.push({ label, value: await run() });
  } catch (error) {
    results.evals.push({ label, error: messageOf(error) });
  }
}

export async function evaluate(page: ChromePage, expression: string): Promise<unknown> {
  const response = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "evaluation failed");
  return response.result?.value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "frame";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
