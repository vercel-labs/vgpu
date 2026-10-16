import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { compareReports, planCase, verifyMetadata, type Plan, type Report } from "../.subharness/tools/performance/contract.ts";
import { acquireLease } from "../.subharness/tools/performance/lease.ts";
import { runCase } from "../.subharness/tools/performance/runner.ts";
import { ChromeCleanupError, type ChromePage } from "../.subharness/tools/preview/chrome.ts";
import { perfInitScript } from "../.subharness/tools/preview/page-scripts.ts";
import { runSteps } from "../.subharness/tools/preview/steps.ts";

const scene = {
  id: "chair", url: "http://localhost:3000/chair", source: "sha-a", build: "build-a",
  settings: { width: 64, height: 64, dpr: 1, camera: "fixed", quality: "high", seed: 7, dt: 0, variant: "a" },
  capabilities: { cpu: "update/encode", gpu: "color timestamp interval" },
};
function plan(mode: "cpu" | "gpu" = "cpu") { return planCase(scene, { mode, warmup: 1, samples: 2, hz: 60, timeoutMs: 1000 }); }
function metadata(p = plan()) { return { source: p.case.source, build: p.case.build, settings: p.case.settings, scope: p.case.capabilities[p.budget.mode]!, method: p.budget.mode === "cpu" ? "cpu-scopes" as const : "gpu-timestamps" as const, device: "test-device", backend: "synthetic" as const, runtime: "test-runtime", buildMode: "test" as const }; }
function report(id: string, values = [4, 6]): Report { const p = plan(); return { schemaVersion: 1, id, startedAt: "2026-10-16", runnerRevision: "runner-a", plan: p, status: "complete", cleanup: true, metadata: metadata(p), samples: values.map((valueMs) => ({ valueMs })) }; }
const directories: string[] = [];
async function scratch() { const dir = await mkdtemp(path.join(tmpdir(), "vgpu-perf-test-")); directories.push(dir); return dir; }
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("performance plans and comparisons", () => {
  it("rejects unsupported modes and impossible budgets before execution", () => {
    expect(() => planCase({ ...scene, capabilities: { cpu: "update/encode" } }, { mode: "gpu" })).toThrow(/unavailable/);
    expect(() => planCase(scene, { mode: "cpu", samples: 240, hz: 1, timeoutMs: 1000 })).toThrow(/deadline/);
    expect(() => planCase(scene, { mode: "cpu", samples: -1 })).toThrow();
  });
  it("verifies actual source, settings and instrumentation method", () => {
    expect(() => verifyMetadata(plan(), { ...metadata(), source: "stale" })).toThrow(/Served/);
    expect(() => verifyMetadata(plan(), { ...metadata(), settings: { ...scene.settings, width: 128 } })).toThrow(/Served/);
    expect(() => verifyMetadata(plan(), { ...metadata(), method: "gpu-timestamps" })).toThrow(/method/);
  });
  it("compares block medians and preserves variation", () => {
    const result = compareReports([report("a1", [4, 5]), report("a2", [6, 7])], [report("b1", [2, 3]), report("b2", [3, 4])]);
    expect(result.baseline).toMatchObject({ p50: 4, min: 4, max: 6 });
    expect(result.deltaMs).toBe(-2);
    expect(result.warnings.join(" ")).toMatch(/Not a production hardware/);
  });
  it("rejects duplicates, missing samples and cleanup failures", () => {
    expect(() => compareReports([report("a")], [report("a")])).toThrow(/Duplicate/);
    expect(() => compareReports([report("a")], [report("b", [1])])).toThrow(/partial/);
    expect(() => compareReports([report("a")], [{ ...report("b"), cleanup: false }])).toThrow(/unclean/);
    expect(() => compareReports([report("a")], [report("b", [NaN, 1])])).toThrow();
  });
  it("allows an explicit source comparison but never bypasses hardware/settings checks", () => {
    const b = report("b"); b.plan.case.source = "sha-b"; b.metadata!.source = "sha-b";
    expect(() => compareReports([report("a")], [b])).toThrow(/allowSourceChange/);
    expect(compareReports([report("a")], [b], true).deltaMs).toBe(0);
    b.metadata!.device = "another-device";
    expect(() => compareReports([report("a")], [b], true)).toThrow(/Incompatible/);
  });
});

describe("lease and bounded browser lifecycle", () => {
  it("does not steal a lease and releases its own lease", async () => {
    const lease = path.join(await scratch(), "lease");
    const release = await acquireLease(lease);
    await expect(acquireLease(lease)).rejects.toThrow(/occupied/);
    await release(); await (await acquireLease(lease))();
  });
  function browser(p: Plan, failSample = false, hangSample = false, failClose = false) {
    let samples = 0;
    const expressions: string[] = [];
    const page: ChromePage = {
      async send(method, params) {
        if (method !== "Runtime.evaluate") return { product: "test-browser", revision: "1" };
        const expression = String(params?.expression); expressions.push(expression);
        if (expression.startsWith("Boolean")) return { result: { value: true } };
        if (expression.includes(".prepare(")) return { result: { value: metadata(p) } };
        if (expression.includes(".sample(")) {
          samples++;
          if (hangSample) return new Promise(() => {});
          if (failSample) throw new Error("device lost");
          return { result: { value: { valueMs: samples } } };
        }
        return { result: { value: null } };
      },
      onEvent() {}, close: vi.fn(async () => { if (failClose) throw new Error("browser still alive"); }),
    };
    return { page, expressions, count: () => samples };
  }
  it("samples finite deterministic frames, omits warmup, disposes and closes", async () => {
    const dir = await scratch(); const p = plan(); const b = browser(p);
    const result = await runCase(p, { outRoot: dir, leaseDirectory: path.join(dir, "lease"), launch: async () => b.page, runnerRevision: "test" });
    expect(result.status).toBe("complete"); expect(b.count()).toBe(3);
    const raw = JSON.parse(await readFile(result.reportPath, "utf8"));
    expect(raw.samples).toEqual([{ valueMs: 2 }, { valueMs: 3 }]);
    expect(b.expressions.filter((e) => e.includes(".sample(")).every((e) => e.includes('"dt":0'))).toBe(true);
    expect(b.expressions.at(-1)).toContain(".dispose()"); expect(b.page.close).toHaveBeenCalledOnce();
    await expect(stat(path.join(dir, "lease"))).rejects.toThrow();
  });
  it("retains failed/partial evidence and stops after device loss", async () => {
    const dir = await scratch(); const p = plan("gpu"); const b = browser(p, true);
    const result = await runCase(p, { outRoot: dir, leaseDirectory: path.join(dir, "lease"), launch: async () => b.page, runnerRevision: "test" });
    expect(result).toMatchObject({ status: "failed", cleanup: true, error: "device lost" });
    expect(b.count()).toBe(1); expect(b.page.close).toHaveBeenCalledOnce();
  });
  it("closes an owned browser on timeout", async () => {
    const dir = await scratch(); const p = plan(); const b = browser(p, false, true);
    const result = await runCase(p, { outRoot: dir, leaseDirectory: path.join(dir, "lease"), launch: async () => b.page, runnerRevision: "test" });
    expect(result).toMatchObject({ status: "failed", cleanup: true });
    expect(result.error).toMatch(/deadline/); expect(b.page.close).toHaveBeenCalledOnce();
  });
  it("retains the lease when host cleanup cannot establish browser exit", async () => {
    const dir = await scratch(); const p = plan(); const b = browser(p, false, false, true);
    const result = await runCase(p, { outRoot: dir, leaseDirectory: path.join(dir, "lease"), launch: async () => b.page, runnerRevision: "test" });
    expect(result).toMatchObject({ status: "failed", cleanup: false });
    expect(result.error).toMatch(/lease retained/); expect((await stat(path.join(dir, "lease"))).isDirectory()).toBe(true);
  });
  it("does not release a lease after a failed startup leaves an unknown browser", async () => {
    const dir = await scratch();
    const result = await runCase(plan(), { outRoot: dir, leaseDirectory: path.join(dir, "lease"), launch: async () => { throw new ChromeCleanupError("still alive"); }, runnerRevision: "test" });
    expect(result).toMatchObject({ status: "failed", cleanup: false });
    expect((await stat(path.join(dir, "lease"))).isDirectory()).toBe(true);
  });
});

it("late queue callbacks cannot contaminate the following preview window", async () => {
  vi.useFakeTimers();
  let now = 0;
  const raf: Array<(time: number) => void> = [];
  const completions: Array<() => void> = [];
  class GPUQueue { submit() {} onSubmittedWorkDone() { return new Promise<void>((resolve) => completions.push(resolve)); } }
  const context = vm.createContext({ performance: { now: () => now }, GPUQueue, setTimeout, requestAnimationFrame: (cb: (time: number) => void) => raf.push(cb) });
  context.window = context;
  vm.runInContext(perfInitScript, context);
  const first = context.__capturePerf.measure(10);
  new context.GPUQueue().submit([]);
  now = 16; raf.shift()!(now); await Promise.resolve(); await vi.advanceTimersByTimeAsync(150);
  expect(await first).toMatchObject({ queueCompletionPending: 1, queueCompletionSamples: 0 });
  const second = context.__capturePerf.measure(10);
  completions[0](); await Promise.resolve();
  new context.GPUQueue().submit([]); completions[1](); await Promise.resolve();
  now = 32; raf.shift()!(now); await Promise.resolve(); await vi.advanceTimersByTimeAsync(150);
  const result = await second;
  expect(result).toMatchObject({ schemaVersion: 2, queueCompletionPending: 0, queueCompletionSamples: 1 });
  expect(result.gpuSubmitToDoneMs).toBeUndefined();
});

it("keeps incomplete preview windows out of the queue-latency aggregate", async () => {
  const windows = [{}, { queueCompletionMs: { p95: 20 }, queueCompletionPending: 0 }, { queueCompletionMs: { p95: 1 }, queueCompletionPending: 2 }];
  const page: ChromePage = { send: async () => ({ result: { value: windows.shift() } }), onEvent() {}, async close() {} };
  const result = await runSteps({ page, outDir: await scratch(), viewport: { width: 64, height: 64, dpr: 1, touch: false } }, [{ type: "perf", ms: 250, runs: 2 }]);
  expect(result.perf[0]).toMatchObject({ queueCompletionP95MedianMs: 20, queueCompletionP95PerRunMs: [20, null] });
});
