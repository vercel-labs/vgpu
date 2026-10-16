import { readFile } from "node:fs/promises";
import { caseSchema, compareReports, planCase } from "./contract.ts";
import { runCase } from "./runner.ts";

// CLI and agent tools share validation/execution. Arguments are JSON files, not shell fragments.
const [command, inputFile] = process.argv.slice(2);
try {
  if (!inputFile || !["cases", "plan", "run", "compare"].includes(command)) {
    throw new Error("Usage: node --experimental-strip-types .subharness/tools/performance/cli.ts cases|plan|run|compare input.json (see performance-measurement.md)");
  }
  const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));
  const input = await read(inputFile);
  let result: unknown;
  if (command === "cases") result = caseSchema.parse(input);
  else if (command === "compare") result = compareReports(await Promise.all(input.baseline.map(read)), await Promise.all(input.candidate.map(read)), input.allowSourceChange === true);
  else {
    const plan = planCase(input.case, input.budget);
    result = command === "plan" ? plan : await runCase(plan);
    if (command === "run" && (result as { status: string }).status !== "complete") process.exitCode = 1;
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "failed", error: String(error) }));
  process.exitCode = 1;
}
