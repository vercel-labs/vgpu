import { resolvePath, resolveSymbol } from "../index.js";

export function resolveDocsTarget(index, target) {
  for (const path of candidatePaths(target)) {
    const record = resolvePath(index, path)[0];
    if (record) return { resolved: record };
  }

  for (const symbol of candidateSymbols(target)) {
    const resolved = resolveSymbol(index, symbol);
    if (resolved) return { resolved };
  }

  return { resolved: undefined, lookup: target.startsWith("/") || target.startsWith("guides/") ? "path" : "symbol" };
}

function candidatePaths(target) {
  const paths = [];
  if (target.startsWith("/")) paths.push(target);
  if (target.startsWith("guides/")) paths.push(`/${target}`);

  for (const path of [...paths]) {
    if (path.startsWith("/guides/") && path.endsWith(".md") && !path.endsWith(".docs.md")) {
      paths.push(path.replace(/\.md$/u, ".docs.md"));
    }
  }

  return unique(paths);
}

function candidateSymbols(target) {
  const symbols = [target];
  const file = target.split("/").at(-1) ?? target;
  if (file.endsWith(".docs.md")) symbols.push(file.slice(0, -".docs.md".length));
  if (file.endsWith(".md")) symbols.push(file.slice(0, -".md".length));
  return unique(symbols);
}

function unique(values) {
  return [...new Set(values)];
}
