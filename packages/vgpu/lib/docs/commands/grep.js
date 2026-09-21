import { uniqueByPath } from "../index.js";
import { fail, ok } from "./shared.js";

export function grepCommand(index, args) {
  if (args.includes("--help") || args.includes("-h")) return ok("Usage: vgpu docs grep [-i] [--package <pkg>] <pattern>");
  const parsed = parseArgs(args);
  if (typeof parsed === "string") return fail(parsed);
  const matches = grepDocs(index, parsed);
  return matches.length > 0 ? ok(matches.map(formatGrepMatch)) : fail(`No matches for: ${parsed.pattern}`);
}

export function grepDocs(index, { pattern, ignoreCase = false, packageName }) {
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const matches = [];
  for (const record of uniqueByPath(index.records)) {
    if (packageName && !matchesPackage(record.package, packageName)) continue;
    record.content.split("\n").forEach((line, lineIndex) => {
      const haystack = ignoreCase ? line.toLowerCase() : line;
      if (haystack.includes(needle)) matches.push({ virtualPath: record.virtualPath, line: lineIndex + 1, text: line });
    });
  }
  return matches.sort((left, right) => compareBytes(formatGrepMatch(left), formatGrepMatch(right)));
}

function formatGrepMatch(match) {
  return `${match.virtualPath}:${match.line}:${match.text}`;
}

function compareBytes(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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
