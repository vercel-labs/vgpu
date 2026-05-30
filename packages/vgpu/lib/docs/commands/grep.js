import { uniqueByPath } from "../index.js";
import { fail, ok } from "./shared.js";

export function grepCommand(index, args) {
  if (args.includes("--help") || args.includes("-h")) return ok("Usage: vgpu docs grep [-i] [--package <pkg>] <pattern>");
  const parsed = parseArgs(args);
  if (typeof parsed === "string") return fail(parsed);
  const needle = parsed.ignoreCase ? parsed.pattern.toLowerCase() : parsed.pattern;
  const lines = [];
  for (const record of uniqueByPath(index.records)) {
    if (parsed.packageName && !matchesPackage(record.package, parsed.packageName)) continue;
    record.content.split("\n").forEach((line, lineIndex) => {
      const haystack = parsed.ignoreCase ? line.toLowerCase() : line;
      if (haystack.includes(needle)) lines.push(`${record.virtualPath}:${lineIndex + 1}:${line}`);
    });
  }
  return lines.length > 0 ? ok(lines.sort()) : fail(`No matches for: ${parsed.pattern}`);
}

function parseArgs(args) {
  let ignoreCase = false;
  let packageName;
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-i") ignoreCase = true;
    else if (args[index] === "--package") packageName = args[++index];
    else rest.push(args[index]);
  }
  if (args.includes("--package") && !packageName) return "Missing value for --package";
  if (rest.length !== 1) return "Usage: vgpu docs grep [-i] [--package <pkg>] <pattern>";
  return { ignoreCase, packageName, pattern: rest[0] };
}

function matchesPackage(recordPackage, filter) {
  return recordPackage === filter || recordPackage.startsWith(`${filter}/`);
}
