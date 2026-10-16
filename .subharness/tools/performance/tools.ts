import { readFile } from "node:fs/promises";
import { tool } from "subharness";
import { z } from "zod";
import { budgetSchema, caseSchema, compareReports, planCase } from "./contract.ts";
import { runCase } from "./runner.ts";

const caseInput = budgetSchema.extend({ caseFile: z.string().min(1) });
async function json(file: string): Promise<unknown> { return JSON.parse(await readFile(file, "utf8")); }
async function respond(action: () => Promise<unknown>) {
  try { return JSON.stringify(await action()); }
  catch (error) { return JSON.stringify({ status: "failed", error: String(error) }); }
}
export const performanceTools = {
  perf_cases: tool({
    description: "Inspect declared scene capabilities from JSON case files; no browser, imports or GPU work. Files follow the performance-measurement guide. An absent mode is unavailable.",
    inputSchema: z.object({ caseFiles: z.array(z.string().min(1)).min(1).max(20) }),
    execute: ({ caseFiles }) => respond(async () => Promise.all(caseFiles.map(async (file) => ({ file, case: caseSchema.parse(await json(file)) })))),
  }),
  perf_plan: tool({
    description: "Validate one case, requested CPU or GPU mode and finite budget without GPU work. Does not start a server or verify runtime capability; unsupported modes fail here.",
    inputSchema: caseInput,
    execute: ({ caseFile, ...budget }) => respond(async () => planCase(await json(caseFile), budget)),
  }),
  perf_run: tool({
    description: "Run one bounded browser case through its existing __vgpuPerf scene bridge, under a machine lease. CPU scopes and GPU timestamps use separate runs. Saves raw report in .context/performance. Does not build/start servers. Missing bridge/capability fails, never falls back to queue latency. Read performance-measurement.md first.",
    inputSchema: caseInput,
    execute: ({ caseFile, ...budget }) => respond(async () => runCase(planCase(await json(caseFile), budget))),
  }),
  perf_compare: tool({
    description: "Compare matched raw reports offline: median of block medians and repeat spread. Rejects duplicate, partial, failed, unclean or incompatible runs. Source changes require explicit allowSourceChange; does not claim FPS, utilization, significance or additive asset percentages.",
    inputSchema: z.object({
      baseline: z.array(z.string().min(1)).min(1).max(12),
      candidate: z.array(z.string().min(1)).min(1).max(12),
      allowSourceChange: z.boolean().default(false),
    }),
    execute: ({ baseline, candidate, allowSourceChange }) => respond(async () => compareReports(await Promise.all(baseline.map(json)), await Promise.all(candidate.map(json)), allowSourceChange)),
  }),
};
