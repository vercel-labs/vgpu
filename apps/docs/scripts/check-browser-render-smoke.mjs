#!/usr/bin/env node
/**
 * Production-browser WebGPU smoke for the homepage prism and Particle Orbit.
 *
 * The instrumentation is installed before application code. It observes WebGPU canvas texture
 * acquisitions and queue submissions without adding product test hooks. By default the script
 * starts `next start` for the existing production build; pass `--base-url=<url>` to inspect an
 * already-running local or preview server. `--scenario=<id>` is only a focused diagnostic selector;
 * CI intentionally runs the unfiltered three-scenario suite.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import pngjs from "pngjs";

import { launchChrome } from "../../../.subharness/tools/preview/chrome.ts";
import { imageStats } from "../../../.subharness/tools/preview/image-stats.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const READY_TIMEOUT_MS = 120_000;
const RENDER_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 250;
const SETTLE_TIME_MS = 2000;
const SCREENSHOT_REGIONS = Object.freeze({
  hero: Object.freeze({ x: 0.6, y: 0.2, width: 0.35, height: 0.6 }),
  "particle-orbit": Object.freeze({
    x: 0.1,
    y: 0.1,
    width: 0.8,
    height: 0.7,
  }),
});

/** 32 zero bytes encoded as base64. Synthetic and intentionally not a credential. */
export const SYNTHETIC_FLAGS_SECRET =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export const SCENARIOS = Object.freeze([
  Object.freeze({ id: "hero-dark", path: "/", kind: "hero", theme: "dark" }),
  Object.freeze({ id: "hero-light", path: "/", kind: "hero", theme: "light" }),
  Object.freeze({
    id: "particle-orbit",
    path: "/preview/particle-orbit",
    kind: "particle-orbit",
    theme: "dark",
  }),
]);

export function parseArgs(argv) {
  const options = {
    artifactDir: join(REPO_ROOT, "artifacts", "docs-browser-smoke"),
    baseUrl: null,
    scenario: null,
  };
  for (const arg of argv) {
    if (arg === "--") continue;
    const separator = arg.indexOf("=");
    const key = separator === -1 ? arg : arg.slice(0, separator);
    const value = separator === -1 ? "" : arg.slice(separator + 1);
    if (key === "--base-url") options.baseUrl = normalizedBaseUrl(value);
    else if (key === "--artifact-dir") {
      if (!value) throw new Error("--artifact-dir requires a path");
      options.artifactDir = resolve(value);
    } else if (key === "--scenario") {
      if (!SCENARIOS.some((candidate) => candidate.id === value)) {
        throw new Error(
          `unknown scenario '${value}'; expected ${SCENARIOS.map(
            ({ id }) => id
          ).join(", ")}`
        );
      }
      options.scenario = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function normalizedBaseUrl(value) {
  if (!value) throw new Error("--base-url requires an http(s) URL");
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("--base-url requires an http(s) URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("--base-url must not contain credentials");
  }
  return parsed.href.replace(/\/$/u, "");
}

export function browserInstrumentation(theme) {
  return String.raw`
(() => {
  const format = (value) => {
    if (value instanceof Error) return value.stack || value.message || value.name;
    if (value && typeof value === "object" && typeof value.message === "string") {
      return String(value.message);
    }
    try { return typeof value === "string" ? value : JSON.stringify(value); }
    catch { return String(value); }
  };
  const state = globalThis.__vgpuBrowserSmoke = {
    version: 1,
    webgpu: Boolean(navigator.gpu),
    adapterRequests: 0,
    deviceRequests: 0,
    submissions: 0,
    canvases: [],
    gpuErrors: [],
    deviceLosses: [],
    pageErrors: [],
    unhandledRejections: [],
    instrumentationErrors: [],
  };
  const reportInstrumentationError = (label, error) => {
    state.instrumentationErrors.push(label + ": " + format(error));
  };
  const patchMethod = (target, method, label, wrap) => {
    try {
      const original = target[method];
      if (typeof original !== "function") throw new Error(method + " is not callable");
      Object.defineProperty(target, method, {
        configurable: true,
        writable: true,
        value: wrap(original),
      });
    } catch (error) {
      reportInstrumentationError("instrument " + label, error);
    }
  };
  try { localStorage.setItem("theme", ${JSON.stringify(theme)}); }
  catch (error) { reportInstrumentationError("set theme", error); }
  addEventListener("error", (event) => {
    state.pageErrors.push(format(event.error || event.message));
  });
  addEventListener("unhandledrejection", (event) => {
    state.unhandledRejections.push(format(event.reason));
  });

  const canvasRecords = new WeakMap();
  const contextRecords = new WeakMap();
  const patchedContextPrototypes = new WeakSet();
  const recordForCanvas = (canvas) => {
    let record = canvasRecords.get(canvas);
    if (record) return record;
    const kind = canvas.closest?.("[data-prism-background]")
      ? "hero"
      : location.pathname === "/preview/particle-orbit"
        ? "particle-orbit"
        : "other";
    record = {
      id: state.canvases.length + 1,
      kind,
      contextRequests: 0,
      configures: 0,
      currentTextures: 0,
      width: canvas.width,
      height: canvas.height,
    };
    canvasRecords.set(canvas, record);
    state.canvases.push(record);
    return record;
  };
  const instrumentContext = (context, record) => {
    contextRecords.set(context, record);
    const prototype = Object.getPrototypeOf(context);
    if (patchedContextPrototypes.has(prototype)) return;
    patchedContextPrototypes.add(prototype);
    patchMethod(prototype, "configure", "GPUCanvasContext.configure", (configure) =>
      function (...args) {
          const current = contextRecords.get(this);
          if (current) current.configures += 1;
          return configure.apply(this, args);
      }
    );
    patchMethod(prototype, "getCurrentTexture", "GPUCanvasContext.getCurrentTexture", (getCurrentTexture) =>
      function (...args) {
          const current = contextRecords.get(this);
          if (current) current.currentTextures += 1;
          return getCurrentTexture.apply(this, args);
      }
    );
  };
  patchMethod(HTMLCanvasElement.prototype, "getContext", "canvas getContext", (getContext) =>
    function (type, ...args) {
        const context = getContext.call(this, type, ...args);
        if (type === "webgpu" && context) {
          const record = recordForCanvas(this);
          record.contextRequests += 1;
          record.width = this.width;
          record.height = this.height;
          instrumentContext(context, record);
        }
        return context;
    }
  );

  const patchedAdapterPrototypes = new WeakSet();
  const patchedDevicePrototypes = new WeakSet();
  const patchedQueuePrototypes = new WeakSet();
  const observedDevices = new WeakSet();
  const instrumentQueue = (queue) => {
    const prototype = Object.getPrototypeOf(queue);
    if (patchedQueuePrototypes.has(prototype)) return;
    patchedQueuePrototypes.add(prototype);
    patchMethod(prototype, "submit", "GPUQueue.submit", (submit) =>
      function (...args) {
          state.submissions += 1;
          return submit.apply(this, args);
      }
    );
  };
  const instrumentDevice = (device) => {
    if (!device || observedDevices.has(device)) return;
    observedDevices.add(device);
    instrumentQueue(device.queue);
    device.addEventListener("uncapturederror", (event) => {
      state.gpuErrors.push("uncaptured: " + format(event.error));
    });
    device.lost.then((info) => {
      if (info.reason !== "destroyed") {
        state.deviceLosses.push(format(info.reason) + ": " + format(info.message));
      }
    });
    const prototype = Object.getPrototypeOf(device);
    if (patchedDevicePrototypes.has(prototype)) return;
    patchedDevicePrototypes.add(prototype);
    patchMethod(prototype, "popErrorScope", "GPUDevice.popErrorScope", (popErrorScope) =>
      function (...args) {
          return popErrorScope.apply(this, args).then((error) => {
            if (error) state.gpuErrors.push("captured: " + format(error));
            return error;
          });
      }
    );
  };
  const instrumentAdapter = (adapter) => {
    if (!adapter) return;
    const prototype = Object.getPrototypeOf(adapter);
    if (patchedAdapterPrototypes.has(prototype)) return;
    patchedAdapterPrototypes.add(prototype);
    patchMethod(prototype, "requestDevice", "GPUAdapter.requestDevice", (requestDevice) =>
      async function (...args) {
          state.deviceRequests += 1;
          const device = await requestDevice.apply(this, args);
          instrumentDevice(device);
          return device;
      }
    );
  };
  if (navigator.gpu) {
    const prototype = Object.getPrototypeOf(navigator.gpu);
    patchMethod(prototype, "requestAdapter", "GPU.requestAdapter", (requestAdapter) =>
      async function (...args) {
          state.adapterRequests += 1;
          const adapter = await requestAdapter.apply(this, args);
          instrumentAdapter(adapter);
          return adapter;
      }
    );
  }
})();`;
}

export function isRenderingConsoleError(message) {
  return /(?:VGPU-|WebGPU|GPU(?:Validation|Internal|OutOfMemory)Error|Prism background failed|Preview error|failed to render|shader source)/iu.test(
    message
  );
}

export function scenarioFailures(scenario, observation) {
  const failures = [];
  if (!observation) return ["page produced no observation"];
  let finalPath = "";
  try {
    finalPath = new URL(observation.url).pathname;
  } catch {
    failures.push(`invalid final URL: ${observation.url}`);
  }
  if (finalPath && finalPath !== scenario.path) {
    failures.push(`final path ${finalPath} does not match ${scenario.path}`);
  }
  if (scenario.kind === "hero" && observation.theme !== scenario.theme) {
    failures.push(
      `document theme ${observation.theme || "unknown"} does not match ${
        scenario.theme
      }`
    );
  }
  const smoke = observation.smoke;
  if (!smoke)
    return [...failures, "pre-navigation instrumentation did not run"];
  if (!smoke.webgpu) failures.push("WebGPU is unavailable");
  for (const error of smoke.instrumentationErrors ?? [])
    failures.push(`instrumentation: ${error}`);
  for (const error of smoke.pageErrors ?? [])
    failures.push(`page error: ${error}`);
  for (const error of smoke.unhandledRejections ?? [])
    failures.push(`unhandled rejection: ${error}`);
  for (const error of smoke.gpuErrors ?? [])
    failures.push(`GPU validation: ${error}`);
  for (const error of smoke.deviceLosses ?? [])
    failures.push(`GPU device lost: ${error}`);
  for (const error of observation.pageExceptions ?? [])
    failures.push(`CDP exception: ${error}`);
  for (const error of [
    ...(observation.consoleErrors ?? []),
    ...(observation.logErrors ?? []),
  ]) {
    if (isRenderingConsoleError(error))
      failures.push(`render console error: ${error}`);
  }
  if (observation.previewError)
    failures.push(`preview error UI: ${observation.previewError}`);
  if ((smoke.adapterRequests ?? 0) < 1)
    failures.push("no GPU adapter request observed");
  if ((smoke.deviceRequests ?? 0) < 1)
    failures.push("no GPU device request observed");
  if ((smoke.submissions ?? 0) < 2)
    failures.push(
      `only ${smoke.submissions ?? 0} GPU queue submissions observed`
    );
  const canvases = (smoke.canvases ?? []).filter(
    ({ kind }) => kind === scenario.kind
  );
  if (canvases.length === 0) {
    failures.push(`no instrumented ${scenario.kind} WebGPU canvas observed`);
  } else {
    const canvas = canvases[0];
    if ((canvas.configures ?? 0) < 1)
      failures.push(`${scenario.kind} canvas was not configured`);
    if ((canvas.currentTextures ?? 0) < 2) {
      failures.push(
        `${scenario.kind} canvas recorded only ${
          canvas.currentTextures ?? 0
        } texture acquisitions`
      );
    }
    if ((canvas.width ?? 0) < 1 || (canvas.height ?? 0) < 1) {
      failures.push(`${scenario.kind} canvas has an empty drawing buffer`);
    }
  }
  return failures;
}

function immediateFailures(scenario, observation) {
  const failures = scenarioFailures(scenario, observation);
  return failures.filter(
    (failure) =>
      !failure.startsWith("no GPU adapter request") &&
      !failure.startsWith("no GPU device request") &&
      !failure.startsWith("no instrumented") &&
      !failure.startsWith("only ") &&
      !failure.includes("was not configured") &&
      !failure.includes("recorded only") &&
      !failure.includes("empty drawing buffer") &&
      !(
        observation?.readyState !== "complete" &&
        failure.startsWith("final path")
      ) &&
      !(
        observation?.readyState !== "complete" &&
        failure.startsWith("document theme")
      )
  );
}

function remoteObjectText(value) {
  if (!value || typeof value !== "object") return String(value);
  if (typeof value.value === "string") return value.value;
  if (value.value !== undefined) {
    try {
      return JSON.stringify(value.value);
    } catch {
      // use the remote description below
    }
  }
  return (
    value.description ?? value.unserializableValue ?? value.type ?? "unknown"
  );
}

function consoleText(params) {
  return (params.args ?? []).map(remoteObjectText).join(" ");
}

function exceptionText(params) {
  const details = params.exceptionDetails ?? {};
  return (
    details.exception?.description ??
    details.exception?.value ??
    details.text ??
    "unknown exception"
  );
}

async function evaluate(page, expression) {
  const response = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(exceptionText(response));
  return response.result?.value;
}

async function collectObservation(page, events) {
  const pageState = await evaluate(
    page,
    `(() => {
      const html = document.documentElement;
      const theme = html.classList.contains("light")
        ? "light"
        : html.classList.contains("dark")
          ? "dark"
          : getComputedStyle(html).colorScheme;
      const bodyText = document.body?.innerText ?? "";
      return {
        url: location.href,
        readyState: document.readyState,
        theme,
        previewError: bodyText.includes("Preview error") ? bodyText.slice(0, 2000) : null,
        smoke: globalThis.__vgpuBrowserSmoke ?? null,
      };
    })()`
  );
  return {
    ...pageState,
    consoleErrors: [...events.consoleErrors],
    logErrors: [...events.logErrors],
    pageExceptions: [...events.pageExceptions],
  };
}

async function waitForCommittedDocument(page, targetUrl) {
  const expectedOrigin = new URL(targetUrl).origin;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const href = await evaluate(page, "location.href");
      if (new URL(href).origin === expectedOrigin) return;
    } catch (error) {
      if (
        !/Cannot find context|context.*destroyed|Execution context was destroyed/iu.test(
          String(error)
        )
      ) {
        throw error;
      }
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `top-level navigation did not commit at ${expectedOrigin} within 30000 ms`
  );
}

async function waitForRendering(page, scenario, events) {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let observation;
  while (Date.now() < deadline) {
    try {
      observation = await collectObservation(page, events);
      const immediate = immediateFailures(scenario, observation);
      if (immediate.length > 0) throw new Error(immediate.join("\n"));
      if (observation.readyState === "complete") {
        const failures = scenarioFailures(scenario, observation);
        if (failures.length === 0) return observation;
      }
    } catch (error) {
      if (
        /Cannot find context|context.*destroyed|Execution context was destroyed/iu.test(
          String(error)
        )
      ) {
        await delay(POLL_INTERVAL_MS);
        continue;
      }
      throw error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  const failures = scenarioFailures(scenario, observation);
  throw new Error(
    `rendering did not satisfy the smoke within ${RENDER_TIMEOUT_MS} ms${
      failures.length ? `:\n${failures.join("\n")}` : ""
    }`
  );
}

function continuedActivityFailures(
  scenario,
  initialObservation,
  settledObservation
) {
  const initialSmoke = initialObservation?.smoke;
  const settledSmoke = settledObservation?.smoke;
  if (!initialSmoke || !settledSmoke) return [];
  const failures = [];
  if ((settledSmoke.submissions ?? 0) <= (initialSmoke.submissions ?? 0)) {
    failures.push(
      `GPU queue submissions did not increase during the ${SETTLE_TIME_MS} ms settle ` +
        `(${initialSmoke.submissions ?? 0} -> ${settledSmoke.submissions ?? 0})`
    );
  }
  const initialCanvas = (initialSmoke.canvases ?? []).find(
    ({ kind }) => kind === scenario.kind
  );
  const settledCanvas = initialCanvas
    ? (settledSmoke.canvases ?? []).find(
        ({ id, kind }) => id === initialCanvas.id && kind === scenario.kind
      )
    : undefined;
  if (initialCanvas && !settledCanvas) {
    failures.push(
      `${scenario.kind} canvas could not be matched across the settle window`
    );
  } else if (
    initialCanvas &&
    (settledCanvas.currentTextures ?? 0) <= (initialCanvas.currentTextures ?? 0)
  ) {
    failures.push(
      `${scenario.kind} canvas texture acquisitions did not increase during the ` +
        `${SETTLE_TIME_MS} ms settle (${
          initialCanvas.currentTextures ?? 0
        } -> ` +
        `${settledCanvas.currentTextures ?? 0})`
    );
  }
  return failures;
}

async function captureScreenshot(page, path, scenario) {
  const screenshot = await page.send("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true,
  });
  const png = Buffer.from(screenshot.data, "base64");
  await writeFile(path, png);
  const source = pngjs.PNG.sync.read(png);
  const normalized = SCREENSHOT_REGIONS[scenario.kind];
  const x = Math.floor(source.width * normalized.x);
  const y = Math.floor(source.height * normalized.y);
  const right = Math.ceil(source.width * (normalized.x + normalized.width));
  const bottom = Math.ceil(source.height * (normalized.y + normalized.height));
  const pixels = { x, y, width: right - x, height: bottom - y };
  const cropped = new pngjs.PNG({
    width: pixels.width,
    height: pixels.height,
  });
  pngjs.PNG.bitblt(
    source,
    cropped,
    pixels.x,
    pixels.y,
    pixels.width,
    pixels.height,
    0,
    0
  );
  return {
    ...imageStats(pngjs.PNG.sync.write(cropped)),
    sampledRegion: { normalized, pixels },
  };
}

export async function runScenario(
  baseUrl,
  artifactDir,
  scenario,
  { launch = launchChrome, settle = () => delay(SETTLE_TIME_MS) } = {}
) {
  const screenshotPath = join(artifactDir, `${scenario.id}.png`);
  const events = { consoleErrors: [], logErrors: [], pageExceptions: [] };
  let observation;
  let activityFailures = [];
  let screenshotStats;
  let page;
  let thrown;
  try {
    page = await launch({ width: 1280, height: 720 });
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    page.onEvent(({ method, params }) => {
      if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        events.consoleErrors.push(consoleText(params));
      } else if (method === "Runtime.exceptionThrown") {
        events.pageExceptions.push(exceptionText(params));
      } else if (
        method === "Log.entryAdded" &&
        params.entry?.level === "error"
      ) {
        events.logErrors.push(params.entry.text ?? "unknown log error");
      }
    });
    await page.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: scenario.theme }],
    });
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: browserInstrumentation(scenario.theme),
    });
    const targetUrl = `${baseUrl}${scenario.path}`;
    await page.send("Page.navigate", { url: targetUrl });
    await waitForCommittedDocument(page, targetUrl);
    const initialObservation = await waitForRendering(page, scenario, events);
    // The light hero intentionally stops presenting when its scene is unchanged.
    // Exercise its real pointer path so continued rendering is required even at rest.
    if (scenario.kind === "hero") {
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: 960, y: 260, buttons: 0,
      });
    }
    // Let the interaction and startup transitions render; catch later-frame errors.
    await settle();
    observation = await collectObservation(page, events);
    activityFailures = continuedActivityFailures(
      scenario,
      initialObservation,
      observation
    );
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
    if (page) {
      try {
        observation = await collectObservation(page, events);
      } catch {
        // Preserve the original browser/navigation failure.
      }
    }
  } finally {
    if (page) {
      try {
        screenshotStats = await captureScreenshot(
          page,
          screenshotPath,
          scenario
        );
      } catch (error) {
        thrown ??= `screenshot failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      try {
        observation = await collectObservation(page, events);
      } catch (error) {
        thrown ??= `final observation failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      try {
        await page.close();
      } catch (error) {
        thrown ??= `browser close failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
  }
  const failures = [
    ...scenarioFailures(scenario, observation),
    ...activityFailures,
  ];
  if (screenshotStats?.uniform) {
    failures.push(
      `captured a uniform screenshot region ` +
        `(mean luma ${screenshotStats.meanLuma}, ` +
        `luma standard deviation ${screenshotStats.lumaStdDev})`
    );
  }
  if (thrown && !failures.includes(thrown)) failures.unshift(thrown);
  return {
    id: scenario.id,
    ok: failures.length === 0,
    failures,
    screenshot: screenshotPath,
    screenshotStats,
    observation,
  };
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not allocate a local port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

export async function waitForServer(
  baseUrl,
  child,
  {
    fetchImpl = fetch,
    pollIntervalMs = POLL_INTERVAL_MS,
    timeoutMs = READY_TIMEOUT_MS,
  } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `next start exited with code ${child.exitCode ?? "null"} / signal ${
          child.signalCode ?? "null"
        } before becoming ready`
      );
    }
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await fetchImpl(`${baseUrl}/preview/particle-orbit`, {
        redirect: "manual",
        signal: AbortSignal.timeout(remainingMs),
      });
      if (response.status > 0) return;
    } catch {
      // not listening yet
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await delay(Math.min(pollIntervalMs, remainingMs));
  }
  throw new Error(
    `server at ${baseUrl} did not become ready within ${timeoutMs} ms`
  );
}

async function startServer() {
  const bin = join(APP_ROOT, "node_modules", ".bin", "next");
  if (!existsSync(bin))
    throw new Error(`cannot find Next at ${bin}; run pnpm install`);
  if (!existsSync(join(APP_ROOT, ".next"))) {
    throw new Error(
      "no production build found; run `pnpm --filter docs build` first"
    );
  }
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(bin, ["start", "--port", String(port)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      FLAGS_SECRET: process.env.FLAGS_SECRET ?? SYNTHETIC_FLAGS_SECRET,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  try {
    await waitForServer(baseUrl, child);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${output
        .join("")
        .slice(-4000)}`
    );
  }
  return {
    baseUrl,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        delay(5000),
      ]);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    },
  };
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = options.scenario
    ? SCENARIOS.filter(({ id }) => id === options.scenario)
    : SCENARIOS;
  await mkdir(options.artifactDir, { recursive: true });
  let server;
  const baseUrl = options.baseUrl ?? (server = await startServer()).baseUrl;
  const results = [];
  try {
    for (const scenario of scenarios) {
      const result = await runScenario(baseUrl, options.artifactDir, scenario);
      results.push(result);
      const canvas = result.observation?.smoke?.canvases?.find(
        ({ kind }) => kind === scenario.kind
      );
      if (result.ok) {
        console.log(
          `  ok    ${scenario.id}: ${canvas.currentTextures} texture acquisitions, ` +
            `${result.observation.smoke.submissions} queue submissions`
        );
      } else {
        console.error(`  FAIL  ${scenario.id}`);
        for (const failure of result.failures)
          console.error(`          ${failure}`);
      }
      console.log(`        screenshot: ${result.screenshot}`);
    }
  } finally {
    await server?.stop();
  }
  const reportPath = join(options.artifactDir, "report.json");
  await writeFile(
    reportPath,
    `${JSON.stringify({ baseUrl, results }, null, 2)}\n`,
    "utf8"
  );
  console.log(`        report: ${reportPath}`);
  if (results.some(({ ok }) => !ok)) process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.stack ?? error.message : error
    );
    process.exitCode = 1;
  });
}
