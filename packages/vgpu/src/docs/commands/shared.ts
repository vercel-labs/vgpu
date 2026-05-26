import type { CommandResult, DocsRecord } from "../model.ts";

export function ok(lines: string[] | string = ""): CommandResult {
  const stdout = Array.isArray(lines) ? lines.join("\n") : lines;
  return { code: 0, stdout: stdout.length > 0 ? `${stdout}\n` : "" };
}

export function fail(message: string): CommandResult {
  return { code: 1, stderr: `${message}\n` };
}

export function ambiguous(symbol: string, records: DocsRecord[]): CommandResult {
  const candidates = records.map((record) => `${record.symbol}\t${record.package}\t${record.virtualPath}`);
  return fail(`Ambiguous symbol: ${symbol}\nCandidates:\n${candidates.join("\n")}`);
}

export function normalizePath(path: string): string {
  if (path === "/") return path;
  return path.endsWith("/") ? path.slice(0, -1) : path;
}
