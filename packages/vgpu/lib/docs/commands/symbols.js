import { ok } from "./shared.js";

export function symbolsCommand(index, args) {
  if (args.includes("--help") || args.includes("-h")) return ok("Usage: vgpu docs symbols");
  if (args.length !== 0) return { code: 1, stderr: "Usage: vgpu docs symbols\n" };
  const lines = index.records.map((record) => `${record.symbol}\t${record.package}\t${record.virtualPath}`);
  return ok([...new Set(lines)].sort());
}
