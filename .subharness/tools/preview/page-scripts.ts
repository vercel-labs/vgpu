// JavaScript evaluated inside the previewed page. Kept as source strings so the capture can inject
// them over CDP; each builder returns one self-contained expression.

/**
 * Installed before any page script runs. It stays dormant until `window.__capturePerf.measure(ms)`
 * is awaited, then records rAF frame deltas, the time each page rAF callback spends in JavaScript,
 * and queue completion latency observed after each GPUQueue.submit. This includes queueing and
 * promise scheduling and is neither GPU execution time nor utilization.
 */
export const perfInitScript = `(() => {
  let active = null;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => raf((time) => {
    const window = active;
    if (!window) return callback(time);
    const started = performance.now();
    try { return callback(time); } finally { window.js.push({ t: started, ms: performance.now() - started }); }
  });
  if (window.GPUQueue) {
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (buffers) {
      const result = submit.call(this, buffers);
      const window = active;
      if (window) {
        window.submits++;
        const started = performance.now();
        this.onSubmittedWorkDone().then(() => {
          if (!window.closed) window.completions.push({ t: started, ms: performance.now() - started });
        }, () => { if (!window.closed) window.failures++; });
      }
      return result;
    };
  }
  const stats = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return { avg: +avg.toFixed(2), p50: +pick(0.5).toFixed(2), p95: +pick(0.95).toFixed(2), max: +sorted[sorted.length - 1].toFixed(2) };
  };
  window.__capturePerf = {
    async measure(ms) {
      if (active) throw new Error("A preview measurement is already active");
      const window = { js: [], completions: [], submits: 0, failures: 0, closed: false };
      active = window;
      const frames = [];
      const start = performance.now();
      let last = start;
      await new Promise((resolve) => {
        const tick = (now) => {
          frames.push({ t: now - start, ms: now - last });
          last = now;
          if (now - start < ms) raf(tick); else resolve();
        };
        raf(tick);
      });
      active = null;
      await new Promise((resolve) => setTimeout(resolve, 150));
      window.closed = true;
      frames.shift();
      const deltas = frames.map((frame) => frame.ms);
      const median = stats(deltas)?.p50 ?? 16.7;
      return {
        schemaVersion: 2,
        timingScope: "Preview diagnostics: rAF callback CPU duration, frame cadence and queue completion latency; no GPU execution or utilization measurement",
        frames: frames.length,
        frameMs: stats(deltas),
        jsMsPerFrame: frames.length ? +(window.js.reduce((sum, entry) => sum + entry.ms, 0) / frames.length).toFixed(2) : null,
        jsCallbackMs: stats(window.js.map((entry) => entry.ms)),
        queueSubmitsPerFrame: frames.length ? +(window.submits / frames.length).toFixed(2) : null,
        queueCompletionMs: stats(window.completions.map((entry) => entry.ms)),
        queueCompletionSamples: window.completions.length,
        queueCompletionFailures: window.failures,
        queueCompletionPending: window.submits - window.completions.length - window.failures,
        longFrames: frames.filter((frame) => frame.ms > Math.max(25, median * 1.5)).slice(0, 20).map((frame) => ({ tMs: +frame.t.toFixed(1), ms: +frame.ms.toFixed(1) })),
      };
    },
  };
})();`;

export function perfExpression(ms: number): string {
  return `window.__capturePerf ? window.__capturePerf.measure(${ms}) : Promise.reject(new Error("perf instrumentation missing"))`;
}

export const twoFramesExpression = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))";

// Next dev renders its indicator and error dialogs in <nextjs-portal>. Report any error text, then
// hide the portal so screenshots show only the example.
export const nextOverlayExpression = `(() => {
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

export const summaryExpression = `(async () => {
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  return {
    webgpu: { available: Boolean(navigator.gpu), adapter: adapter ? { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture } : null },
    text: document.body.innerText,
    devicePixelRatio: window.devicePixelRatio,
    canvases: [...document.querySelectorAll("canvas")].map((canvas) => ({ width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight })),
  };
})()`;

/** Focus state attached to every screenshot, so keyboard flows can be verified from the report. */
export const focusExpression = `(() => {
  const element = document.activeElement;
  if (!element || element === document.body) return { activeElement: null };
  const data = [...element.attributes].filter((attribute) => attribute.name.startsWith("data-")).map((attribute) => \`[\${attribute.name}="\${attribute.value}"]\`).join("");
  const label = element.getAttribute("aria-label") ?? element.textContent?.trim().replace(/\\s+/g, " ").slice(0, 40) ?? "";
  return { activeElement: \`\${element.tagName.toLowerCase()}\${element.id ? "#" + element.id : ""}\${data} "\${label}"\`, focusVisible: element.matches(":focus-visible") };
})()`;

export function rectExpression(selector: string, at: { x: number; y: number } = { x: 0.5, y: 0.5 }): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width * ${at.x}, y: rect.top + rect.height * ${at.y}, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`;
}

export function rectsExpression(selectors: readonly string[], props: readonly string[]): string {
  return `(() => Object.fromEntries(${JSON.stringify(selectors)}.map((selector) => [selector, [...document.querySelectorAll(selector)].slice(0, 32).map((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const data = Object.fromEntries([...element.attributes].filter((attribute) => attribute.name.startsWith("data-")).map((attribute) => [attribute.name, attribute.value]));
    return { ...data, x: +rect.left.toFixed(1), y: +rect.top.toFixed(1), width: +rect.width.toFixed(1), height: +rect.height.toFixed(1), ...Object.fromEntries(${JSON.stringify(props)}.map((prop) => [prop, style.getPropertyValue(prop)])) };
  })])))()`;
}

export function visibilityExpression(selector: string, visible: boolean): string {
  return `(() => {
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
    for (const element of elements) element.style.visibility = ${visible ? '""' : '"hidden"'};
    return elements.length;
  })()`;
}

/**
 * Sets lil-gui controllers by their visible label (lil-gui 0.21 DOM: .lil-controller.lil-<type> >
 * .lil-name). Numbers and strings fire `input` + blur, options fire `change`, booleans toggle the
 * checkbox, and a `null` value clicks a function (button) controller.
 */
export function guiExpression(values: Record<string, unknown>): string {
  return `(() => {
    const results = {};
    const controllers = [...document.querySelectorAll(".lil-controller")];
    for (const [label, value] of Object.entries(${JSON.stringify(values)})) {
      const controller = controllers.find((candidate) => candidate.querySelector(".lil-name")?.textContent?.trim() === label);
      if (!controller) { results[label] = "not found; labels: " + controllers.map((candidate) => candidate.querySelector(".lil-name")?.textContent?.trim()).join(", "); continue; }
      if (controller.classList.contains("lil-function")) { controller.querySelector("button").click(); results[label] = "clicked"; continue; }
      if (controller.classList.contains("lil-boolean")) {
        const checkbox = controller.querySelector("input");
        if (checkbox.checked !== Boolean(value)) checkbox.click();
        results[label] = checkbox.checked;
        continue;
      }
      if (controller.classList.contains("lil-option")) {
        const select = controller.querySelector("select");
        const option = [...select.options].find((candidate) => candidate.textContent === String(value) || candidate.value === String(value));
        if (!option) { results[label] = "no option " + String(value); continue; }
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        results[label] = option.textContent;
        continue;
      }
      const input = controller.querySelector("input");
      input.dispatchEvent(new Event("focus"));
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur"));
      results[label] = input.value;
    }
    return results;
  })()`;
}
