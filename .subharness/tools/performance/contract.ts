import { z } from "zod";

const text = z.string().trim().min(1);
export const modeSchema = z.enum(["cpu", "gpu"]);
export const settingsSchema = z.object({
  width: z.number().int().min(16).max(4096),
  height: z.number().int().min(16).max(4096),
  dpr: z.number().min(0.5).max(3),
  camera: text,
  quality: text,
  seed: z.number().int(),
  dt: z.number().min(0).max(1),
  variant: text,
}).strict();
export const caseSchema = z.object({
  id: text,
  url: z.string().url().refine((url) => ["http:", "https:"].includes(new URL(url).protocol), "Use an HTTP(S) scene URL"),
  source: text,
  build: text,
  settings: settingsSchema,
  // The value describes the exact instrumented scope, not an availability guess.
  capabilities: z.object({ cpu: text.optional(), gpu: text.optional() }).strict(),
}).strict();
export const budgetSchema = z.object({
  mode: modeSchema,
  warmup: z.number().int().min(0).max(12).default(4),
  samples: z.number().int().min(1).max(240).default(24),
  hz: z.number().min(1).max(60).default(15),
  timeoutMs: z.number().int().min(1000).max(60_000).default(60_000),
}).strict();
export const planSchema = z.object({ case: caseSchema, budget: budgetSchema }).strict();
export type Plan = z.infer<typeof planSchema>;
export function planCase(scene: unknown, budget: unknown): Plan {
  const plan = planSchema.parse({ case: scene, budget });
  if (!plan.case.capabilities[plan.budget.mode]) throw new Error(`${plan.budget.mode} timing unavailable: case does not declare that capability`);
  if ((plan.budget.warmup + plan.budget.samples - 1) * 1000 / plan.budget.hz >= plan.budget.timeoutMs) {
    throw new Error("Cadence alone exhausts the deadline; reduce samples or increase the budget");
  }
  return plan;
}

export const metadataSchema = z.object({
  source: text, build: text,
  settings: settingsSchema,
  scope: text,
  method: z.enum(["cpu-scopes", "gpu-timestamps"]),
  device: text,
  backend: z.enum(["hardware", "software", "synthetic", "unknown"]),
  runtime: text,
  buildMode: z.enum(["production", "development", "test"]),
}).strict();
export const sampleSchema = z.object({ valueMs: z.number().finite().nonnegative() }).strict();
export const reportSchema = z.object({
  schemaVersion: z.literal(1),
  id: text,
  startedAt: text,
  runnerRevision: text,
  plan: planSchema,
  status: z.enum(["complete", "failed"]),
  cleanup: z.boolean(),
  metadata: metadataSchema.optional(),
  samples: z.array(sampleSchema),
  error: text.optional(),
}).strict();
export type Report = z.infer<typeof reportSchema>;

export function same(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export function verifyMetadata(plan: Plan, input: unknown) {
  const metadata = metadataSchema.parse(input);
  if (metadata.source !== plan.case.source || metadata.build !== plan.case.build || !same(metadata.settings, plan.case.settings)) {
    throw new Error("Served source/build/settings do not match the plan");
  }
  if (metadata.scope !== plan.case.capabilities[plan.budget.mode] || metadata.method !== (plan.budget.mode === "cpu" ? "cpu-scopes" : "gpu-timestamps")) {
    throw new Error("Adapter measurement scope/method does not match the requested mode");
  }
  return metadata;
}

export function distribution(values: number[]) {
  if (!values.length) throw new Error("No measured samples");
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), min: sorted[0], max: sorted[sorted.length - 1] };
}

/** Compare run medians, never pool all frames and hide between-run variation. */
export function compareReports(baselineInput: unknown[], candidateInput: unknown[], allowSourceChange = false) {
  if (!baselineInput.length || !candidateInput.length) throw new Error("Both sides need reports");
  const baseline = baselineInput.map((input) => reportSchema.parse(input));
  const candidate = candidateInput.map((input) => reportSchema.parse(input));
  const all = [...baseline, ...candidate];
  if (new Set(all.map((report) => report.id)).size !== all.length) throw new Error("Duplicate run identities");
  for (const report of all) {
    planCase(report.plan.case, report.plan.budget);
    if (report.status !== "complete" || !report.cleanup || report.error || report.samples.length !== report.plan.budget.samples || !report.metadata) {
      throw new Error("Cannot compare failed, partial, missing or unclean measurements");
    }
    verifyMetadata(report.plan, report.metadata);
  }
  const common = (report: Report) => {
    const { variant: _variant, ...settings } = report.plan.case.settings;
    const { source: _source, build: _build, settings: _settings, ...metadata } = report.metadata!;
    return { caseId: report.plan.case.id, budget: report.plan.budget, settings, metadata, runnerRevision: report.runnerRevision };
  };
  for (const report of all) if (!same(common(report), common(all[0]))) throw new Error("Incompatible case, settings, scope, hardware/runtime or runner");
  for (const side of [baseline, candidate]) {
    const identity = (report: Report) => ({ source: report.plan.case.source, build: report.plan.case.build, variant: report.plan.case.settings.variant });
    for (const report of side) if (!same(identity(report), identity(side[0]))) throw new Error("Each side must retain one source/build/variant");
  }
  if (!allowSourceChange && (baseline[0].plan.case.source !== candidate[0].plan.case.source || baseline[0].plan.case.build !== candidate[0].plan.case.build)) {
    throw new Error("Source/build changed: explicitly enable allowSourceChange for a reviewed implementation comparison");
  }
  const summarize = (reports: Report[]) => distribution(reports.map((report) => distribution(report.samples.map((sample) => sample.valueMs)).p50));
  const a = summarize(baseline), b = summarize(candidate);
  return {
    metric: all[0].metadata!.scope, unit: "ms", baseline: a, candidate: b,
    deltaMs: b.p50 - a.p50,
    deltaPercent: a.p50 === 0 ? null : (b.p50 - a.p50) / a.p50 * 100,
    warnings: [
      "Spread describes repeat variation, not statistical significance. Paced slices do not establish full-application FPS.",
      ...(Math.min(baseline.length, candidate.length) < 2 ? ["Exploratory: fewer than two independent blocks per side."] : []),
      ...(all.some((report) => report.samples.length < 100) ? ["Short sample sets: p95 is not a stable production tail estimate."] : []),
      ...(all[0].metadata!.backend !== "hardware" || all[0].metadata!.buildMode !== "production" ? ["Not a production hardware benchmark."] : []),
    ],
  };
}
