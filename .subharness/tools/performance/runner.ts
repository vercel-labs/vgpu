import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChromeCleanupError, launchChrome, type ChromePage } from "../preview/chrome.ts";
import { acquireLease } from "./lease.ts";
import { distribution, planCase, sampleSchema, verifyMetadata, type Plan, type Report } from "./contract.ts";

// Subharness keeps loaded modules for a session. Later edits must not relabel old code as new.
const loadedRunnerIdentity = runnerIdentity();

export async function evaluate(page: ChromePage, expression: string) {
  const response = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const exception = response.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
  if (exception) throw new Error(exception.exception?.description ?? exception.text ?? "Scene adapter failed");
  return (response.result as { value?: unknown } | undefined)?.value;
}

function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      void promise.catch(() => {}); // The operation may already be in flight; cleanup still owns it.
      reject(new Error("Measurement deadline exceeded"));
      return;
    }
    const timer = setTimeout(() => reject(new Error("Measurement deadline exceeded")), Math.max(0, ms));
    promise.then((result) => { clearTimeout(timer); resolve(result); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The page bridge uses the real scene builder. This host never substitutes a renderer. */
export async function runCase(input: Plan, options: {
  outRoot?: string; leaseDirectory?: string; launch?: typeof launchChrome; runnerRevision?: string;
} = {}) {
  const plan = planCase(input.case, input.budget); // Fail unsupported requests before hardware.
  const revision = options.runnerRevision ?? loadedRunnerIdentity;
  const release = await acquireLease(options.leaseDirectory);
  const report: Report = {
    schemaVersion: 1, id: randomUUID(), startedAt: new Date().toISOString(),
    runnerRevision: revision, plan,
    status: "failed", cleanup: false, samples: [],
  };
  const out = path.resolve(options.outRoot ?? ".context/performance", report.id);
  let page: ChromePage | undefined;
  let opening: Promise<ChromePage> | undefined;
  let bridgePrepared = false;
  const ends = Date.now() + plan.budget.timeoutMs;
  const within = <T>(promise: Promise<T>) => deadline(promise, ends - Date.now());
  try {
    await mkdir(out, { recursive: true });
    const { width, height, dpr } = plan.case.settings;
    opening = (options.launch ?? launchChrome)({ width, height });
    page = await within(opening);
    const exceptions: string[] = [];
    page.onEvent((event) => {
      if (event.method === "Runtime.exceptionThrown") exceptions.push(JSON.stringify(event.params));
    });
    const browser = await within(page.send("Browser.getVersion"));
    await within(page.send("Page.enable"));
    await within(page.send("Runtime.enable"));
    await within(page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false }));
    const navigation = await within(page.send("Page.navigate", { url: plan.case.url }));
    if (navigation.errorText) throw new Error(String(navigation.errorText));
    while (!await within(evaluate(page, "Boolean(globalThis.__vgpuPerf?.prepare && globalThis.__vgpuPerf?.sample && globalThis.__vgpuPerf?.dispose)"))) await within(sleep(50));
    bridgePrepared = true; // dispose even when prepare fails partway through.
    report.metadata = verifyMetadata(plan, await within(evaluate(page, `globalThis.__vgpuPerf.prepare(${JSON.stringify(plan)})`)));
    report.metadata.runtime += `; browser=${String(browser.product)}; revision=${String(browser.revision)}`;
    const total = plan.budget.warmup + plan.budget.samples;
    for (let index = 0; index < total; index++) {
      const start = Date.now();
      const sample = sampleSchema.parse(await within(evaluate(page, `globalThis.__vgpuPerf.sample(${JSON.stringify({ index, dt: plan.case.settings.dt, mode: plan.budget.mode })})`)));
      if (exceptions.length) throw new Error(`Uncaught page exception: ${exceptions[0]}`);
      if (index >= plan.budget.warmup) report.samples.push(sample);
      if (index + 1 < total) await within(sleep(Math.max(0, 1000 / plan.budget.hz - (Date.now() - start))));
    }
    report.status = "complete";
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      // If startup exceeded the run budget, wait for its handle before releasing the lease.
      // launchChrome owns a bounded startup and kills Chrome on startup failure.
      if (!page && opening) page = await opening.catch((error) => {
        if (error instanceof ChromeCleanupError) throw error;
        return undefined;
      });
      if (page && bridgePrepared) {
        try { await deadline(evaluate(page, "globalThis.__vgpuPerf.dispose()"), 3000); }
        catch (error) { report.status = "failed"; report.error = [report.error, `Scene cleanup: ${String(error)}`].filter(Boolean).join("; "); }
      }
      if (page) await page.close();
      report.cleanup = true;
      await release();
    } catch (error) {
      report.status = "failed";
      report.error = [report.error, `Host cleanup failed; lease retained: ${String(error)}`].filter(Boolean).join("; ");
    }
  }
  await mkdir(out, { recursive: true });
  const reportPath = path.join(out, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  return { status: report.status, cleanup: report.cleanup, error: report.error, reportPath,
    scope: report.metadata?.scope, summary: report.samples.length ? distribution(report.samples.map((sample) => sample.valueMs)) : null };
}

function runnerIdentity() {
  const hash = createHash("sha256");
  for (const file of ["runner.ts", "contract.ts", "lease.ts", "../preview/chrome.ts"]) {
    hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  }
  // Include dirty source contents and host runtime; repeated unchanged local runs remain comparable.
  return `sha256:${hash.digest("hex")}:node-${process.version}`;
}
