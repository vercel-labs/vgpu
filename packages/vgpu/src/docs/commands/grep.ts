import { uniqueByPath } from "../index.ts";
import type { CommandResult, DocsIndex } from "../model.ts";
import { fail, ok } from "./shared.ts";

interface GrepOptions {
  packageName?: string;
  pattern: string;
}

export function grepCommand(index: DocsIndex, args: string[]): CommandResult {
  if (args.includes("--help")) return ok("Usage: vgpu docs grep [--package <pkg>] <pattern>");
  const parsed = parseArgs(args);
  if (typeof parsed === "string") return fail(parsed);
  const matches: string[] = [];
  const needle = parsed.pattern.toLowerCase();
  for (const record of uniqueByPath(index.records)) {
    if (parsed.packageName && !matchesPackage(record.package, parsed.packageName)) continue;
    record.content.split("\n").forEach((line, index) => {
      if (line.toLowerCase().includes(needle)) {
        matches.push(`${record.virtualPath}:${index + 1}:${line}`);
      }
    });
  }
  return matches.length > 0 ? ok(matches.sort()) : fail(`No matches for: ${parsed.pattern}`);
}

function matchesPackage(recordPackage: string, filter: string): boolean {
  return recordPackage === filter || recordPackage.startsWith(`${filter}/`);
}

function parseArgs(args: string[]): GrepOptions | string {
  let packageName: string | undefined;
  const rest = [...args];
  const packageIndex = rest.indexOf("--package");
  if (packageIndex >= 0) {
    packageName = rest[packageIndex + 1];
    if (!packageName) return "Missing value for --package";
    rest.splice(packageIndex, 2);
  }
  if (rest.length !== 1) return "Usage: vgpu docs grep [--package <pkg>] <pattern>";
  return { packageName, pattern: rest[0] };
}
