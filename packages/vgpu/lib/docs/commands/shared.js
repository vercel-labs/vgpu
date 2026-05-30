export function ok(lines = "") {
  const stdout = Array.isArray(lines) ? lines.join("\n") : lines;
  return { code: 0, stdout: stdout.length > 0 ? `${stdout}\n` : "" };
}

export function fail(message) {
  return { code: 1, stderr: `${message}\n` };
}

export function ambiguous(symbol, records) {
  const candidates = records.map((record) => `${record.symbol}\t${record.package}\t${record.virtualPath}`);
  return fail(`Ambiguous symbol: ${symbol}\nCandidates:\n${candidates.join("\n")}`);
}
