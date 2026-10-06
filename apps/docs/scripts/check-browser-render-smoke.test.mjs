import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pngjs from "pngjs";

import * as browserSmoke from "./check-browser-render-smoke.mjs";

import {
  SCENARIOS,
  SYNTHETIC_FLAGS_SECRET,
  browserInstrumentation,
  isRenderingConsoleError,
  parseArgs,
  scenarioFailures,
} from "./check-browser-render-smoke.mjs";

function healthyObservation(scenario = SCENARIOS[0]) {
  return {
    url: `https://example.test${scenario.path}`,
    readyState: "complete",
    theme: scenario.theme,
    previewError: null,
    consoleErrors: [],
    logErrors: [],
    pageExceptions: [],
    smoke: {
      webgpu: true,
      adapterRequests: 1,
      deviceRequests: 1,
      submissions: 3,
      canvases: [
        {
          id: 1,
          kind: scenario.kind,
          configures: 1,
          currentTextures: 3,
          width: 1280,
          height: 720,
        },
      ],
      gpuErrors: [],
      deviceLosses: [],
      pageErrors: [],
      unhandledRejections: [],
      instrumentationErrors: [],
    },
  };
}

function screenshotPng(kind = "patterned") {
  const png = new pngjs.PNG({ width: 100, height: 100 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const outsideHeroScene = x >= 5 && x < 45 && y >= 30 && y < 70;
      let value = 0;
      if (kind === "patterned") {
        value = Math.floor(x / 10) % 2 === 0 ? 24 : 224;
      } else if (kind === "blank-hero" && outsideHeroScene) {
        value = 255;
      }
      png.data[offset] = value;
      png.data[offset + 1] = value;
      png.data[offset + 2] = value;
      png.data[offset + 3] = 255;
    }
  }
  return pngjs.PNG.sync.write(png);
}

function fakeScenarioPage(
  scenario,
  { onCapture, onObservation, onMouseMove, screenshot = screenshotPng() } = {}
) {
  const state = {
    closed: false,
    observation: healthyObservation(scenario),
    observationCount: 0,
  };
  let emit = () => {};
  return {
    state,
    page: {
      async send(method, params = {}) {
        if (method === "Runtime.evaluate") {
          if (state.closed) throw new Error("cannot inspect a closed page");
          const value =
            params.expression === "location.href"
              ? state.observation.url
              : (() => {
                  state.observationCount += 1;
                  onObservation?.(state);
                  return structuredClone(state.observation);
                })();
          return { result: { value } };
        }
        if (method === "Input.dispatchMouseEvent") {
          onMouseMove?.({ state, params });
        }
        if (method === "Page.captureScreenshot") {
          onCapture?.({ emit, state });
          return { data: screenshot.toString("base64") };
        }
        return {};
      },
      onEvent(handler) {
        emit = handler;
      },
      async close() {
        state.closed = true;
      },
    },
  };
}

test("a patterned screenshot passes with continued GPU activity and reports pixel stats", async () => {
  const scenario = SCENARIOS[2];
  const fake = fakeScenarioPage(scenario, {
    onObservation(state) {
      if (state.observationCount === 2) {
        state.observation.smoke.submissions += 1;
        state.observation.smoke.canvases[0].currentTextures += 1;
      }
    },
  });
  const artifactDir = await mkdtemp(join(tmpdir(), "vgpu-browser-smoke-"));
  try {
    const result = await browserSmoke.runScenario(
      "https://example.test",
      artifactDir,
      scenario,
      { launch: async () => fake.page, settle: async () => {} }
    );
    assert.equal(result.ok, true);
    assert.equal(result.screenshotStats.uniform, false);
    assert.ok(result.screenshotStats.lumaStdDev > 2);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("a black screenshot fails despite continued GPU activity", async () => {
  const scenario = SCENARIOS[2];
  const fake = fakeScenarioPage(scenario, {
    screenshot: screenshotPng("black"),
    onObservation(state) {
      if (state.observationCount === 2) {
        state.observation.smoke.submissions += 1;
        state.observation.smoke.canvases[0].currentTextures += 1;
      }
    },
  });
  const artifactDir = await mkdtemp(join(tmpdir(), "vgpu-browser-smoke-"));
  try {
    const result = await browserSmoke.runScenario(
      "https://example.test",
      artifactDir,
      scenario,
      { launch: async () => fake.page, settle: async () => {} }
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.screenshotStats, {
      meanLuma: 0,
      lumaStdDev: 0,
      uniform: true,
      sampledRegion: {
        normalized: { x: 0.1, y: 0.1, width: 0.8, height: 0.7 },
        pixels: { x: 10, y: 10, width: 80, height: 70 },
      },
    });
    assert.match(
      result.failures.join("\n"),
      /uniform screenshot.*mean luma 0.*luma standard deviation 0/u
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("foreground outside a blank hero scene cannot satisfy the pixel oracle", async () => {
  const scenario = SCENARIOS[0];
  const fake = fakeScenarioPage(scenario, {
    screenshot: screenshotPng("blank-hero"),
    onObservation(state) {
      if (state.observationCount === 2) {
        state.observation.smoke.submissions += 1;
        state.observation.smoke.canvases[0].currentTextures += 1;
      }
    },
  });
  const artifactDir = await mkdtemp(join(tmpdir(), "vgpu-browser-smoke-"));
  try {
    const result = await browserSmoke.runScenario(
      "https://example.test",
      artifactDir,
      scenario,
      { launch: async () => fake.page, settle: async () => {} }
    );
    assert.equal(result.ok, false);
    assert.equal(result.screenshotStats.uniform, true);
    assert.deepEqual(result.screenshotStats.sampledRegion, {
      normalized: { x: 0.6, y: 0.2, width: 0.35, height: 0.6 },
      pixels: { x: 60, y: 20, width: 35, height: 60 },
    });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("synthetic flags secret has the required 32 decoded bytes", () => {
  assert.equal(Buffer.from(SYNTHETIC_FLAGS_SECRET, "base64").byteLength, 32);
  assert.doesNotThrow(() => new Function(browserInstrumentation("dark")));
});

test("default browser smoke requires every production scenario", () => {
  const options = parseArgs(["--"]);
  assert.equal(options.scenario, null);
  assert.deepEqual(
    SCENARIOS.map(({ id }) => id),
    ["hero-dark", "hero-light", "particle-orbit"]
  );
  assert.throws(() => parseArgs(["--scenario=unknown"]), /unknown scenario/u);
  assert.throws(
    () => parseArgs(["--base-url=https://user:password@example.test"]),
    /must not contain credentials/u
  );
});

test("healthy texture acquisition counts pass while analytics console noise is ignored", () => {
  const scenario = SCENARIOS[0];
  const observation = healthyObservation(scenario);
  observation.consoleErrors.push(
    "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT https://va.vercel-scripts.com/v1/speed-insights/script.js"
  );
  assert.deepEqual(scenarioFailures(scenario, observation), []);
  assert.equal(isRenderingConsoleError(observation.consoleErrors[0]), false);
});

test("chromeless Particle Orbit does not need a document theme marker", () => {
  const scenario = SCENARIOS[2];
  const observation = healthyObservation(scenario);
  observation.theme = "normal";
  assert.deepEqual(scenarioFailures(scenario, observation), []);
});

test("caught v1 shader errors fail even without an uncaught page exception", () => {
  const scenario = SCENARIOS[0];
  const observation = healthyObservation(scenario);
  observation.consoleErrors.push(
    "Prism background failed to render. VGPU-SHADER-SOURCE-UNPREPARED: received raw WGSL or a v1 artifact"
  );
  assert.match(
    scenarioFailures(scenario, observation).join("\n"),
    /render console error.*VGPU-SHADER-SOURCE-UNPREPARED/u
  );
});

test("missing WebGPU, validation errors, and single-acquisition output cannot pass", () => {
  const scenario = SCENARIOS[2];
  const observation = healthyObservation(scenario);
  observation.smoke.webgpu = false;
  observation.smoke.gpuErrors.push("captured: incompatible bind group layout");
  observation.smoke.submissions = 1;
  observation.smoke.canvases[0].currentTextures = 1;
  const failures = scenarioFailures(scenario, observation).join("\n");
  assert.match(failures, /WebGPU is unavailable/u);
  assert.match(failures, /GPU validation/u);
  assert.match(failures, /only 1 GPU queue submissions/u);
  assert.match(failures, /recorded only 1 texture acquisitions/u);
});

test("the preview error boundary remains a fatal rendering signal", () => {
  const scenario = SCENARIOS[2];
  const observation = healthyObservation(scenario);
  observation.previewError = "Preview error\nVGPU-SHADER-SOURCE-UNPREPARED";
  assert.match(
    scenarioFailures(scenario, observation).join("\n"),
    /preview error UI/u
  );
});

test("errors emitted during screenshot capture fail the scenario before close", async () => {
  const scenario = SCENARIOS[0];
  const fake = fakeScenarioPage(scenario, {
    onObservation(state) {
      if (state.observationCount === 2) {
        state.observation.smoke.submissions += 1;
        state.observation.smoke.canvases[0].currentTextures += 1;
      }
    },
    onCapture({ emit, state }) {
      emit({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [
            {
              value:
                "Prism background failed to render: VGPU-SHADER-SOURCE-UNPREPARED",
            },
          ],
        },
      });
      state.observation.smoke.gpuErrors.push("captured: invalid shader module");
    },
  });
  const artifactDir = await mkdtemp(join(tmpdir(), "vgpu-browser-smoke-"));
  try {
    const result = await browserSmoke.runScenario(
      "https://example.test",
      artifactDir,
      scenario,
      { launch: async () => fake.page, settle: async () => {} }
    );
    assert.equal(result.ok, false);
    assert.match(
      result.failures.join("\n"),
      /render console error.*VGPU-SHADER-SOURCE-UNPREPARED/u
    );
    assert.match(
      result.failures.join("\n"),
      /GPU validation.*invalid shader module/u
    );
    assert.equal(fake.state.closed, true);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("server readiness aborts and cleans up a stalled response at its deadline", async () => {
  let activeRequests = 0;
  let aborted = false;
  const stalledFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      activeRequests += 1;
      const guard = setTimeout(() => {
        activeRequests -= 1;
        reject(new Error("readiness did not abort the stalled response"));
      }, 1000);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(guard);
          aborted = true;
          activeRequests -= 1;
          reject(signal.reason);
        },
        { once: true }
      );
    });
  const startedAt = Date.now();
  await assert.rejects(
    browserSmoke.waitForServer(
      "http://127.0.0.1:1",
      { exitCode: null, signalCode: null },
      { fetchImpl: stalledFetch, timeoutMs: 40 }
    ),
    /did not become ready within 40 ms/u
  );
  assert.equal(aborted, true);
  assert.equal(activeRequests, 0);
  assert.ok(Date.now() - startedAt < 1000);
});

test("a renderer stalled after its initial output fails the settle check", async () => {
  const scenario = SCENARIOS[2];
  const fake = fakeScenarioPage(scenario);
  const artifactDir = await mkdtemp(join(tmpdir(), "vgpu-browser-smoke-"));
  try {
    const result = await browserSmoke.runScenario(
      "https://example.test",
      artifactDir,
      scenario,
      { launch: async () => fake.page, settle: async () => {} }
    );
    assert.equal(result.ok, false);
    assert.match(
      result.failures.join("\n"),
      /queue submissions did not increase/u
    );
    assert.match(
      result.failures.join("\n"),
      /texture acquisitions did not increase/u
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});


test("an idle light hero must render again in response to real pointer input", async () => {
  const scenario = SCENARIOS[1];
  const inputs = [];
  const fake = fakeScenarioPage(scenario, {
    onMouseMove({ state, params }) {
      assert.ok(state.observationCount >= 1, "input must follow the initial rendering observation");
      inputs.push(params);
      state.observation.smoke.submissions += 1;
      state.observation.smoke.canvases[0].currentTextures += 1;
    },
  });
  const artifactDir = await mkdtemp(join(tmpdir(), "vgpu-browser-smoke-"));
  try {
    const result = await browserSmoke.runScenario("https://example.test", artifactDir, scenario, {
      launch: async () => fake.page, settle: async () => {},
    });
    assert.equal(result.ok, true);
    assert.ok(inputs.some((input) => input.type === "mouseMoved"));
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("a light hero that ignores pointer input still fails the activity check", async () => {
  const scenario = SCENARIOS[1];
  const fake = fakeScenarioPage(scenario);
  const artifactDir = await mkdtemp(join(tmpdir(), "vgpu-browser-smoke-"));
  try {
    const result = await browserSmoke.runScenario("https://example.test", artifactDir, scenario, {
      launch: async () => fake.page, settle: async () => {},
    });
    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /texture acquisitions did not increase/u);
    assert.match(result.failures.join("\n"), /queue submissions did not increase/u);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
