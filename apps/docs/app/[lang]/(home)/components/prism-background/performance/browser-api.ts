import type { PrismRenderer } from "../renderer";
import type {
  PrismPerformanceBrowserApi,
  PrismPerformanceReport,
  PrismPerformanceRunOptions,
} from "./types";

export const PRISM_PERFORMANCE_BRIDGE_ID = "prism-performance-api";
export const PRISM_PERFORMANCE_RUN_EVENT = "prism-performance-run";
const FRAME_QUERY = "prism-perf-frames";
const WARMUP_QUERY = "prism-perf-warmup";

/** Installs the automation hook only for a page explicitly loaded with `?prism-perf`. */
export function installPrismPerformanceBrowserApi(
  renderer: PrismRenderer
): () => void {
  let latest: PrismPerformanceReport | undefined;
  let disposed = false;
  let running = false;
  const api: PrismPerformanceBrowserApi = {
    ready: renderer.ready,
    get latest() {
      return latest;
    },
    async run(options) {
      latest = await renderer.measurePerformance(options);
      return latest;
    },
  };
  window.__prismPerformance = api;
  const autostart = parsePrismPerformanceUrl(window.location.search);

  const bridge = document.createElement("div");
  bridge.id = PRISM_PERFORMANCE_BRIDGE_ID;
  bridge.hidden = true;
  bridge.dataset.state = "loading";
  document.body.append(bridge);

  const runFromDom = () => {
    if (disposed || running) return;
    running = true;
    bridge.dataset.state = "running";
    delete bridge.dataset.error;
    bridge.textContent = "";
    void parseOptions(bridge.dataset.options)
      .then((options) => api.run(options))
      .then(
        (report) => {
          if (disposed) return;
          bridge.textContent = JSON.stringify(report);
          bridge.dataset.state = "complete";
        },
        (error) => {
          if (disposed) return;
          const message = errorMessage(error);
          bridge.dataset.error = message;
          bridge.textContent = JSON.stringify({ error: message });
          bridge.dataset.state = "error";
        }
      )
      .finally(() => {
        running = false;
      });
  };
  bridge.addEventListener(PRISM_PERFORMANCE_RUN_EVENT, runFromDom);
  void api.ready.then(
    () => {
      if (disposed || running) return;
      bridge.dataset.state = "ready";
      if (autostart) {
        bridge.dataset.options = JSON.stringify(autostart);
        runFromDom();
      }
    },
    (error) => {
      if (disposed) return;
      const message = errorMessage(error);
      bridge.dataset.error = message;
      bridge.dataset.state = "error";
    }
  );

  return () => {
    disposed = true;
    bridge.removeEventListener(PRISM_PERFORMANCE_RUN_EVENT, runFromDom);
    bridge.remove();
    if (window.__prismPerformance === api) delete window.__prismPerformance;
  };
}

export function parsePrismPerformanceUrl(
  search: string
): PrismPerformanceRunOptions | undefined {
  const params = new URLSearchParams(search);
  const workload = params.get("prism-perf");
  if (workload !== "light" && workload !== "dark" && workload !== "dark-dust")
    return undefined;
  const mode = workload === "dark-dust" ? "dark" : workload;
  const frames = positiveInteger(params.get(FRAME_QUERY));
  const warmupFrames = nonNegativeInteger(params.get(WARMUP_QUERY));
  return {
    mode,
    ...(workload === "dark-dust" ? { scenario: "dark-dust" as const } : {}),
    ...(frames === undefined ? {} : { frames }),
    ...(warmupFrames === undefined ? {} : { warmupFrames }),
  };
}

async function parseOptions(
  serialized: string | undefined
): Promise<PrismPerformanceRunOptions | undefined> {
  if (!serialized) return undefined;
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prism performance options must be a JSON object.");
  }
  return value as PrismPerformanceRunOptions;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: string | null): number | undefined {
  const parsed = nonNegativeInteger(value);
  return parsed && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
