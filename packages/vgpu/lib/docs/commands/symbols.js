import { ok } from "./shared.js";

export function symbolsCommand(index, args) {
  if (args.includes("--help") || args.includes("-h")) return ok("Usage: vgpu docs symbols");
  if (args.length !== 0) return { code: 1, stderr: "Usage: vgpu docs symbols\n" };
  return ok(listDocSymbols(index).map(formatSymbol));
}

export function listDocSymbols(index) {
  const symbols = new Map();
  for (const record of index.records) {
    const symbol = { symbol: record.symbol, package: record.package, virtualPath: record.virtualPath };
    const line = formatSymbol(symbol);
    if (!symbols.has(line)) symbols.set(line, symbol);
  }
  return [...symbols.values()].sort((left, right) => compareBytes(formatSymbol(left), formatSymbol(right)));
}

function formatSymbol(symbol) {
  return `${symbol.symbol}\t${symbol.package}\t${symbol.virtualPath}`;
}

function compareBytes(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
