// Opens a docs preview in headless WebGPU Chrome, replays a scripted interaction, and captures frames.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { launchChrome, type CdpEvent, type ChromePage } from "./chrome.ts";
import { ensureDocsServer } from "./docs-server.ts";
import { nextOverlayExpression, perfInitScript, summaryExpression, twoFramesExpression } from "./page-scripts.ts";
import { evaluate, runSteps, sleep, type CaptureStep, type StepResults } from "./steps.ts";

export type { CaptureShot, CaptureStep } from "./steps.ts";

export interface CaptureOptions {
  readonly root: string;
  readonly slug: string;
  readonly path?: string;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly touch: boolean;
  readonly settleMs: number;
  readonly waitFor: string;
  readonly reducedMotion: boolean;
  readonly steps: readonly CaptureStep[];
}

export interface CaptureResult extends StepResults {
  readonly url: string;
  readonly server: { readonly url: string; readonly started: boolean };
  readonly webgpu: unknown;
  readonly devicePixelRatio: number;
  readonly ready: { readonly selector: string; readonly found: boolean; readonly ms: number };
  readonly previewError: string | null;
  readonly nextOverlay: string | null;
  readonly pageText: string;
  readonly canvases: unknown;
  readonly problems: readonly string[];
  readonly logs: readonly string[];
  readonly durationMs: number;
}

const noise = /Download the React DevTools|\[HMR\]|\[Fast Refresh\]/;

/**
 * Captures `/preview/<slug>` (or `path`) from the checkout's docs dev server, starting it when
 * needed. Steps run in order after the page is ready; pointer steps use CSS pixels of the viewport
 * (or element anchors) and interpolate moves in real time so gesture velocity is realistic. A final
 * screenshot is added when the steps contain no screenshot or burst. PNGs land under
 * `.context/shots/<slug>/`.
 *
 * @example
 *   const result = await capturePreview({
 *     root, slug: "fluid", width: 1280, height: 720, dpr: 2, touch: false, settleMs: 2000,
 *     waitFor: "canvas", reducedMotion: false,
 *     steps: [{ type: "drag", from: { x: 300, y: 360 }, by: { dx: 600, dy: 0 }, durationMs: 250 }, { type: "perf", ms: 2000 }],
 *   });
 */
export async function capturePreview(options: CaptureOptions): Promise<CaptureResult> {
  const started = Date.now();
  const server = await ensureDocsServer(options.root);
  const url = `${server.url}${options.path ?? `/preview/${options.slug}`}`;
  const outDir = path.join(options.root, ".context", "shots", options.slug);
  await mkdir(outDir, { recursive: true });
  const page = await launchChrome(options);
  const journal = createJournal(page);
  try {
    await openPage(page, options, url);
    const ready = await waitForSelector(page, options.waitFor);
    await evaluate(page, twoFramesExpression);
    await sleep(options.settleMs);
    const nextOverlay = await evaluate(page, nextOverlayExpression) as string | null;
    const hasImage = options.steps.some((step) => step.type === "screenshot" || step.type === "burst");
    const steps = hasImage ? options.steps : [...options.steps, { type: "screenshot" as const }];
    const viewport = { width: options.width, height: options.height, dpr: options.dpr, touch: options.touch };
    const run = await runSteps({ page, outDir, viewport }, steps);
    const summary = await evaluate(page, summaryExpression) as { webgpu: unknown; text: string; canvases: unknown; devicePixelRatio: number };
    const previewError = summary.text.includes("Preview error") ? summary.text.slice(0, 1500) : null;
    return {
      url,
      server: { url: server.url, started: server.started },
      webgpu: summary.webgpu,
      devicePixelRatio: summary.devicePixelRatio,
      ready,
      ...run,
      previewError,
      nextOverlay,
      pageText: summary.text.slice(0, 600),
      canvases: summary.canvases,
      problems: journal.problems,
      logs: journal.logs,
      durationMs: Date.now() - started,
    };
  } finally {
    await page.close();
  }
}

async function openPage(page: ChromePage, options: CaptureOptions, url: string): Promise<void> {
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: perfInitScript });
  await page.send("Emulation.setDeviceMetricsOverride", { width: options.width, height: options.height, deviceScaleFactor: options.dpr, mobile: false });
  if (options.touch) await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  if (options.reducedMotion) await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const loaded = new Promise<void>((resolve) => page.onEvent((event) => {
    if (event.method === "Page.loadEventFired") resolve();
  }));
  await page.send("Page.navigate", { url });
  // The first request to a route compiles it in Next dev; allow for that.
  await withTimeout(loaded, 180_000, `Timed out loading ${url}.`);
}

async function waitForSelector(page: ChromePage, selector: string) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (await evaluate(page, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return { selector, found: true, ms: Date.now() - started };
    await sleep(200);
  }
  return { selector, found: false, ms: Date.now() - started };
}

function createJournal(page: ChromePage) {
  const problems: string[] = [];
  const logs: string[] = [];
  const record = (level: string, text: string) => {
    if (noise.test(text)) return;
    const line = `[${level}] ${text}`.slice(0, 800);
    if (level === "error" || level === "warning" || level === "exception") {
      if (problems.length < 60) problems.push(line);
    } else if (logs.length < 40) logs.push(line);
  };
  page.onEvent((event: CdpEvent) => {
    const params = event.params as Record<string, any>;
    if (event.method === "Runtime.consoleAPICalled") {
      record(params.type, (params.args ?? []).map((arg: any) => arg.value ?? arg.description ?? arg.type).join(" "));
    } else if (event.method === "Runtime.exceptionThrown") {
      record("exception", params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "exception");
    } else if (event.method === "Log.entryAdded") {
      record(params.entry?.level ?? "log", `${params.entry?.text ?? ""}${params.entry?.url ? ` (${params.entry.url})` : ""}`);
    }
  });
  return { problems, logs };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
