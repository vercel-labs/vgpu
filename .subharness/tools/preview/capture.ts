// Opens a docs preview in headless WebGPU Chrome, replays a scripted interaction, and captures frames.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchChrome, type CdpEvent, type ChromePage } from "./chrome.ts";
import { ensureDocsServer } from "./docs-server.ts";
import { imageStats, type ImageStats } from "./image-stats.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type CaptureStep =
  | { readonly type: "wait"; readonly ms: number }
  | { readonly type: "screenshot"; readonly label?: string }
  | { readonly type: "move"; readonly to: Point; readonly durationMs?: number }
  | { readonly type: "down"; readonly at?: Point }
  | { readonly type: "up"; readonly at?: Point }
  | { readonly type: "click"; readonly at?: Point; readonly selector?: string }
  | { readonly type: "drag"; readonly points: readonly Point[]; readonly durationMs?: number; readonly release?: boolean }
  | { readonly type: "wheel"; readonly at: Point; readonly deltaY: number; readonly deltaX?: number }
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "eval"; readonly expression: string; readonly label?: string }
  | { readonly type: "fps"; readonly ms: number };

export interface CaptureOptions {
  readonly root: string;
  readonly slug: string;
  readonly path?: string;
  readonly width: number;
  readonly height: number;
  readonly settleMs: number;
  readonly waitFor: string;
  readonly reducedMotion: boolean;
  readonly steps: readonly CaptureStep[];
}

export interface CaptureShot {
  readonly label: string;
  readonly file: string;
  readonly png: Buffer;
  readonly stats: ImageStats;
}

export interface CaptureResult {
  readonly url: string;
  readonly server: { readonly url: string; readonly started: boolean };
  readonly webgpu: unknown;
  readonly ready: { readonly selector: string; readonly found: boolean; readonly ms: number };
  readonly shots: readonly CaptureShot[];
  readonly evals: readonly { readonly label: string; readonly value?: unknown; readonly error?: string }[];
  readonly fps: readonly unknown[];
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
 * and interpolate moves in real time so gesture velocity (drag inertia, flicks) is realistic.
 * A final screenshot is added when the steps contain none. PNGs are written under
 * `.context/shots/<slug>/`.
 *
 * @example
 *   const result = await capturePreview({
 *     root, slug: "fluid", width: 1280, height: 720, settleMs: 2000, waitFor: "canvas",
 *     reducedMotion: false,
 *     steps: [{ type: "drag", points: [{ x: 300, y: 360 }, { x: 900, y: 360 }], durationMs: 250 }, { type: "screenshot" }],
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
    await evaluate(page, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await sleep(options.settleMs);
    const nextOverlay = await evaluate(page, nextOverlayExpression) as string | null;
    const steps = options.steps.some((step) => step.type === "screenshot") ? options.steps : [...options.steps, { type: "screenshot" as const }];
    const run = await runSteps(page, steps, outDir);
    const summary = await evaluate(page, summaryExpression) as { webgpu: unknown; text: string; canvases: unknown };
    const previewError = summary.text.includes("Preview error") ? summary.text.slice(0, 1500) : null;
    return {
      url,
      server: { url: server.url, started: server.started },
      webgpu: summary.webgpu,
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
  await page.send("Emulation.setDeviceMetricsOverride", { width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false });
  if (options.reducedMotion) await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const loaded = new Promise<void>((resolve) => page.onEvent((event) => {
    if (event.method === "Page.loadEventFired") resolve();
  }));
  await page.send("Page.navigate", { url });
  // The first request to a route compiles it in Next dev; allow for that.
  await withTimeout(loaded, 180_000, `Timed out loading ${url}.`);
}

async function runSteps(page: ChromePage, steps: readonly CaptureStep[], outDir: string) {
  const shots: CaptureShot[] = [];
  const evals: { label: string; value?: unknown; error?: string }[] = [];
  const fps: unknown[] = [];
  const pointer = { x: 0, y: 0, pressed: false };
  const stamp = Date.now();
  for (const step of steps) {
    if (step.type === "wait") await sleep(step.ms);
    else if (step.type === "screenshot") shots.push(await screenshot(page, outDir, `${stamp}-${shots.length + 1}-${slugify(step.label ?? "frame")}`, step.label ?? `frame ${shots.length + 1}`));
    else if (step.type === "move") await glide(page, pointer, [step.to], step.durationMs ?? 200);
    else if (step.type === "down") await press(page, pointer, step.at, true);
    else if (step.type === "up") await press(page, pointer, step.at, false);
    else if (step.type === "click") {
      const at = step.selector ? await centerOf(page, step.selector) : step.at;
      await glide(page, pointer, at ? [at] : [], 60);
      await press(page, pointer, undefined, true);
      await press(page, pointer, undefined, false);
    } else if (step.type === "drag") {
      const [first, ...rest] = step.points;
      await glide(page, pointer, [first], 60);
      await press(page, pointer, undefined, true);
      await glide(page, pointer, rest, step.durationMs ?? 400);
      if (step.release ?? true) await press(page, pointer, undefined, false);
    } else if (step.type === "wheel") {
      await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: step.at.x, y: step.at.y, deltaX: step.deltaX ?? 0, deltaY: step.deltaY });
    } else if (step.type === "key") {
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: step.key });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: step.key });
    } else if (step.type === "eval") {
      const label = step.label ?? `eval ${evals.length + 1}`;
      try {
        evals.push({ label, value: await evaluate(page, step.expression) });
      } catch (error) {
        evals.push({ label, error: error instanceof Error ? error.message : String(error) });
      }
    } else if (step.type === "fps") fps.push(await evaluate(page, fpsExpression(step.ms)));
  }
  return { shots, evals, fps };
}

async function screenshot(page: ChromePage, outDir: string, name: string, label: string): Promise<CaptureShot> {
  const { data } = await page.send("Page.captureScreenshot", { format: "png" }) as { data: string };
  const png = Buffer.from(data, "base64");
  const file = path.join(outDir, `${name}.png`);
  await writeFile(file, png);
  return { label, file, png, stats: imageStats(png) };
}

async function glide(page: ChromePage, pointer: { x: number; y: number; pressed: boolean }, points: readonly Point[], durationMs: number): Promise<void> {
  if (points.length === 0) return;
  const frames = Math.max(points.length, Math.round(durationMs / 16));
  const route = [{ x: pointer.x, y: pointer.y }, ...points];
  for (let frame = 1; frame <= frames; frame++) {
    const along = (frame / frames) * (route.length - 1);
    const segment = Math.min(route.length - 2, Math.floor(along));
    const t = along - segment;
    const x = route[segment].x + (route[segment + 1].x - route[segment].x) * t;
    const y = route[segment].y + (route[segment + 1].y - route[segment].y) * t;
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: pointer.pressed ? "left" : "none", buttons: pointer.pressed ? 1 : 0 });
    pointer.x = x;
    pointer.y = y;
    await sleep(durationMs / frames);
  }
}

async function press(page: ChromePage, pointer: { x: number; y: number; pressed: boolean }, at: Point | undefined, down: boolean): Promise<void> {
  if (at) await glide(page, pointer, [at], 60);
  pointer.pressed = down;
  await page.send("Input.dispatchMouseEvent", {
    type: down ? "mousePressed" : "mouseReleased",
    x: pointer.x,
    y: pointer.y,
    button: "left",
    buttons: down ? 1 : 0,
    clickCount: 1,
  });
}

async function centerOf(page: ChromePage, selector: string): Promise<Point> {
  const center = await evaluate(page, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`) as Point | null;
  if (!center) throw new Error(`No element matches ${selector}.`);
  return center;
}

async function waitForSelector(page: ChromePage, selector: string) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (await evaluate(page, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return { selector, found: true, ms: Date.now() - started };
    await sleep(200);
  }
  return { selector, found: false, ms: Date.now() - started };
}

async function evaluate(page: ChromePage, expression: string): Promise<unknown> {
  const response = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "evaluation failed");
  return response.result?.value;
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

// Next dev renders its indicator and error dialogs in <nextjs-portal>. Report any error text, then
// hide the portal so screenshots show only the example.
const nextOverlayExpression = `(() => {
  const portals = [...document.querySelectorAll("nextjs-portal")];
  const textOf = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const tag = node.parentElement?.tagName;
      if (tag !== "STYLE" && tag !== "SCRIPT") text += " " + node.textContent;
    }
    return text;
  };
  const text = portals.map((portal) => textOf(portal.shadowRoot ?? portal)).join(" ").replace(/\\s+/g, " ").trim();
  for (const portal of portals) portal.style.display = "none";
  return /error|issue|failed/i.test(text) ? text.slice(0, 1500) : null;
})()`;

const summaryExpression = `(async () => {
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  return {
    webgpu: { available: Boolean(navigator.gpu), adapter: adapter ? { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture } : null },
    text: document.body.innerText,
    canvases: [...document.querySelectorAll("canvas")].map((canvas) => ({ width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight })),
  };
})()`;

function fpsExpression(ms: number): string {
  return `new Promise((resolve) => {
    const deltas = [];
    let last = performance.now();
    const end = last + ${ms};
    const tick = (now) => {
      deltas.push(now - last);
      last = now;
      if (now < end) return requestAnimationFrame(tick);
      deltas.shift();
      const sorted = [...deltas].sort((a, b) => a - b);
      const avg = deltas.reduce((sum, value) => sum + value, 0) / Math.max(1, deltas.length);
      resolve({ frames: deltas.length, avgMs: +avg.toFixed(2), p95Ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2), maxMs: +(sorted.at(-1) ?? 0).toFixed(2) });
    };
    requestAnimationFrame(tick);
  })`;
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "frame";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
